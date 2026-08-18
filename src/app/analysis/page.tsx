'use client';

import React, { ChangeEvent, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import {
  analyzePatternCanvas,
  annotatePatternResultForPalette,
  detectGridFromCanvas,
  DetectedGrid,
  getPaletteComplianceIssues,
  GridBounds,
  paletteColorFromHex,
  PatternAnalysisResult,
  remapPatternResultToPalette,
  updateAnalyzedColorGroups,
  updateAnalyzedCellColor,
} from '../../utils/patternAnalysis';
import { PaletteColor } from '../../utils/pixelation';

type AnalysisTab = 'parse' | 'optimize' | 'edit';
type ParseStep = 'empty' | 'crop' | 'grid';
type BoundaryHandle =
  | 'topLeft'
  | 'top'
  | 'topRight'
  | 'right'
  | 'bottomRight'
  | 'bottom'
  | 'bottomLeft'
  | 'left'
  | 'move';
type BoundaryDragMode = BoundaryHandle | 'draw';
type AdjustMode = 'auto' | 'manual';
type AdjustTarget = 'grid' | 'canvas';
type DisplayOverlayMode = 'crop' | 'grid';
type NudgeDirection = 'up' | 'down' | 'left' | 'right';

const BOUNDARY_HANDLE_LABELS: Record<BoundaryHandle, string> = {
  topLeft: '左上',
  top: '上边',
  topRight: '右上',
  right: '右边',
  bottomRight: '右下',
  bottom: '下边',
  bottomLeft: '左下',
  left: '左边',
  move: '移动',
};

const RESIZE_BOUNDARY_HANDLES: Exclude<BoundaryHandle, 'move'>[] = [
  'topLeft',
  'top',
  'topRight',
  'right',
  'bottomRight',
  'bottom',
  'bottomLeft',
  'left',
];

const ADJUST_TARGET_LABELS: Record<AdjustTarget, string> = {
  grid: '网格',
  canvas: '画布',
};

const NUDGE_DIRECTIONS: Array<{ direction: NudgeDirection; label: string }> = [
  { direction: 'up', label: '上' },
  { direction: 'down', label: '下' },
  { direction: 'left', label: '左' },
  { direction: 'right', label: '右' },
];

interface DisplayAdjustOptions {
  isAdjusting: boolean;
  activeHandle: BoundaryHandle | null;
  activeTarget: AdjustTarget;
}

interface BoundaryDragState {
  mode: BoundaryDragMode;
  target: AdjustTarget;
  startPoint: { x: number; y: number };
  startBounds: GridBounds | null;
}

interface RedrawDisplayOptions {
  overlayMode?: DisplayOverlayMode;
  nextGridBounds?: GridBounds | null;
  nextCropBounds?: GridBounds | null;
  nextDetectedGrid?: DetectedGrid | null;
  nextCols?: number;
  nextRows?: number;
  adjustOptions?: DisplayAdjustOptions;
}

interface CropWorkingCanvasResult {
  bounds: GridBounds;
  dataUrl: string;
}

interface ColorCountItem {
  hex: string;
  count: number;
  color: string;
  colorKey: string;
  isExtraColor?: boolean;
  recommendedColor?: string;
  recommendedColorKey?: string;
  groupLabel: string;
  pendingCount: number;
  changedCount: number;
}

interface ColorCountGroup {
  label: string;
  totalCount: number;
  colors: ColorCountItem[];
}

interface PaletteApiResponse {
  brand: 'MARD';
  paletteName: string;
  colors: Array<{ key: string; hex: string }>;
}

interface SaveResponse {
  ok: boolean;
  id?: string;
  fileName?: string;
  path?: string;
  originalImagePath?: string;
  error?: string;
}

const MAX_CANVAS_SIDE = 1800;

export default function PatternAnalysisPage() {
  const sourceCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const displayCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const previewViewportRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const hasConfirmedPaletteRemapRef = useRef(false);

  const [activeTab, setActiveTab] = useState<AnalysisTab>('parse');
  const [parseStep, setParseStep] = useState<ParseStep>('empty');
  const [imageSrc, setImageSrc] = useState<string | null>(null);
  const [originalFileName, setOriginalFileName] = useState('');
  const [patternName, setPatternName] = useState('');
  const [paletteName, setPaletteName] = useState('96');
  const [palette, setPalette] = useState<PaletteColor[]>([]);
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const [cols, setCols] = useState(50);
  const [rows, setRows] = useState(50);
  const [autoReferenceCols, setAutoReferenceCols] = useState('');
  const [autoReferenceRows, setAutoReferenceRows] = useState('');
  const [detectedGrid, setDetectedGrid] = useState<DetectedGrid | null>(null);
  const [cropBounds, setCropBounds] = useState<GridBounds | null>(null);
  const [bounds, setBounds] = useState<GridBounds | null>(null);
  const [result, setResult] = useState<PatternAnalysisResult | null>(null);
  const [selectedCell, setSelectedCell] = useState<{ row: number; col: number } | null>(null);
  const [selectedColorKey, setSelectedColorKey] = useState('');
  const [selectedColorGroupKey, setSelectedColorGroupKey] = useState<string | null>(null);
  const [selectedCorrectionKeys, setSelectedCorrectionKeys] = useState<string[]>([]);
  const [isGroupCorrectionOpen, setIsGroupCorrectionOpen] = useState(false);
  const [groupCorrectionColorKey, setGroupCorrectionColorKey] = useState('');
  const [isBoundaryAdjusting, setIsBoundaryAdjusting] = useState(false);
  const [isGridControlsCollapsed, setIsGridControlsCollapsed] = useState(false);
  const [activeBoundaryHandle, setActiveBoundaryHandle] = useState<BoundaryHandle>('move');
  const [adjustMode, setAdjustMode] = useState<AdjustMode>('auto');
  const [adjustTarget, setAdjustTarget] = useState<AdjustTarget>('grid');
  const [boundaryDrag, setBoundaryDrag] = useState<BoundaryDragState | null>(null);
  const [canvasSize, setCanvasSize] = useState<{ width: number; height: number } | null>(null);
  const [sourceCanvasVersion, setSourceCanvasVersion] = useState(0);
  const [previewZoom, setPreviewZoom] = useState(1);
  const [visiblePreviewRange, setVisiblePreviewRange] = useState<string>('整张图');
  const [treatWhiteAsTransparent, setTreatWhiteAsTransparent] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SaveResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    setPaletteError(null);
    fetchMardPalette(paletteName)
      .then((parsed) => {
        if (cancelled) return;
        setPalette(parsed);
        setSelectedColorKey((current) => keepPaletteSelection(current, parsed));
        setGroupCorrectionColorKey((current) => keepPaletteSelection(current, parsed));
      })
      .catch((error) => {
        if (cancelled) return;
        setPalette([]);
        setPaletteError(error instanceof Error ? error.message : '读取色板失败');
      });

    return () => {
      cancelled = true;
    };
  }, [paletteName]);

  const displayResult = useMemo(
    () => (result ? annotatePatternResultForPalette(result, palette) : null),
    [result, palette]
  );

  const paletteComplianceIssues = useMemo(
    () => (displayResult ? getPaletteComplianceIssues(displayResult, palette) : []),
    [displayResult, palette]
  );

  const groupCorrectionColor = useMemo(
    () => palette.find((color) => color.key === groupCorrectionColorKey) ?? null,
    [palette, groupCorrectionColorKey]
  );

  useEffect(() => {
    if (!result || !previewCanvasRef.current) return;
    drawResultPreview(previewCanvasRef.current, result, {
      selectedCell,
      highlightedColorKey: selectedColorGroupKey,
      previewOverride: isGroupCorrectionOpen && selectedCorrectionKeys.length > 0
        ? {
            sourceColorKeys: selectedCorrectionKeys,
            targetColor: groupCorrectionColor,
          }
        : null,
    });
    requestAnimationFrame(updateVisiblePreviewRange);
  }, [activeTab, result, selectedCell, selectedColorGroupKey, isGroupCorrectionOpen, selectedCorrectionKeys, groupCorrectionColor, previewZoom]);

  const sortedColorCounts = useMemo<ColorCountItem[]>(() => {
    if (!displayResult) return [];
    return Object.entries(displayResult.colorCounts)
      .map(([hex, entry]) => {
        const relatedCells = displayResult.cells.filter((cell) => {
          const mappedCell = displayResult.mappedPixelData[cell.row]?.[cell.col];
          return mappedCell && !mappedCell.isExternal && mappedCell.key === entry.colorKey;
        });

        return {
          hex,
          ...entry,
          groupLabel: getColorGroupLabel(entry.colorKey),
          pendingCount: relatedCells.filter((cell) => cell.status === 'pending').length,
          changedCount: relatedCells.filter((cell) => cell.status === 'changed').length,
        };
      })
      .sort((a, b) => compareColorKeys(a.colorKey, b.colorKey));
  }, [displayResult]);

  const colorCountGroups = useMemo<ColorCountGroup[]>(() => {
    const groups = new Map<string, ColorCountItem[]>();
    for (const entry of sortedColorCounts) {
      const groupEntries = groups.get(entry.groupLabel) ?? [];
      groupEntries.push(entry);
      groups.set(entry.groupLabel, groupEntries);
    }

    return Array.from(groups.entries())
      .map(([label, colors]) => ({
        label,
        colors,
        totalCount: colors.reduce((sum, color) => sum + color.count, 0),
      }))
      .sort((a, b) => a.label.localeCompare(b.label, 'en', { numeric: true }));
  }, [sortedColorCounts]);

  const availableColorKeySignature = useMemo(
    () => sortedColorCounts.map((entry) => entry.colorKey).join('|'),
    [sortedColorCounts]
  );

  const selectedColorGroup = useMemo(
    () => sortedColorCounts.find((entry) => entry.colorKey === selectedColorGroupKey) ?? null,
    [sortedColorCounts, selectedColorGroupKey]
  );

  const selectedColorGroupCells = useMemo(() => {
    if (!displayResult || !selectedColorGroupKey) return [];
    return displayResult.cells
      .filter((cell) => {
        const mappedCell = displayResult.mappedPixelData[cell.row]?.[cell.col];
        return mappedCell && !mappedCell.isExternal && mappedCell.key === selectedColorGroupKey;
      })
      .sort((a, b) => b.uncertainty - a.uncertainty || a.row - b.row || a.col - b.col);
  }, [displayResult, selectedColorGroupKey]);

  useEffect(() => {
    if (!displayResult) {
      setSelectedColorGroupKey(null);
      setSelectedCorrectionKeys((current) => (current.length === 0 ? current : []));
      setIsGroupCorrectionOpen(false);
      return;
    }

    const availableKeys = availableColorKeySignature ? availableColorKeySignature.split('|') : [];
    if (!availableKeys.length) {
      setSelectedColorGroupKey(null);
      setSelectedCorrectionKeys((current) => (current.length === 0 ? current : []));
      setIsGroupCorrectionOpen(false);
      return;
    }

    if (!selectedColorGroupKey || !availableKeys.includes(selectedColorGroupKey)) {
      setSelectedColorGroupKey(availableKeys[0]);
    }

    setSelectedCorrectionKeys((current) => {
      const next = current.filter((colorKey) => availableKeys.includes(colorKey));
      const hasSameValues = next.length === current.length && next.every((colorKey, index) => colorKey === current[index]);
      return hasSameValues ? current : next;
    });
    if (selectedCorrectionKeys.length > 0 && selectedCorrectionKeys.every((colorKey) => !availableKeys.includes(colorKey))) {
      setIsGroupCorrectionOpen(false);
    }
  }, [availableColorKeySignature, displayResult, selectedColorGroupKey, selectedCorrectionKeys]);

  const selectedPaletteColor = useMemo(
    () => palette.find((color) => color.key === selectedColorKey) ?? null,
    [palette, selectedColorKey]
  );

  useEffect(() => {
    if (activeTab !== 'parse') return;
    redrawDisplayCanvas({
      overlayMode: parseStep === 'crop' ? 'crop' : 'grid',
      adjustOptions: {
        isAdjusting: isBoundaryAdjusting,
        activeHandle: activeBoundaryHandle,
        activeTarget: parseStep === 'crop' ? 'canvas' : adjustTarget,
      },
    });
  }, [activeBoundaryHandle, activeTab, adjustTarget, bounds, cols, cropBounds, isBoundaryAdjusting, parseStep, rows]);

  useEffect(() => {
    requestAnimationFrame(updateVisiblePreviewRange);
  }, [activeTab, previewZoom, result]);

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    await loadImageFile(file);
  };

  const loadImageFile = async (file: File) => {
    if (!file.type.startsWith('image/')) {
      setStatusMessage('请选择图片文件');
      return;
    }

    const dataUrl = await readFileAsDataUrl(file);
    setImageSrc(dataUrl);
    setOriginalFileName(file.name);
    setPatternName(stripExtension(file.name));
    setParseStep('crop');
    setDetectedGrid(null);
    setCropBounds(null);
    setBounds(null);
    setResult(null);
    setSaveResult(null);
    setAutoReferenceCols('');
    setAutoReferenceRows('');
    setSelectedCell(null);
    setSelectedColorGroupKey(null);
    setSelectedCorrectionKeys([]);
    setIsGroupCorrectionOpen(false);
    setAdjustMode('auto');
    setAdjustTarget('canvas');
    setActiveBoundaryHandle('move');
    setIsBoundaryAdjusting(true);
    setIsGridControlsCollapsed(false);
    setBoundaryDrag(null);
    const initialBounds = await drawImageToCanvases(dataUrl);
    setCropBounds(null);
    redrawDisplayCanvas({
      overlayMode: 'crop',
      nextCropBounds: null,
      adjustOptions: {
        isAdjusting: true,
        activeHandle: 'move',
        activeTarget: 'canvas',
      },
    });
    setStatusMessage(`图纸已加载：${initialBounds.right}x${initialBounds.bottom}。拖拽框选裁剪区域，未框选时默认整张图`);
  };

  const handleConfirmCrop = () => {
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;
    const selectedCropBounds = cropBounds ?? getFullCanvasBounds(canvas);
    const cropped = cropWorkingCanvases(selectedCropBounds);
    if (!cropped) return;
    setImageSrc(cropped.dataUrl);
    setCropBounds(cropped.bounds);
    setBounds(null);
    setDetectedGrid(null);
    setParseStep('grid');
    setAdjustMode('auto');
    setAdjustTarget('grid');
    setIsBoundaryAdjusting(false);
    setIsGridControlsCollapsed(false);
    applyAutoGridDetection(cropped.bounds);
  };

  const handleDetectGrid = () => {
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;
    const scanBounds = getFullCanvasBounds(canvas);
    setParseStep('grid');
    setAdjustMode('auto');
    setAdjustTarget('grid');
    setIsGridControlsCollapsed(false);
    applyAutoGridDetection(scanBounds);
  };

  const applyAutoGridDetection = (scanBounds?: GridBounds) => {
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;

    try {
      const referenceCols = parseOptionalGridCount(autoReferenceCols);
      const referenceRows = parseOptionalGridCount(autoReferenceRows);
      const detected = detectGridFromCanvas(canvas, {
        ...(scanBounds ? { bounds: scanBounds } : {}),
        ...(referenceCols ? { expectedCols: referenceCols } : {}),
        ...(referenceRows ? { expectedRows: referenceRows } : {}),
      });
      const nextCols =
        detected.estimatedCols && detected.estimatedCols >= 5 && detected.estimatedCols <= 300
          ? detected.estimatedCols
          : cols;
      const nextRows =
        detected.estimatedRows && detected.estimatedRows >= 5 && detected.estimatedRows <= 300
          ? detected.estimatedRows
          : rows;
      setDetectedGrid(detected);
      setBounds(detected.bounds);
      setCols(nextCols);
      setRows(nextRows);
      setIsBoundaryAdjusting(false);
      setIsGridControlsCollapsed(false);
      setActiveBoundaryHandle('move');
      redrawDisplayCanvas({
        overlayMode: 'grid',
        nextGridBounds: detected.bounds,
        nextCropBounds: scanBounds ?? cropBounds,
        nextDetectedGrid: detected,
        nextCols,
        nextRows,
        adjustOptions: {
          isAdjusting: false,
          activeHandle: 'move',
          activeTarget: 'grid',
        },
      });
      const referenceLabel = referenceCols || referenceRows ? `，参考 ${referenceCols || '?'} x ${referenceRows || '?'}` : '';
      const pitchLabel =
        detected.geometry.pitchX && detected.geometry.pitchY
          ? `，pitch ${formatMeasurementForInput(detected.geometry.pitchX)} x ${formatMeasurementForInput(detected.geometry.pitchY)}`
          : '';
      setStatusMessage(`检测完成：当前计算画布 ${canvas.width}x${canvas.height}，建议 ${detected.estimatedCols || '?'} x ${detected.estimatedRows || '?'}${pitchLabel}${referenceLabel}，置信度 ${Math.round(detected.confidence * 100)}%`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '网格检测失败');
    }
  };

  const handleConfirmGrid = () => {
    if (!bounds) {
      setStatusMessage('请先自动检测或手动框选网格边界');
      return;
    }

    setIsGridControlsCollapsed(true);
    setIsBoundaryAdjusting(false);
    setActiveBoundaryHandle('move');
    redrawDisplayCanvas({
      overlayMode: 'grid',
      nextGridBounds: bounds,
      nextCols: cols,
      nextRows: rows,
      adjustOptions: {
        isAdjusting: false,
        activeHandle: 'move',
        activeTarget: 'grid',
      },
    });
    setStatusMessage('网格已确认，可以继续微调或进入下一步');
  };

  const handleReopenGridControls = () => {
    setIsGridControlsCollapsed(false);
    setAdjustMode('manual');
    setAdjustTarget('grid');
    setIsBoundaryAdjusting(true);
    setActiveBoundaryHandle('move');
    redrawDisplayCanvas({
      overlayMode: 'grid',
      nextGridBounds: bounds,
      nextCols: cols,
      nextRows: rows,
      adjustOptions: {
        isAdjusting: true,
        activeHandle: 'move',
        activeTarget: 'grid',
      },
    });
  };

  const handleAnalyze = () => {
    const canvas = sourceCanvasRef.current;
    if (!canvas) return;
    if (!palette.length) {
      setStatusMessage('色板还没有加载完成');
      return;
    }
    if (parseStep === 'crop') {
      setStatusMessage('请先确定裁剪区域，再解析图纸');
      return;
    }

    try {
      const analysisBounds = bounds ?? cropBounds ?? getFullCanvasBounds(canvas);
      const analysis = analyzePatternCanvas(canvas, {
        cols,
        rows,
        palette,
        bounds: analysisBounds,
        treatNearWhiteAsTransparent: treatWhiteAsTransparent,
      });
      setResult(analysis);
      setBounds(analysis.grid.bounds);
      setDetectedGrid(analysis.grid);
      setCols(analysis.gridDimensions.N);
      setRows(analysis.gridDimensions.M);
      setSelectedCell(null);
      const firstColorKey = getFirstColorKey(analysis);
      setSelectedColorGroupKey(firstColorKey);
      setSelectedCorrectionKeys(firstColorKey ? [firstColorKey] : []);
      setIsGroupCorrectionOpen(false);
      setActiveTab('optimize');
      redrawDisplayCanvas({
        overlayMode: 'grid',
        nextGridBounds: analysis.grid.bounds,
        nextDetectedGrid: analysis.grid,
        nextCols: analysis.gridDimensions.N,
        nextRows: analysis.gridDimensions.M,
      });
      setStatusMessage(`解析完成：${analysis.totalBeadCount} 颗，${Object.keys(analysis.colorCounts).length} 个颜色`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '图纸解析失败');
    }
  };

  const handleEnterNextStep = () => {
    setIsGridControlsCollapsed(true);
    setIsBoundaryAdjusting(false);
    handleAnalyze();
  };

  const handlePaletteNameChange = async (nextPaletteName: string) => {
    if (nextPaletteName === paletteName) return;

    if (!result) {
      setPaletteName(nextPaletteName);
      return;
    }

    try {
      const nextPalette = await fetchMardPalette(nextPaletteName);
      const issues = getPaletteComplianceIssues(result, nextPalette);
      const issueKeys = issues.map((issue) => issue.colorKey).sort(compareColorKeys);
      const extraBeadCount = issues.reduce((sum, issue) => sum + issue.count, 0);

      setPaletteName(nextPaletteName);
      if (issues.length > 0) {
        setSelectedColorGroupKey(issueKeys[0]);
        setSelectedCorrectionKeys(issueKeys);
        setIsGroupCorrectionOpen(false);
        setStatusMessage(`å·²åˆ‡æ¢åˆ° MARD ${nextPaletteName}ï¼š${issues.length} ä¸ªæ–¹æ¡ˆå¤–é¢œè‰²ï¼Œå…± ${extraBeadCount} é¢—ï¼Œå¯ä¿ç•™æˆ–æŒ‰æŽ¨èè‰²æ›¿æ¢`);
      } else {
        setSelectedCorrectionKeys([]);
        setStatusMessage(`å·²åˆ‡æ¢åˆ° MARD ${nextPaletteName}ï¼Œå½“å‰å›¾çº¸é¢œè‰²éƒ½åœ¨è¯¥æ–¹æ¡ˆå†…`);
      }
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : 'è‰²æ¿åˆ‡æ¢å¤±è´¥');
    }
  };

  const handleApplyPaletteRecommendations = () => {
    if (!result || !palette.length) return;
    const issues = getPaletteComplianceIssues(result, palette);
    if (!issues.length) return;

    const extraBeadCount = issues.reduce((sum, issue) => sum + issue.count, 0);
    if (!hasConfirmedPaletteRemapRef.current) {
      const shouldApply = window.confirm(`å°† ${issues.length} ä¸ªæ–¹æ¡ˆå¤–é¢œè‰²ï¼ˆ${extraBeadCount} é¢—ï¼‰æ›¿æ¢ä¸º MARD ${paletteName} ä¸­çš„æœ€è¿‘æŽ¨èè‰²ï¼Ÿ`);
      if (!shouldApply) return;
      hasConfirmedPaletteRemapRef.current = true;
    }

    const updated = remapPatternResultToPalette(result, palette);
    setResult(updated);
    setSelectedCorrectionKeys([]);
    setSelectedColorGroupKey(getFirstColorKey(updated));
    setIsGroupCorrectionOpen(false);
    setStatusMessage(`å·²æŒ‰ MARD ${paletteName} æŽ¨èè‰²æ›¿æ¢ ${extraBeadCount} é¢—æ–¹æ¡ˆå¤–é¢œè‰²`);
  };

  const handleManualApply = (color: PaletteColor | null) => {
    if (!result || !selectedCell) return;
    const updated = updateAnalyzedCellColor(result, selectedCell.row, selectedCell.col, color);
    setResult(updated);
    setStatusMessage(color ? `已把 (${selectedCell.row + 1}, ${selectedCell.col + 1}) 改为 ${color.key}` : `已把 (${selectedCell.row + 1}, ${selectedCell.col + 1}) 改为透明`);
  };

  const toggleCorrectionKey = (colorKey: string) => {
    setSelectedCorrectionKeys((current) => {
      const isSelected = current.includes(colorKey);
      return isSelected ? current.filter((key) => key !== colorKey) : [...current, colorKey].sort(compareColorKeys);
    });
    setSelectedColorGroupKey(colorKey);
    setIsGroupCorrectionOpen(false);
  };

  const openGroupCorrection = () => {
    const targetKeys = selectedCorrectionKeys.length > 0
      ? selectedCorrectionKeys
      : selectedColorGroupKey
        ? [selectedColorGroupKey]
        : [];
    if (!targetKeys.length) return;
    setSelectedCorrectionKeys(targetKeys);
    setIsGroupCorrectionOpen(true);
    const fallbackColorKey = palette.find((color) => color.key === targetKeys[0])?.key ?? palette[0]?.key ?? '';
    setGroupCorrectionColorKey((current) => current || fallbackColorKey);
  };

  const handleGroupApply = (color: PaletteColor | null) => {
    if (!result || !selectedCorrectionKeys.length) return;
    const targetKeys = selectedCorrectionKeys;
    const affectedCount = sortedColorCounts
      .filter((entry) => targetKeys.includes(entry.colorKey))
      .reduce((sum, entry) => sum + entry.count, 0);
    const updated = updateAnalyzedColorGroups(result, targetKeys, color);
    setResult(updated);
    setIsGroupCorrectionOpen(false);
    setSelectedCorrectionKeys([]);
    setSelectedColorGroupKey(color ? color.key : getFirstColorKey(updated));
    setStatusMessage(color ? `已把 ${affectedCount} 个格子改为 ${color.key}` : `已把 ${affectedCount} 个格子改为透明`);
  };

  const handlePreviewClick = (event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!result || !previewCanvasRef.current) return;
    const canvas = previewCanvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * (canvas.width / rect.width);
    const y = (event.clientY - rect.top) * (canvas.height / rect.height);
    const col = Math.floor((x / canvas.width) * result.gridDimensions.N);
    const row = Math.floor((y / canvas.height) * result.gridDimensions.M);
    if (row >= 0 && row < result.gridDimensions.M && col >= 0 && col < result.gridDimensions.N) {
      setSelectedCell({ row, col });
    }
  };

  const updateVisiblePreviewRange = () => {
    const viewport = previewViewportRef.current;
    const canvas = previewCanvasRef.current;
    if (!viewport || !canvas || !result || canvas.clientWidth <= 0 || canvas.clientHeight <= 0) {
      setVisiblePreviewRange('整张图');
      return;
    }

    const { N, M } = result.gridDimensions;
    const scaleX = canvas.width / canvas.clientWidth;
    const scaleY = canvas.height / canvas.clientHeight;
    const cellWidth = canvas.width / N;
    const cellHeight = canvas.height / M;
    const xStart = viewport.scrollLeft * scaleX;
    const yStart = viewport.scrollTop * scaleY;
    const xEnd = Math.min(canvas.width, (viewport.scrollLeft + viewport.clientWidth) * scaleX);
    const yEnd = Math.min(canvas.height, (viewport.scrollTop + viewport.clientHeight) * scaleY);
    const colStart = clampIntegerValue(Math.floor(xStart / cellWidth) + 1, 1, N);
    const rowStart = clampIntegerValue(Math.floor(yStart / cellHeight) + 1, 1, M);
    const colEnd = clampIntegerValue(Math.ceil(xEnd / cellWidth), colStart, N);
    const rowEnd = clampIntegerValue(Math.ceil(yEnd / cellHeight), rowStart, M);
    setVisiblePreviewRange(`R${rowStart}-${rowEnd} / C${colStart}-${colEnd}`);
  };

  const setPreviewZoomKeepingCenter = (nextZoom: number) => {
    const next = clampNumber(nextZoom, 0.5, 4);
    const viewport = previewViewportRef.current;
    const canvas = previewCanvasRef.current;
    const center = viewport && canvas && canvas.clientWidth > 0 && canvas.clientHeight > 0
      ? {
          x: (viewport.scrollLeft + viewport.clientWidth / 2) * (canvas.width / canvas.clientWidth),
          y: (viewport.scrollTop + viewport.clientHeight / 2) * (canvas.height / canvas.clientHeight),
        }
      : null;

    setPreviewZoom(next);
    requestAnimationFrame(() => {
      const nextViewport = previewViewportRef.current;
      const nextCanvas = previewCanvasRef.current;
      if (center && nextViewport && nextCanvas && nextCanvas.clientWidth > 0 && nextCanvas.clientHeight > 0) {
        nextViewport.scrollLeft = center.x / (nextCanvas.width / nextCanvas.clientWidth) - nextViewport.clientWidth / 2;
        nextViewport.scrollTop = center.y / (nextCanvas.height / nextCanvas.clientHeight) - nextViewport.clientHeight / 2;
      }
      updateVisiblePreviewRange();
    });
  };

  const handleSave = async () => {
    const resultToSave = displayResult ?? result;
    if (!resultToSave) return;
    const extraColorCount = Object.values(resultToSave.colorCounts).filter((entry) => entry.isExtraColor).length;
    const extraBeadCount = Object.values(resultToSave.colorCounts)
      .filter((entry) => entry.isExtraColor)
      .reduce((sum, entry) => sum + entry.count, 0);
    setIsSaving(true);
    setSaveResult(null);
    try {
      const response = await fetch('/api/projects/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: patternName || stripExtension(originalFileName) || 'pattern',
          originalFileName,
          originalImageDataUrl: imageSrc,
          selectedColorSystem: 'MARD',
          brand: 'MARD',
          paletteName,
          gridDimensions: resultToSave.gridDimensions,
          mappedPixelData: resultToSave.mappedPixelData,
          colorCounts: resultToSave.colorCounts,
          totalBeadCount: resultToSave.totalBeadCount,
          sourceType: 'analyzed_pattern_sheet',
          analysisMetadata: {
            originalPatternImagePath: '',
            analyzedAt: new Date().toISOString(),
            recognitionMethod: 'background_color',
            unconfirmedCellCount: resultToSave.cells.filter((cell) => cell.status === 'pending').length,
            extraColorCount,
            extraBeadCount,
            gridBounds: resultToSave.grid.bounds,
          },
        }),
      });
      const body = (await response.json()) as SaveResponse;
      setSaveResult(body);
      if (!response.ok || !body.ok) {
        throw new Error(body.error || '保存失败');
      }
      setStatusMessage(`已保存：${body.path}`);
    } catch (error) {
      setStatusMessage(error instanceof Error ? error.message : '保存失败');
    } finally {
      setIsSaving(false);
    }
  };

  const handleBoundsChange = (key: keyof GridBounds, value: string, target: AdjustTarget = parseStep === 'crop' ? 'canvas' : adjustTarget) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return;
    const source = sourceCanvasRef.current;
    if (!source) return;
    const current = getBoundsForTarget(target);
    const next = normalizeEditableBounds(
      {
        ...current,
        [key]: numeric,
      },
      source.width,
      source.height
    );
    setIsGridControlsCollapsed(false);
    if (target === 'grid') setDetectedGrid(null);
    setBoundsForTarget(target, next);
  };

  const handleDisplayPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const source = sourceCanvasRef.current;
    if (!source || (!isBoundaryAdjusting && parseStep !== 'crop')) return;
    const target = parseStep === 'crop' ? 'canvas' : adjustTarget;
    const point = getCanvasPoint(event);
    const activeBounds = getExistingBoundsForTarget(target);
    const pickedHandle = activeBounds
      ? pickBoundaryHandle(activeBounds, point.x, point.y, event.currentTarget.width, event.currentTarget.height)
      : null;
    const mode: BoundaryDragMode | null = pickedHandle
      ?? (activeBounds && isPointInsideBounds(activeBounds, point.x, point.y)
        ? 'move'
        : parseStep === 'crop' || !activeBounds
          ? 'draw'
          : null);

    if (!mode) return;

    event.preventDefault();
    setAdjustMode('manual');
    setIsGridControlsCollapsed(false);
    if (target === 'grid') setDetectedGrid(null);
    setIsBoundaryAdjusting(true);
    setActiveBoundaryHandle(mode === 'draw' ? 'move' : mode);
    setBoundaryDrag({
      mode,
      target,
      startPoint: point,
      startBounds: activeBounds,
    });
    event.currentTarget.setPointerCapture(event.pointerId);

    if (mode === 'draw') {
      setBoundsForTarget(target, boundsFromPoints(point, point, source.width, source.height), 'move');
    }
  };

  const handleDisplayPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!boundaryDrag) return;
    const source = sourceCanvasRef.current;
    if (!source) return;
    const point = getCanvasPoint(event);
    const fallbackBounds = getBoundsForTarget(boundaryDrag.target);
    const startBounds = boundaryDrag.startBounds ?? fallbackBounds;
    let nextBounds: GridBounds;

    if (boundaryDrag.mode === 'draw') {
      nextBounds = boundsFromPoints(boundaryDrag.startPoint, point, source.width, source.height);
    } else if (boundaryDrag.mode === 'move') {
      nextBounds = shiftBounds(
        startBounds,
        point.x - boundaryDrag.startPoint.x,
        point.y - boundaryDrag.startPoint.y,
        source.width,
        source.height
      );
    } else {
      nextBounds = resizeBoundsFromHandle(startBounds, boundaryDrag.mode, point, source.width, source.height);
    }

    setBoundsForTarget(boundaryDrag.target, nextBounds, boundaryDrag.mode === 'draw' ? 'move' : boundaryDrag.mode);
  };

  const handleDisplayPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setBoundaryDrag(null);
  };

  const handleColsChange = (value: string) => {
    const nextCols = clampInteger(value, 1, 300);
    const source = sourceCanvasRef.current;
    let nextGridBounds = bounds;
    if (parseStep === 'grid' && bounds && source) {
      const center = getBoundsCenter(bounds);
      const cellWidth = (bounds.right - bounds.left) / Math.max(1, cols);
      nextGridBounds = boundsFromCenterAndSize(
        center,
        cellWidth * nextCols,
        bounds.bottom - bounds.top,
        source.width,
        source.height
      );
      setBounds(nextGridBounds);
    }
    setIsGridControlsCollapsed(false);
    setDetectedGrid(null);
    setCols(nextCols);
    redrawDisplayCanvas({
      overlayMode: parseStep === 'crop' ? 'crop' : 'grid',
      nextGridBounds,
      nextCols,
    });
  };

  const handleRowsChange = (value: string) => {
    const nextRows = clampInteger(value, 1, 300);
    const source = sourceCanvasRef.current;
    let nextGridBounds = bounds;
    if (parseStep === 'grid' && bounds && source) {
      const center = getBoundsCenter(bounds);
      const cellHeight = (bounds.bottom - bounds.top) / Math.max(1, rows);
      nextGridBounds = boundsFromCenterAndSize(
        center,
        bounds.right - bounds.left,
        cellHeight * nextRows,
        source.width,
        source.height
      );
      setBounds(nextGridBounds);
    }
    setIsGridControlsCollapsed(false);
    setDetectedGrid(null);
    setRows(nextRows);
    redrawDisplayCanvas({
      overlayMode: parseStep === 'crop' ? 'crop' : 'grid',
      nextGridBounds,
      nextRows,
    });
  };

  const handleGridCenterChange = (axis: 'x' | 'y', value: string) => {
    const numeric = Number(value);
    const source = sourceCanvasRef.current;
    if (!source || !Number.isFinite(numeric)) return;
    const current = bounds ?? getFullCanvasBounds(source);
    const center = getBoundsCenter(current);
    const next = shiftBounds(
      current,
      axis === 'x' ? numeric - center.x : 0,
      axis === 'y' ? numeric - center.y : 0,
      source.width,
      source.height
    );
    setAdjustMode('manual');
    setAdjustTarget('grid');
    setIsBoundaryAdjusting(true);
    setIsGridControlsCollapsed(false);
    setDetectedGrid(null);
    setActiveBoundaryHandle('move');
    setBoundsForTarget('grid', next, 'move');
  };

  const handleGridCellSizeChange = (axis: 'width' | 'height', value: string) => {
    const numeric = Number(value);
    const source = sourceCanvasRef.current;
    if (!source || !Number.isFinite(numeric) || numeric <= 0) return;

    const current = bounds ?? getFullCanvasBounds(source);
    const center = getBoundsCenter(current);
    const currentCellWidth = (current.right - current.left) / Math.max(1, cols);
    const currentCellHeight = (current.bottom - current.top) / Math.max(1, rows);
    const nextCellWidth = axis === 'width'
      ? clampNumber(numeric, 0.2, Math.max(0.2, source.width / Math.max(1, cols)))
      : currentCellWidth;
    const nextCellHeight = axis === 'height'
      ? clampNumber(numeric, 0.2, Math.max(0.2, source.height / Math.max(1, rows)))
      : currentCellHeight;
    const next = boundsFromCenterAndSize(
      center,
      nextCellWidth * Math.max(1, cols),
      nextCellHeight * Math.max(1, rows),
      source.width,
      source.height
    );

    setAdjustMode('manual');
    setAdjustTarget('grid');
    setIsBoundaryAdjusting(true);
    setIsGridControlsCollapsed(false);
    setDetectedGrid(null);
    setActiveBoundaryHandle('move');
    setBoundsForTarget('grid', next, 'move');
  };

  const alignGridCenterToCanvas = () => {
    const source = sourceCanvasRef.current;
    if (!source) return;
    const current = bounds ?? getFullCanvasBounds(source);
    const center = getBoundsCenter(current);
    const next = shiftBounds(
      current,
      source.width / 2 - center.x,
      source.height / 2 - center.y,
      source.width,
      source.height
    );
    setAdjustMode('manual');
    setAdjustTarget('grid');
    setIsBoundaryAdjusting(true);
    setIsGridControlsCollapsed(false);
    setActiveBoundaryHandle('move');
    setBoundsForTarget('grid', next, 'move');
    setStatusMessage('网格中心点已对齐到裁剪后画面中心');
  };

  const nudgeActiveTarget = (direction: NudgeDirection) => {
    const source = sourceCanvasRef.current;
    if (!source) return;
    const target = parseStep === 'crop' ? 'canvas' : adjustTarget;
    const current = getBoundsForTarget(target);
    const delta = direction === 'left'
      ? { x: -1, y: 0 }
      : direction === 'right'
        ? { x: 1, y: 0 }
        : direction === 'up'
          ? { x: 0, y: -1 }
          : { x: 0, y: 1 };
    const next = activeBoundaryHandle === 'move'
      ? shiftBounds(current, delta.x, delta.y, source.width, source.height)
      : nudgeBoundsByHandle(current, activeBoundaryHandle, direction, source.width, source.height);
    setAdjustMode('manual');
    setIsGridControlsCollapsed(false);
    if (target === 'grid') setDetectedGrid(null);
    setBoundsForTarget(target, next, activeBoundaryHandle);
  };

  const resetActiveTarget = () => {
    const source = sourceCanvasRef.current;
    if (!source) return;
    const target = parseStep === 'crop' ? 'canvas' : adjustTarget;
    setIsGridControlsCollapsed(false);
    if (target === 'canvas') {
      const resetBounds = parseStep === 'crop' ? null : getFullCanvasBounds(source);
      setCropBounds(resetBounds);
      setActiveBoundaryHandle('move');
      redrawDisplayCanvas({
        overlayMode: parseStep === 'crop' ? 'crop' : 'grid',
        nextCropBounds: resetBounds,
        adjustOptions: {
          isAdjusting: isBoundaryAdjusting,
          activeHandle: 'move',
          activeTarget: 'canvas',
        },
      });
      setStatusMessage(parseStep === 'crop' ? '裁剪框已清空，请拖拽重新框选' : '画布裁剪已 Reset');
      return;
    }

    if (detectedGrid) {
      const nextCols =
        detectedGrid.estimatedCols && detectedGrid.estimatedCols >= 5 && detectedGrid.estimatedCols <= 300
          ? detectedGrid.estimatedCols
          : cols;
      const nextRows =
        detectedGrid.estimatedRows && detectedGrid.estimatedRows >= 5 && detectedGrid.estimatedRows <= 300
          ? detectedGrid.estimatedRows
          : rows;
      setBounds(detectedGrid.bounds);
      setCols(nextCols);
      setRows(nextRows);
      redrawDisplayCanvas({
        overlayMode: 'grid',
        nextGridBounds: detectedGrid.bounds,
        nextCols,
        nextRows,
        adjustOptions: {
          isAdjusting: isBoundaryAdjusting,
          activeHandle: 'move',
          activeTarget: 'grid',
        },
      });
      setActiveBoundaryHandle('move');
      setStatusMessage('网格边界已 Reset 到自动检测结果');
      return;
    }

    handleDetectGrid();
  };

  const setBoundsForTarget = (target: AdjustTarget, nextBounds: GridBounds, nextActiveHandle: BoundaryHandle | null = activeBoundaryHandle) => {
    if (target === 'canvas') {
      setCropBounds(nextBounds);
      redrawDisplayCanvas({
        overlayMode: parseStep === 'crop' ? 'crop' : 'grid',
        nextCropBounds: nextBounds,
        adjustOptions: {
          isAdjusting: isBoundaryAdjusting,
          activeHandle: nextActiveHandle,
          activeTarget: target,
        },
      });
      return;
    }

    setBounds(nextBounds);
    redrawDisplayCanvas({
      overlayMode: 'grid',
      nextGridBounds: nextBounds,
      adjustOptions: {
        isAdjusting: isBoundaryAdjusting,
        activeHandle: nextActiveHandle,
        activeTarget: target,
      },
    });
  };

  const getBoundsForTarget = (target: AdjustTarget): GridBounds => {
    const source = sourceCanvasRef.current;
    const fallback = source ? getFullCanvasBounds(source) : { left: 0, top: 0, right: 0, bottom: 0 };
    return getExistingBoundsForTarget(target) ?? fallback;
  };

  const getExistingBoundsForTarget = (target: AdjustTarget): GridBounds | null => {
    return target === 'canvas'
      ? cropBounds
      : bounds ?? cropBounds;
  };

  const redrawDisplayCanvas = ({
    overlayMode = parseStep === 'crop' ? 'crop' : 'grid',
    nextGridBounds = bounds,
    nextCropBounds = cropBounds,
    nextDetectedGrid = detectedGrid,
    nextCols = cols,
    nextRows = rows,
    adjustOptions = {
      isAdjusting: isBoundaryAdjusting,
      activeHandle: activeBoundaryHandle,
      activeTarget: parseStep === 'crop' ? 'canvas' : adjustTarget,
    },
  }: RedrawDisplayOptions = {}) => {
    const source = sourceCanvasRef.current;
    const display = displayCanvasRef.current;
    if (!source || !display || source.width === 0 || source.height === 0) return;
    display.width = source.width;
    display.height = source.height;
    const ctx = display.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, display.width, display.height);
    ctx.drawImage(source, 0, 0);

    if (overlayMode === 'crop') {
      if (nextCropBounds) {
        drawCropOverlay(ctx, nextCropBounds, adjustOptions);
      }
      return;
    }

    if (nextCropBounds && adjustOptions.activeTarget === 'canvas') {
      drawCropOverlay(ctx, nextCropBounds, adjustOptions);
    }
    if (nextGridBounds) {
      drawGridOverlay(ctx, nextGridBounds, nextCols, nextRows, adjustOptions, nextDetectedGrid);
    }
  };

  const activeAdjustmentTarget = parseStep === 'crop' ? 'canvas' : adjustTarget;
  const activeAdjustmentBounds = activeAdjustmentTarget === 'canvas' ? cropBounds : bounds;
  const gridCenter = detectedGrid?.geometry
    ? { x: detectedGrid.geometry.centerX, y: detectedGrid.geometry.centerY }
    : bounds
      ? getBoundsCenter(bounds)
      : null;
  const gridCellSize = detectedGrid?.geometry
    ? {
        width: detectedGrid.geometry.pitchX,
        height: detectedGrid.geometry.pitchY,
      }
    : bounds
    ? {
        width: (bounds.right - bounds.left) / Math.max(1, cols),
        height: (bounds.bottom - bounds.top) / Math.max(1, rows),
      }
    : null;
  const autoGridSizeLabel =
    detectedGrid?.estimatedCols && detectedGrid?.estimatedRows
      ? `${detectedGrid.estimatedCols}x${detectedGrid.estimatedRows}`
      : '-';
  const currentGridSizeLabel = `${cols}x${rows}`;
  const canvasSizeLabel = canvasSize ? `${canvasSize.width}x${canvasSize.height}` : '-';

  return (
    <main className="min-h-screen bg-slate-50 text-slate-950">
      <div className="mx-auto flex w-full max-w-7xl flex-col gap-4 px-4 py-4 sm:px-6 lg:px-8">
        <header className="flex flex-col gap-3 border-b border-slate-200 pb-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <Link href="/" className="text-sm font-medium text-slate-500 hover:text-slate-900">返回主页</Link>
            <h1 className="sr-only">图纸分析</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            {[
              ['parse', '解析'],
              ['optimize', '优化'],
              ['edit', '编辑'],
            ].map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setActiveTab(tab as AnalysisTab)}
                className={`h-10 rounded border px-4 text-sm font-medium transition-colors ${
                  activeTab === tab
                    ? 'border-slate-900 bg-slate-900 text-white'
                    : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-100'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </header>

        {statusMessage && (
          <div className="rounded border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
            {statusMessage}
          </div>
        )}

        <canvas ref={sourceCanvasRef} className="hidden" />

        {activeTab === 'parse' && (
          <section className="grid gap-4 lg:grid-cols-[380px_1fr]">
            <div className="flex flex-col gap-4">
              <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="text-base font-semibold">加载图纸</h2>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="mt-3 block w-full cursor-pointer rounded border border-slate-300 bg-white px-3 py-2 text-sm text-slate-700 file:mr-3 file:rounded file:border-0 file:bg-slate-100 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-slate-700 hover:file:bg-slate-200"
                  onChange={handleFileChange}
                />
                <label className="mt-4 block text-sm font-medium text-slate-700">
                  图纸名称
                  <input
                    value={patternName}
                    onChange={(event) => setPatternName(event.target.value)}
                    className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm"
                    placeholder="pattern name"
                  />
                </label>
                {imageSrc && (
                  <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs font-medium">
                    <span className={`rounded border px-2 py-2 ${parseStep === 'crop' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                      1 裁剪
                    </span>
                    <span className={`rounded border px-2 py-2 ${parseStep === 'grid' ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                      2 网格边界
                    </span>
                    <span className={`rounded border px-2 py-2 ${result ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-200 bg-slate-50 text-slate-500'}`}>
                      3 解析
                    </span>
                  </div>
                )}
              </div>

              {imageSrc && parseStep === 'crop' && (
                <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-base font-semibold">第一步：裁剪</h2>
                    <button
                      type="button"
                      onClick={resetActiveTarget}
                      className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                    >
                      Reset
                    </button>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    {([
                      ['top', '上'],
                      ['bottom', '下'],
                      ['left', '左'],
                      ['right', '右'],
                    ] as Array<[keyof GridBounds, string]>).map(([key, label]) => (
                      <label key={key} className="block text-sm font-medium text-slate-700">
                        {label}
                        <input
                          type="number"
                          value={Math.round(cropBounds?.[key] ?? 0)}
                          onChange={(event) => handleBoundsChange(key, event.target.value, 'canvas')}
                          className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm"
                        />
                      </label>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center justify-between gap-3">
                    <span className="text-sm font-medium text-slate-700">拖拽框选或微调画布</span>
                    <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600">
                      当前：{BOUNDARY_HANDLE_LABELS[activeBoundaryHandle]}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-4 gap-2">
                    {NUDGE_DIRECTIONS.map((item) => (
                      <button
                        key={item.direction}
                        type="button"
                        disabled={!cropBounds}
                        onClick={() => nudgeActiveTarget(item.direction)}
                        className="h-9 rounded border border-slate-300 bg-white px-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={handleConfirmCrop}
                    className="mt-4 h-10 w-full rounded bg-slate-900 px-3 text-sm font-medium text-white"
                  >
                    确定裁剪
                  </button>
                </div>
              )}

              {imageSrc && parseStep === 'grid' && (
                <>
                  <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                    <div className="flex items-center justify-between gap-3">
                      <h2 className="text-base font-semibold">第二步：网格边界</h2>
                      <button
                        type="button"
                        onClick={resetActiveTarget}
                        className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        Reset
                      </button>
                    </div>

                    {isGridControlsCollapsed ? (
                      <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
                        <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
                          <Stat label="当前网格" value={currentGridSizeLabel} />
                          <Stat label="中心点" value={gridCenter ? `${Math.round(gridCenter.x)}, ${Math.round(gridCenter.y)}` : '-'} />
                          <Stat
                            label="单格"
                            value={gridCellSize ? `${formatMeasurementForInput(gridCellSize.width)} x ${formatMeasurementForInput(gridCellSize.height)}` : '-'}
                          />
                          <Stat label="画布" value={canvasSizeLabel} />
                        </div>
                        <div className="mt-3 grid grid-cols-2 gap-2">
                          <button
                            type="button"
                            disabled={!bounds}
                            onClick={handleReopenGridControls}
                            className="h-10 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
                          >
                            微调网格
                          </button>
                          <button
                            type="button"
                            disabled={!bounds || !imageSrc || !palette.length}
                            onClick={handleEnterNextStep}
                            className="h-10 rounded bg-blue-600 px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                          >
                            进入下一步
                          </button>
                        </div>
                      </div>
                    ) : (
                      <>
                    <div className="mt-3 grid grid-cols-2 gap-2">
                      {(['auto', 'manual'] as AdjustMode[]).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => {
                            setAdjustMode(mode);
                            if (mode === 'auto') {
                              handleDetectGrid();
                            } else {
                              setIsBoundaryAdjusting(true);
                            }
                          }}
                          className={`h-9 rounded border px-3 text-sm font-medium ${
                            adjustMode === mode
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {mode === 'auto' ? '自动' : '手动'}
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3">
                      <div className="grid grid-cols-2 gap-3">
                        <label className="block text-sm font-medium text-slate-700">
                          参考列数
                          <input
                            type="number"
                            min={5}
                            max={300}
                            value={autoReferenceCols}
                            onChange={(event) => setAutoReferenceCols(event.target.value)}
                            className="mt-1 h-10 w-full rounded border border-slate-300 bg-white px-3 text-sm"
                          />
                        </label>
                        <label className="block text-sm font-medium text-slate-700">
                          参考行数
                          <input
                            type="number"
                            min={5}
                            max={300}
                            value={autoReferenceRows}
                            onChange={(event) => setAutoReferenceRows(event.target.value)}
                            className="mt-1 h-10 w-full rounded border border-slate-300 bg-white px-3 text-sm"
                          />
                        </label>
                      </div>
                      <button
                        type="button"
                        onClick={handleDetectGrid}
                        className="mt-3 h-9 w-full rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-100"
                      >
                        按参考重检
                      </button>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-3">
                      <label className="block text-sm font-medium text-slate-700">
                        网格列数
                        <input
                          type="number"
                          min={1}
                          max={300}
                          value={cols}
                          onChange={(event) => handleColsChange(event.target.value)}
                          className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm"
                        />
                      </label>
                      <label className="block text-sm font-medium text-slate-700">
                        网格行数
                        <input
                          type="number"
                          min={1}
                          max={300}
                          value={rows}
                          onChange={(event) => handleRowsChange(event.target.value)}
                          className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm"
                        />
                      </label>
                    </div>

                    <div className="mt-4 rounded border border-slate-200 bg-slate-50 p-3">
                      <div className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-slate-700">网格中心点</span>
                        <button
                          type="button"
                          disabled={!bounds}
                          onClick={alignGridCenterToCanvas}
                          className="h-8 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-100 disabled:cursor-not-allowed disabled:text-slate-300"
                        >
                          对齐画面中心
                        </button>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <label className="block text-sm font-medium text-slate-700">
                          中心 X
                          <input
                            type="number"
                            disabled={!bounds}
                            value={Math.round(gridCenter?.x ?? 0)}
                            onChange={(event) => handleGridCenterChange('x', event.target.value)}
                            className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm disabled:bg-slate-100"
                          />
                        </label>
                        <label className="block text-sm font-medium text-slate-700">
                          中心 Y
                          <input
                            type="number"
                            disabled={!bounds}
                            value={Math.round(gridCenter?.y ?? 0)}
                            onChange={(event) => handleGridCenterChange('y', event.target.value)}
                            className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm disabled:bg-slate-100"
                          />
                        </label>
                      </div>
                      <div className="mt-3 grid grid-cols-2 gap-3">
                        <label className="block text-sm font-medium text-slate-700">
                          单格宽
                          <input
                            type="number"
                            min={0.2}
                            step={0.1}
                            disabled={!bounds}
                            value={formatMeasurementForInput(gridCellSize?.width ?? 0)}
                            onChange={(event) => handleGridCellSizeChange('width', event.target.value)}
                            className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm disabled:bg-slate-100"
                          />
                        </label>
                        <label className="block text-sm font-medium text-slate-700">
                          单格高
                          <input
                            type="number"
                            min={0.2}
                            step={0.1}
                            disabled={!bounds}
                            value={formatMeasurementForInput(gridCellSize?.height ?? 0)}
                            onChange={(event) => handleGridCellSizeChange('height', event.target.value)}
                            className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm disabled:bg-slate-100"
                          />
                        </label>
                      </div>
                    </div>

                    <div className="mt-4 grid grid-cols-2 gap-2">
                      {(['grid', 'canvas'] as AdjustTarget[]).map((target) => (
                        <button
                          key={target}
                          type="button"
                          onClick={() => {
                            setAdjustMode('manual');
                            setAdjustTarget(target);
                            setIsBoundaryAdjusting(true);
                          }}
                          className={`h-9 rounded border px-3 text-sm font-medium ${
                            adjustTarget === target
                              ? 'border-slate-900 bg-slate-900 text-white'
                              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                          }`}
                        >
                          {ADJUST_TARGET_LABELS[target]}
                        </button>
                      ))}
                    </div>

                    <div className="mt-3 flex items-center justify-between gap-3">
                      <span className="text-sm font-medium text-slate-700">微调{ADJUST_TARGET_LABELS[activeAdjustmentTarget]}</span>
                      <span className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs font-medium text-slate-600">
                        当前：{BOUNDARY_HANDLE_LABELS[activeBoundaryHandle]}
                      </span>
                    </div>
                    <div className="mt-3 grid grid-cols-4 gap-2">
                      {NUDGE_DIRECTIONS.map((item) => (
                        <button
                          key={item.direction}
                          type="button"
                          disabled={!activeAdjustmentBounds}
                          onClick={() => nudgeActiveTarget(item.direction)}
                          className="h-9 rounded border border-slate-300 bg-white px-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
                        >
                          {item.label}
                        </button>
                      ))}
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-3">
                      {([
                        ['top', '上'],
                        ['bottom', '下'],
                        ['left', '左'],
                        ['right', '右'],
                      ] as Array<[keyof GridBounds, string]>).map(([key, label]) => (
                        <label key={key} className="block text-sm font-medium text-slate-700">
                          {label}
                          <input
                            type="number"
                            value={Math.round(activeAdjustmentBounds?.[key] ?? 0)}
                            onChange={(event) => handleBoundsChange(key, event.target.value)}
                            className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm"
                          />
                        </label>
                      ))}
                    </div>
                    <div className="mt-4 grid grid-cols-2 gap-2">
                      <button
                        type="button"
                        disabled={!bounds}
                        onClick={handleConfirmGrid}
                        className="h-10 rounded bg-slate-900 px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                      >
                        确认网格
                      </button>
                      <button
                        type="button"
                        disabled={!bounds || !imageSrc || !palette.length}
                        onClick={handleEnterNextStep}
                        className="h-10 rounded border border-blue-300 bg-white px-3 text-sm font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:border-slate-200 disabled:text-slate-300"
                      >
                        进入下一步
                      </button>
                    </div>
                      </>
                    )}
                  </div>

                  <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                    <h2 className="text-base font-semibold">解析设置</h2>
                    <label className="mt-3 block text-sm font-medium text-slate-700">
                      色板
                      <select
                        value={paletteName}
                        onChange={(event) => {
                          void handlePaletteNameChange(event.target.value);
                        }}
                        className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm"
                      >
                        <option value="96">MARD 96</option>
                        <option value="144">MARD 144</option>
                        <option value="291">MARD 291</option>
                      </select>
                    </label>
                    {paletteError && <p className="mt-2 text-sm text-red-600">{paletteError}</p>}
                    <label className="mt-3 flex items-center gap-2 text-sm text-slate-700">
                      <input
                        type="checkbox"
                        checked={treatWhiteAsTransparent}
                        onChange={(event) => setTreatWhiteAsTransparent(event.target.checked)}
                      />
                      近白色格子当透明
                    </label>
                    <button
                      type="button"
                      disabled={!imageSrc || !palette.length}
                      onClick={handleAnalyze}
                      className="mt-4 h-10 w-full rounded bg-blue-600 px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
                    >
                      解析图纸
                    </button>
                  </div>
                </>
              )}
            </div>

            <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
              <div className="mb-3 flex items-center justify-between gap-3">
                <h2 className="text-base font-semibold">{parseStep === 'crop' ? '裁剪预览' : '网格预览'}</h2>
                <span className="text-sm text-slate-500">{originalFileName || '未加载图片'}</span>
              </div>
              {!imageSrc && <EmptyState text="先加载图纸" />}
              <canvas
                ref={displayCanvasRef}
                onPointerDown={handleDisplayPointerDown}
                onPointerMove={handleDisplayPointerMove}
                onPointerUp={handleDisplayPointerUp}
                onPointerCancel={handleDisplayPointerUp}
                className={`${imageSrc ? 'block' : 'hidden'} max-h-[68vh] max-w-full rounded border border-slate-200 bg-white ${isBoundaryAdjusting ? 'cursor-crosshair' : ''}`}
                style={{ touchAction: isBoundaryAdjusting ? 'none' : 'auto' }}
              />
              {imageSrc && (
                <>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
                    <Stat label="自动建议" value={autoGridSizeLabel} />
                    <Stat label="当前网格" value={currentGridSizeLabel} />
                    <Stat label="画布" value={canvasSizeLabel} />
                    <Stat label="置信度" value={detectedGrid ? `${Math.round(detectedGrid.confidence * 100)}%` : '-'} />
                  </div>
                  <div className="mt-3 rounded border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
                    <div className="flex items-center justify-between gap-3">
                      <span className="font-medium">网格边界</span>
                      <span className="text-xs text-slate-500">{ADJUST_TARGET_LABELS[activeAdjustmentTarget]}</span>
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-4">
                      <span>上 {Math.round((bounds ?? cropBounds)?.top ?? 0)}</span>
                      <span>下 {Math.round((bounds ?? cropBounds)?.bottom ?? 0)}</span>
                      <span>左 {Math.round((bounds ?? cropBounds)?.left ?? 0)}</span>
                      <span>右 {Math.round((bounds ?? cropBounds)?.right ?? 0)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          </section>
        )}

        {activeTab === 'optimize' && (
          <section className="grid gap-4 lg:grid-cols-[400px_1fr]">
            <SummaryPanel
              result={displayResult}
              sortedColorCounts={sortedColorCounts}
              colorCountGroups={colorCountGroups}
              selectedColorGroupKey={selectedColorGroupKey}
              selectedCorrectionKeys={selectedCorrectionKeys}
              onSelectColorGroup={(colorKey) => {
                setSelectedColorGroupKey(colorKey);
                setIsGroupCorrectionOpen(false);
              }}
              onToggleCorrectionKey={toggleCorrectionKey}
              onCorrectColorGroup={openGroupCorrection}
              patternName={patternName}
              setPatternName={setPatternName}
              onSave={handleSave}
              isSaving={isSaving}
              saveResult={saveResult}
              onApplyPaletteRecommendations={paletteComplianceIssues.length > 0 ? handleApplyPaletteRecommendations : undefined}
            />
            <div className="flex flex-col gap-4">
              <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                  <h2 className="text-base font-semibold">图纸预览</h2>
                  <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500">
                    {selectedColorGroup && (
                      <span className="inline-flex items-center gap-2">
                        <span className="h-5 w-5 rounded border border-slate-300" style={{ backgroundColor: selectedColorGroup.hex }} />
                        {selectedColorGroup.colorKey} · {selectedColorGroup.count}
                      </span>
                    )}
                    <span>{visiblePreviewRange}</span>
                  </div>
                </div>
                {!result ? (
                  <EmptyState text="先在解析页完成图纸解析" />
                ) : (
                  <>
                    <div className="mt-3 flex flex-wrap items-center gap-2">
                      <button
                        type="button"
                        onClick={() => setPreviewZoomKeepingCenter(previewZoom - 0.25)}
                        className="h-8 rounded border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        缩小
                      </button>
                      <input
                        type="range"
                        min={50}
                        max={400}
                        step={25}
                        value={Math.round(previewZoom * 100)}
                        onChange={(event) => setPreviewZoomKeepingCenter(Number(event.target.value) / 100)}
                        className="w-40"
                      />
                      <button
                        type="button"
                        onClick={() => setPreviewZoomKeepingCenter(previewZoom + 0.25)}
                        className="h-8 rounded border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        放大
                      </button>
                      <button
                        type="button"
                        onClick={() => setPreviewZoomKeepingCenter(1)}
                        className="h-8 rounded border border-slate-300 px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                      >
                        100%
                      </button>
                      <span className="text-sm text-slate-500">{Math.round(previewZoom * 100)}%</span>
                    </div>
                    <div
                      ref={previewViewportRef}
                      onScroll={updateVisiblePreviewRange}
                      className="mt-3 max-h-[56vh] overflow-auto rounded border border-slate-200 bg-white"
                    >
                      <canvas
                        ref={previewCanvasRef}
                        onClick={handlePreviewClick}
                        className="block cursor-crosshair"
                        style={{
                          width: previewCanvasRef.current ? `${previewCanvasRef.current.width * previewZoom}px` : undefined,
                          height: previewCanvasRef.current ? `${previewCanvasRef.current.height * previewZoom}px` : undefined,
                        }}
                      />
                    </div>
                  </>
                )}
              </div>

              <ColorGroupInspector
                sourceCanvasRef={sourceCanvasRef}
                palette={palette}
                selectedGroup={selectedColorGroup}
                selectedCells={selectedColorGroupCells}
                selectedCorrectionKeys={selectedCorrectionKeys}
                isGroupCorrectionOpen={isGroupCorrectionOpen}
                groupCorrectionColorKey={groupCorrectionColorKey}
                groupCorrectionColor={groupCorrectionColor}
                onCorrectionColorChange={setGroupCorrectionColorKey}
                onApplyCorrection={() => handleGroupApply(groupCorrectionColor)}
                onApplyTransparent={() => handleGroupApply(null)}
                onCancelCorrection={() => setIsGroupCorrectionOpen(false)}
                sourceCanvasVersion={sourceCanvasVersion}
              />
            </div>
          </section>
        )}

        {activeTab === 'edit' && (
          <section className="grid gap-4 lg:grid-cols-[360px_1fr]">
            <div className="flex flex-col gap-4">
              <SummaryPanel
                result={displayResult}
                sortedColorCounts={sortedColorCounts}
                patternName={patternName}
                setPatternName={setPatternName}
                onSave={handleSave}
                isSaving={isSaving}
                saveResult={saveResult}
                onApplyPaletteRecommendations={paletteComplianceIssues.length > 0 ? handleApplyPaletteRecommendations : undefined}
              />
              <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
                <h2 className="text-base font-semibold">编辑工具</h2>
                <label className="mt-3 block text-sm font-medium text-slate-700">
                  当前颜色
                  <select
                    value={selectedColorKey}
                    onChange={(event) => setSelectedColorKey(event.target.value)}
                    className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm"
                  >
                    {palette.map((color) => (
                      <option key={color.key} value={color.key}>
                        {color.key} {color.hex}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="mt-3 flex gap-2">
                  <button
                    type="button"
                    disabled={!selectedCell || !selectedPaletteColor}
                    onClick={() => handleManualApply(selectedPaletteColor)}
                    className="h-10 flex-1 rounded bg-blue-600 px-3 text-sm font-medium text-white disabled:bg-slate-300"
                  >
                    应用颜色
                  </button>
                  <button
                    type="button"
                    disabled={!selectedCell}
                    onClick={() => handleManualApply(null)}
                    className="h-10 flex-1 rounded border border-slate-300 px-3 text-sm font-medium text-slate-700 disabled:text-slate-300"
                  >
                    设为透明
                  </button>
                </div>
                {selectedCell && (
                  <p className="mt-3 text-sm text-slate-500">
                    当前格子：R{selectedCell.row + 1} C{selectedCell.col + 1}
                  </p>
                )}
              </div>
            </div>
            <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="text-base font-semibold">编辑预览</h2>
              {!result ? (
                <EmptyState text="先在解析页完成图纸解析" />
              ) : (
                <canvas
                  ref={previewCanvasRef}
                  onClick={handlePreviewClick}
                  className="mt-3 max-h-[76vh] max-w-full cursor-crosshair rounded border border-slate-200 bg-white"
                />
              )}
            </div>
          </section>
        )}
      </div>
    </main>
  );

  async function drawImageToCanvases(dataUrl: string): Promise<GridBounds> {
    const image = await loadImage(dataUrl);
    const scale = Math.min(1, MAX_CANVAS_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const nextBounds = { left: 0, top: 0, right: width, bottom: height };

    for (const canvas of [sourceCanvasRef.current, displayCanvasRef.current]) {
      if (!canvas) continue;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      if (!ctx) continue;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(image, 0, 0, width, height);
    }

    setCanvasSize({ width, height });
    setSourceCanvasVersion((version) => version + 1);
    return nextBounds;
  }

  function cropWorkingCanvases(targetBounds: GridBounds): CropWorkingCanvasResult | null {
    const source = sourceCanvasRef.current;
    const display = displayCanvasRef.current;
    if (!source || source.width === 0 || source.height === 0) return null;

    const safeBounds = normalizeEditableBounds(targetBounds, source.width, source.height);
    const left = clampNumber(Math.floor(safeBounds.left), 0, source.width - 1);
    const top = clampNumber(Math.floor(safeBounds.top), 0, source.height - 1);
    const right = clampNumber(Math.ceil(safeBounds.right), left + 1, source.width);
    const bottom = clampNumber(Math.ceil(safeBounds.bottom), top + 1, source.height);
    const width = right - left;
    const height = bottom - top;
    const cropped = document.createElement('canvas');
    cropped.width = width;
    cropped.height = height;
    const croppedCtx = cropped.getContext('2d');
    if (!croppedCtx) return null;
    croppedCtx.drawImage(source, left, top, width, height, 0, 0, width, height);

    for (const canvas of [source, display]) {
      if (!canvas) continue;
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d', { willReadFrequently: canvas === source });
      if (!ctx) continue;
      ctx.clearRect(0, 0, width, height);
      ctx.drawImage(cropped, 0, 0);
    }

    setCanvasSize({ width, height });
    setSourceCanvasVersion((version) => version + 1);
    setBoundaryDrag(null);
    setActiveBoundaryHandle('move');

    return {
      bounds: { left: 0, top: 0, right: width, bottom: height },
      dataUrl: cropped.toDataURL('image/png'),
    };
  }
}

function SummaryPanel({
  result,
  sortedColorCounts,
  colorCountGroups = [],
  selectedColorGroupKey,
  selectedCorrectionKeys = [],
  onSelectColorGroup,
  onToggleCorrectionKey,
  onCorrectColorGroup,
  patternName,
  setPatternName,
  onSave,
  isSaving,
  saveResult,
  onApplyPaletteRecommendations,
}: {
  result: PatternAnalysisResult | null;
  sortedColorCounts: ColorCountItem[];
  colorCountGroups?: ColorCountGroup[];
  selectedColorGroupKey?: string | null;
  selectedCorrectionKeys?: string[];
  onSelectColorGroup?: (colorKey: string) => void;
  onToggleCorrectionKey?: (colorKey: string) => void;
  onCorrectColorGroup?: () => void;
  patternName: string;
  setPatternName: (value: string) => void;
  onSave: () => void;
  isSaving: boolean;
  saveResult: SaveResponse | null;
  onApplyPaletteRecommendations?: () => void;
}) {
  const extraColors = sortedColorCounts.filter((entry) => entry.isExtraColor);
  const extraBeadCount = extraColors.reduce((sum, entry) => sum + entry.count, 0);
  const groupedStats =
    colorCountGroups.length > 0
      ? colorCountGroups
      : [
          {
            label: '颜色',
            totalCount: sortedColorCounts.reduce((sum, entry) => sum + entry.count, 0),
            colors: sortedColorCounts,
          },
        ];

  return (
    <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="text-base font-semibold">图纸 JSON</h2>
      <label className="mt-3 block text-sm font-medium text-slate-700">
        图纸名称
        <input
          value={patternName}
          onChange={(event) => setPatternName(event.target.value)}
          className="mt-1 h-10 w-full rounded border border-slate-300 px-3 text-sm"
        />
      </label>
      <div className="mt-3 grid grid-cols-2 gap-2 text-center text-sm sm:grid-cols-4">
        <Stat label="尺寸" value={result ? `${result.gridDimensions.N}x${result.gridDimensions.M}` : '-'} />
        <Stat label="颜色" value={result ? String(Object.keys(result.colorCounts).length) : '-'} />
        <Stat label="总豆数" value={result ? String(result.totalBeadCount) : '-'} />
        <Stat label="方案外" value={result ? `${extraColors.length}/${extraBeadCount}` : '-'} />
      </div>
      <button
        type="button"
        disabled={!result || isSaving}
        onClick={onSave}
        className="mt-4 h-10 w-full rounded bg-emerald-600 px-3 text-sm font-medium text-white disabled:bg-slate-300"
      >
        {isSaving ? '保存中...' : '保存 .grid.json'}
      </button>
      {saveResult?.path && (
        <p className="mt-2 break-all text-xs text-emerald-700">已保存：{saveResult.path}</p>
      )}
      {saveResult?.error && (
        <p className="mt-2 break-all text-xs text-red-600">{saveResult.error}</p>
      )}

      {extraColors.length > 0 && (
        <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <span>
              当前色板外颜色 {extraColors.length} 个，共 {extraBeadCount} 颗。
            </span>
            {onApplyPaletteRecommendations && (
              <button
                type="button"
                onClick={onApplyPaletteRecommendations}
                className="h-9 rounded bg-amber-600 px-3 text-sm font-medium text-white hover:bg-amber-700"
              >
                按推荐色替换
              </button>
            )}
          </div>
        </div>
      )}

      <div className="mt-5 flex items-center justify-between gap-3">
        <h3 className="text-sm font-semibold">颜色统计</h3>
        {onCorrectColorGroup && (
          <button
            type="button"
            disabled={selectedCorrectionKeys.length === 0}
            onClick={onCorrectColorGroup}
            className="h-9 rounded bg-blue-600 px-3 text-sm font-medium text-white disabled:cursor-not-allowed disabled:bg-slate-300"
          >
            矫正选中
          </button>
        )}
      </div>
      {onCorrectColorGroup && <p className="mt-1 text-xs text-slate-500">已选 {selectedCorrectionKeys.length} 个颜色</p>}
      <div className="mt-2 max-h-[56vh] overflow-auto rounded border border-slate-100">
        {sortedColorCounts.length === 0 ? (
          <p className="p-3 text-sm text-slate-500">暂无统计</p>
        ) : (
          groupedStats.map((group) => (
            <div key={group.label} className="border-b border-slate-100 last:border-b-0">
              <div className="flex items-center justify-between bg-slate-50 px-3 py-2 text-xs font-semibold text-slate-500">
                <span>{group.label} 组</span>
                <span>{group.totalCount}</span>
              </div>
              {group.colors.map((entry) => {
                const isSelected = selectedColorGroupKey === entry.colorKey;
                const isChecked = selectedCorrectionKeys.includes(entry.colorKey);
                const rowTone = isSelected ? 'bg-amber-50' : entry.isExtraColor ? 'bg-rose-50' : 'bg-white';
                return (
                  <div
                    key={entry.hex}
                    className={`grid ${onToggleCorrectionKey ? 'grid-cols-[auto_1fr]' : 'grid-cols-1'} items-center gap-2 border-t border-slate-100 px-2 py-2 ${rowTone}`}
                  >
                    {onToggleCorrectionKey && (
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={() => onToggleCorrectionKey(entry.colorKey)}
                        className="h-4 w-4"
                        aria-label={`选择 ${entry.colorKey}`}
                      />
                    )}
                    <button
                      type="button"
                      onClick={() => onSelectColorGroup?.(entry.colorKey)}
                      className="flex min-w-0 items-center gap-2 rounded px-1 py-1 text-left text-sm hover:bg-slate-50"
                    >
                      <span className="h-6 w-6 shrink-0 rounded border border-slate-300" style={{ backgroundColor: entry.hex }} />
                      <span className="min-w-0">
                        <span className="flex items-center gap-2">
                          <span className="font-semibold">{entry.colorKey}</span>
                          <span className="text-slate-500">{entry.count}</span>
                        </span>
                        <span className="block truncate text-xs text-slate-500">
                          {entry.hex}
                          {entry.pendingCount > 0 ? ` · 待确认 ${entry.pendingCount}` : ''}
                          {entry.changedCount > 0 ? ` · 已改 ${entry.changedCount}` : ''}
                          {entry.isExtraColor ? ` · 方案外${entry.recommendedColorKey ? ` -> ${entry.recommendedColorKey}` : ''}` : ''}
                        </span>
                      </span>
                    </button>
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function ColorGroupInspector({
  sourceCanvasRef,
  palette,
  selectedGroup,
  selectedCells,
  selectedCorrectionKeys,
  isGroupCorrectionOpen,
  groupCorrectionColorKey,
  groupCorrectionColor,
  onCorrectionColorChange,
  onApplyCorrection,
  onApplyTransparent,
  onCancelCorrection,
  sourceCanvasVersion,
}: {
  sourceCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  palette: PaletteColor[];
  selectedGroup: ColorCountItem | null;
  selectedCells: PatternAnalysisResult['cells'];
  selectedCorrectionKeys: string[];
  isGroupCorrectionOpen: boolean;
  groupCorrectionColorKey: string;
  groupCorrectionColor: PaletteColor | null;
  onCorrectionColorChange: (colorKey: string) => void;
  onApplyCorrection: () => void;
  onApplyTransparent: () => void;
  onCancelCorrection: () => void;
  sourceCanvasVersion: number;
}) {
  const sampleCells = selectedCells.slice(0, 120);

  return (
    <div className="rounded border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-base font-semibold">颜色组样本</h2>
        <span className="text-sm text-slate-500">已选 {selectedCorrectionKeys.length} 个颜色</span>
      </div>

      {!selectedGroup ? (
        <EmptyState text="选择一个颜色组查看样本" />
      ) : (
        <>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-sm sm:grid-cols-4">
            <Stat label="色号" value={selectedGroup.colorKey} />
            <Stat label="数量" value={String(selectedGroup.count)} />
            <Stat label="待确认" value={String(selectedGroup.pendingCount)} />
            <Stat label="已改" value={String(selectedGroup.changedCount)} />
          </div>

          {isGroupCorrectionOpen && selectedCorrectionKeys.length > 0 && (
            <div className="mt-4 rounded border border-amber-200 bg-amber-50 p-3">
              <div className="mb-3 flex flex-wrap items-center gap-2 text-sm text-slate-700">
                <span>矫正：</span>
                {selectedCorrectionKeys.map((colorKey) => (
                  <span key={colorKey} className="rounded border border-amber-200 bg-white px-2 py-1 text-xs font-semibold">
                    {colorKey}
                  </span>
                ))}
              </div>
              <div className="grid gap-3 lg:grid-cols-[220px_1fr]">
                <label className="block text-sm font-medium text-slate-700">
                  目标颜色
                  <select
                    value={groupCorrectionColorKey}
                    onChange={(event) => onCorrectionColorChange(event.target.value)}
                    className="mt-1 h-10 w-full rounded border border-slate-300 bg-white px-3 text-sm"
                  >
                    {palette.map((color) => (
                      <option key={color.key} value={color.key}>
                        {color.key} {color.hex}
                      </option>
                    ))}
                  </select>
                </label>
                <div className="max-h-32 overflow-auto rounded border border-amber-100 bg-white p-2">
                  <div className="grid grid-cols-[repeat(auto-fill,minmax(34px,1fr))] gap-2">
                    {palette.map((color) => (
                      <button
                        key={color.key}
                        type="button"
                        title={`${color.key} ${color.hex}`}
                        onClick={() => onCorrectionColorChange(color.key)}
                        className={`h-8 rounded border ${
                          groupCorrectionColorKey === color.key ? 'border-slate-900 ring-2 ring-slate-900' : 'border-slate-300'
                        }`}
                        style={{ backgroundColor: color.hex }}
                      >
                        <span className="sr-only">{color.key}</span>
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-2 text-sm text-slate-700">
                  <span className="h-6 w-6 rounded border border-slate-300" style={{ backgroundColor: groupCorrectionColor?.hex ?? '#FFFFFF' }} />
                  {groupCorrectionColor?.key ?? '-'}
                </span>
                <button
                  type="button"
                  disabled={!groupCorrectionColor}
                  onClick={onApplyCorrection}
                  className="h-9 rounded bg-blue-600 px-3 text-sm font-medium text-white disabled:bg-slate-300"
                >
                  应用到选中
                </button>
                <button
                  type="button"
                  onClick={onApplyTransparent}
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  设为透明
                </button>
                <button
                  type="button"
                  onClick={onCancelCorrection}
                  className="h-9 rounded border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
                >
                  取消
                </button>
              </div>
            </div>
          )}

          <div className="mt-4 grid grid-cols-[repeat(auto-fill,minmax(82px,1fr))] gap-3">
            {sampleCells.map((cell) => (
              <div key={`${cell.row}-${cell.col}`} className="rounded border border-slate-200 bg-slate-50 p-2">
                <CellCrop
                  sourceCanvasRef={sourceCanvasRef}
                  crop={cell.previewCrop ?? cell.crop}
                  size={64}
                  sourceCanvasVersion={sourceCanvasVersion}
                />
                <div className="mt-1 truncate text-center text-xs text-slate-500">
                  R{cell.row + 1} C{cell.col + 1}
                </div>
                <div className="text-center text-xs text-slate-500">{Math.round(cell.confidence * 100)}%</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-slate-200 bg-slate-50 px-2 py-2">
      <div className="text-xs text-slate-500">{label}</div>
      <div className="mt-1 font-semibold">{value}</div>
    </div>
  );
}

function EmptyState({ text }: { text: string }) {
  return (
    <div className="mt-3 rounded border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-500">
      {text}
    </div>
  );
}

function CellCrop({
  sourceCanvasRef,
  crop,
  size = 56,
  sourceCanvasVersion = 0,
}: {
  sourceCanvasRef: React.RefObject<HTMLCanvasElement | null>;
  crop: { x: number; y: number; width: number; height: number };
  size?: number;
  sourceCanvasVersion?: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const source = sourceCanvasRef.current;
    const canvas = canvasRef.current;
    if (!source || !canvas) return;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(source, crop.x, crop.y, crop.width, crop.height, 0, 0, size, size);
  }, [sourceCanvasRef, crop, size, sourceCanvasVersion]);

  return <canvas ref={canvasRef} className="aspect-square w-full rounded border border-slate-200 bg-white" />;
}

function drawResultPreview(
  canvas: HTMLCanvasElement,
  result: PatternAnalysisResult,
  options: {
    selectedCell: { row: number; col: number } | null;
    highlightedColorKey?: string | null;
    previewOverride?: { sourceColorKeys: string[]; targetColor: PaletteColor | null } | null;
  }
) {
  const { N, M } = result.gridDimensions;
  const maxSide = 920;
  const cellSize = Math.max(4, Math.min(18, Math.floor(maxSide / Math.max(N, M))));
  canvas.width = N * cellSize;
  canvas.height = M * cellSize;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const previewOverrideKeySet = new Set(options.previewOverride?.sourceColorKeys ?? []);
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  for (let row = 0; row < M; row += 1) {
    for (let col = 0; col < N; col += 1) {
      const cell = result.mappedPixelData[row][col];
      const isPreviewOverride = previewOverrideKeySet.has(cell.key);
      const fillColor =
        isPreviewOverride
          ? options.previewOverride?.targetColor?.hex.toUpperCase() ?? '#F8FAFC'
          : cell.isExternal
            ? '#F1F5F9'
            : cell.color;
      ctx.fillStyle = fillColor;
      ctx.fillRect(col * cellSize, row * cellSize, cellSize, cellSize);
      if (cellSize >= 8) {
        ctx.strokeStyle = '#CBD5E1';
        ctx.strokeRect(col * cellSize + 0.5, row * cellSize + 0.5, cellSize, cellSize);
      }
      if (options.highlightedColorKey && cell.key === options.highlightedColorKey && cellSize >= 5) {
        ctx.strokeStyle = '#F59E0B';
        ctx.lineWidth = Math.max(1, Math.floor(cellSize / 5));
        ctx.strokeRect(col * cellSize + 1, row * cellSize + 1, cellSize - 2, cellSize - 2);
      }
    }
  }

  if (options.selectedCell) {
    ctx.strokeStyle = '#EF4444';
    ctx.lineWidth = Math.max(2, Math.floor(cellSize / 3));
    ctx.strokeRect(options.selectedCell.col * cellSize + 1, options.selectedCell.row * cellSize + 1, cellSize - 2, cellSize - 2);
  }
}

function drawCropOverlay(
  ctx: CanvasRenderingContext2D,
  bounds: GridBounds,
  options?: DisplayAdjustOptions
) {
  ctx.save();
  ctx.fillStyle = 'rgba(15, 23, 42, 0.28)';
  ctx.fillRect(0, 0, ctx.canvas.width, bounds.top);
  ctx.fillRect(0, bounds.bottom, ctx.canvas.width, ctx.canvas.height - bounds.bottom);
  ctx.fillRect(0, bounds.top, bounds.left, bounds.bottom - bounds.top);
  ctx.fillRect(bounds.right, bounds.top, ctx.canvas.width - bounds.right, bounds.bottom - bounds.top);
  ctx.strokeStyle = '#7C3AED';
  ctx.lineWidth = 2;
  ctx.strokeRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);

  if (options?.isAdjusting) {
    drawBoundaryHandles(ctx, bounds, options);
  }
  ctx.restore();
}

function drawGridOverlay(
  ctx: CanvasRenderingContext2D,
  bounds: GridBounds,
  cols: number,
  rows: number,
  options?: DisplayAdjustOptions,
  detectedGrid?: DetectedGrid | null
) {
  ctx.save();
  ctx.strokeStyle = '#0F172A';
  ctx.lineWidth = 2;
  ctx.strokeRect(bounds.left, bounds.top, bounds.right - bounds.left, bounds.bottom - bounds.top);
  ctx.strokeStyle = 'rgba(14, 165, 233, 0.6)';
  ctx.lineWidth = 1;
  const verticalLines = getDrawableGridLines(detectedGrid?.verticalLines, bounds.left, bounds.right);
  const horizontalLines = getDrawableGridLines(detectedGrid?.horizontalLines, bounds.top, bounds.bottom);

  if (verticalLines.length > 2 || horizontalLines.length > 2) {
    verticalLines.slice(1, -1).forEach((x) => {
      ctx.beginPath();
      ctx.moveTo(x, bounds.top);
      ctx.lineTo(x, bounds.bottom);
      ctx.stroke();
    });
    horizontalLines.slice(1, -1).forEach((y) => {
      ctx.beginPath();
      ctx.moveTo(bounds.left, y);
      ctx.lineTo(bounds.right, y);
      ctx.stroke();
    });
  } else {
    const width = bounds.right - bounds.left;
    const height = bounds.bottom - bounds.top;

    for (let col = 1; col < cols; col += 1) {
      const x = bounds.left + (width * col) / cols;
      ctx.beginPath();
      ctx.moveTo(x, bounds.top);
      ctx.lineTo(x, bounds.bottom);
      ctx.stroke();
    }
    for (let row = 1; row < rows; row += 1) {
      const y = bounds.top + (height * row) / rows;
      ctx.beginPath();
      ctx.moveTo(bounds.left, y);
      ctx.lineTo(bounds.right, y);
      ctx.stroke();
    }
  }

  drawGridCenterMarker(ctx, bounds, options?.activeHandle === 'move', detectedGrid?.geometry);

  if (options?.isAdjusting) {
    drawBoundaryHandles(ctx, bounds, options);
  }
  ctx.restore();
}

function getDrawableGridLines(lines: number[] | undefined, start: number, end: number): number[] {
  if (!lines?.length) return [];
  const clipped = lines
    .filter((line) => Number.isFinite(line) && line >= start - 0.5 && line <= end + 0.5)
    .map((line) => clampNumber(line, start, end))
    .sort((a, b) => a - b);
  return dedupeNumbers([start, ...clipped, end], 0.01);
}

function dedupeNumbers(values: number[], tolerance: number): number[] {
  const result: number[] = [];
  values.sort((a, b) => a - b).forEach((value) => {
    if (!result.length || Math.abs(value - result[result.length - 1]) > tolerance) {
      result.push(value);
    }
  });
  return result;
}

function drawGridCenterMarker(ctx: CanvasRenderingContext2D, bounds: GridBounds, isActive: boolean, geometry?: DetectedGrid['geometry']) {
  const center = geometry
    ? { x: geometry.centerX, y: geometry.centerY }
    : getBoundsCenter(bounds);
  const size = Math.max(10, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.01);
  ctx.save();
  ctx.strokeStyle = isActive ? '#F59E0B' : '#DC2626';
  ctx.fillStyle = isActive ? '#F59E0B' : '#FFFFFF';
  ctx.lineWidth = isActive ? 3 : 2;
  ctx.beginPath();
  ctx.moveTo(center.x - size, center.y);
  ctx.lineTo(center.x + size, center.y);
  ctx.moveTo(center.x, center.y - size);
  ctx.lineTo(center.x, center.y + size);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(center.x, center.y, Math.max(4, size * 0.38), 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawBoundaryHandles(
  ctx: CanvasRenderingContext2D,
  bounds: GridBounds,
  options: DisplayAdjustOptions
) {
  const points = getBoundaryHandlePoints(bounds);
  const handleRadius = Math.max(12, Math.min(ctx.canvas.width, ctx.canvas.height) * 0.012);
  ctx.font = '13px sans-serif';
  ctx.textBaseline = 'middle';
  RESIZE_BOUNDARY_HANDLES.forEach((handle) => {
    const point = points[handle];
    const isActive = options.activeHandle === handle;
    ctx.fillStyle = isActive ? '#F59E0B' : '#FFFFFF';
    ctx.strokeStyle = isActive ? '#92400E' : '#0F172A';
    ctx.lineWidth = isActive ? 3 : 2;
    ctx.beginPath();
    ctx.arc(point.x, point.y, isActive ? handleRadius + 3 : handleRadius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (isActive) {
      const label = BOUNDARY_HANDLE_LABELS[handle];
      const labelX = clampNumber(point.x + handleRadius + 6, 4, ctx.canvas.width - 48);
      const labelY = clampNumber(point.y, 14, ctx.canvas.height - 14);
      ctx.fillStyle = 'rgba(15, 23, 42, 0.82)';
      ctx.fillRect(labelX - 4, labelY - 10, 44, 20);
      ctx.fillStyle = '#FFFFFF';
      ctx.fillText(label, labelX, labelY);
    }
  });

  if (options.activeHandle === 'move') {
    const centerX = (bounds.left + bounds.right) / 2;
    const centerY = (bounds.top + bounds.bottom) / 2;
    ctx.fillStyle = 'rgba(15, 23, 42, 0.78)';
    ctx.beginPath();
    ctx.arc(centerX, centerY, handleRadius + 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('移动', centerX, centerY);
    ctx.textAlign = 'left';
  }
}

function getFirstColorKey(result: PatternAnalysisResult): string | null {
  return Object.values(result.colorCounts)
    .map((entry) => entry.colorKey)
    .sort(compareColorKeys)[0] ?? null;
}

function getColorGroupLabel(colorKey: string): string {
  return colorKey.match(/^[A-Za-z]+/)?.[0].toUpperCase() ?? '#';
}

function compareColorKeys(a: string, b: string): number {
  const parsedA = parseColorKey(a);
  const parsedB = parseColorKey(b);
  if (parsedA.prefix !== parsedB.prefix) {
    return parsedA.prefix.localeCompare(parsedB.prefix, 'en');
  }
  if (parsedA.number !== parsedB.number) {
    return parsedA.number - parsedB.number;
  }
  return a.localeCompare(b, 'en', { numeric: true });
}

function parseColorKey(colorKey: string): { prefix: string; number: number } {
  const match = /^([A-Za-z]+)\s*0*(\d+)/.exec(colorKey);
  return {
    prefix: match?.[1]?.toUpperCase() ?? colorKey.toUpperCase(),
    number: match ? Number(match[2]) : Number.MAX_SAFE_INTEGER,
  };
}

function getCanvasPoint(event: React.PointerEvent<HTMLCanvasElement>): { x: number; y: number } {
  const rect = event.currentTarget.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (event.currentTarget.width / rect.width),
    y: (event.clientY - rect.top) * (event.currentTarget.height / rect.height),
  };
}

function normalizeEditableBounds(bounds: GridBounds, width: number, height: number): GridBounds {
  const minSize = 4;
  const safeWidth = Math.max(minSize, width);
  const safeHeight = Math.max(minSize, height);
  const left = clampNumber(bounds.left, 0, safeWidth - minSize);
  const top = clampNumber(bounds.top, 0, safeHeight - minSize);
  const right = clampNumber(bounds.right, left + minSize, safeWidth);
  const bottom = clampNumber(bounds.bottom, top + minSize, safeHeight);
  return { left, top, right, bottom };
}

function getFullCanvasBounds(canvas: HTMLCanvasElement): GridBounds {
  return { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
}

function getBoundsCenter(bounds: GridBounds): { x: number; y: number } {
  return {
    x: (bounds.left + bounds.right) / 2,
    y: (bounds.top + bounds.bottom) / 2,
  };
}

function boundsFromCenterAndSize(
  center: { x: number; y: number },
  gridWidth: number,
  gridHeight: number,
  canvasWidth: number,
  canvasHeight: number
): GridBounds {
  return normalizeEditableBounds(
    {
      left: center.x - gridWidth / 2,
      top: center.y - gridHeight / 2,
      right: center.x + gridWidth / 2,
      bottom: center.y + gridHeight / 2,
    },
    canvasWidth,
    canvasHeight
  );
}

function formatMeasurementForInput(value: number): string {
  if (!Number.isFinite(value)) return '0';
  return String(Math.round(value * 100) / 100);
}

function shiftBounds(bounds: GridBounds, deltaX: number, deltaY: number, width: number, height: number): GridBounds {
  const boxWidth = bounds.right - bounds.left;
  const boxHeight = bounds.bottom - bounds.top;
  const left = clampNumber(bounds.left + deltaX, 0, Math.max(0, width - boxWidth));
  const top = clampNumber(bounds.top + deltaY, 0, Math.max(0, height - boxHeight));
  return {
    left,
    top,
    right: left + boxWidth,
    bottom: top + boxHeight,
  };
}

function getBoundaryHandlePoints(bounds: GridBounds): Record<Exclude<BoundaryHandle, 'move'>, { x: number; y: number }> {
  const centerX = (bounds.left + bounds.right) / 2;
  const centerY = (bounds.top + bounds.bottom) / 2;
  return {
    topLeft: { x: bounds.left, y: bounds.top },
    top: { x: centerX, y: bounds.top },
    topRight: { x: bounds.right, y: bounds.top },
    right: { x: bounds.right, y: (bounds.top + bounds.bottom) / 2 },
    bottomRight: { x: bounds.right, y: bounds.bottom },
    bottom: { x: (bounds.left + bounds.right) / 2, y: bounds.bottom },
    bottomLeft: { x: bounds.left, y: bounds.bottom },
    left: { x: bounds.left, y: centerY },
  };
}

function pickBoundaryHandle(
  bounds: GridBounds,
  x: number,
  y: number,
  canvasWidth: number,
  canvasHeight: number
): BoundaryHandle | null {
  const threshold = Math.max(24, Math.min(canvasWidth, canvasHeight) * 0.025);
  const center = getBoundsCenter(bounds);
  if ((center.x - x) ** 2 + (center.y - y) ** 2 <= threshold ** 2) {
    return 'move';
  }

  const points = getBoundaryHandlePoints(bounds);
  let closest: { handle: Exclude<BoundaryHandle, 'move'>; distance: number } | null = null;

  for (const handle of RESIZE_BOUNDARY_HANDLES) {
    const point = points[handle];
    const distance = (point.x - x) ** 2 + (point.y - y) ** 2;
    if (!closest || distance < closest.distance) {
      closest = { handle, distance };
    }
  }

  if (!closest || closest.distance > threshold ** 2) {
    return pickBoundaryEdge(bounds, x, y, threshold);
  }
  return closest.handle;
}

function pickBoundaryEdge(bounds: GridBounds, x: number, y: number, threshold: number): BoundaryHandle | null {
  const withinHorizontal = x >= bounds.left - threshold && x <= bounds.right + threshold;
  const withinVertical = y >= bounds.top - threshold && y <= bounds.bottom + threshold;
  if (withinHorizontal && Math.abs(y - bounds.top) <= threshold) return 'top';
  if (withinHorizontal && Math.abs(y - bounds.bottom) <= threshold) return 'bottom';
  if (withinVertical && Math.abs(x - bounds.left) <= threshold) return 'left';
  if (withinVertical && Math.abs(x - bounds.right) <= threshold) return 'right';
  return null;
}

function isPointInsideBounds(bounds: GridBounds, x: number, y: number): boolean {
  return x >= bounds.left && x <= bounds.right && y >= bounds.top && y <= bounds.bottom;
}

function boundsFromPoints(
  start: { x: number; y: number },
  current: { x: number; y: number },
  width: number,
  height: number
): GridBounds {
  return normalizeEditableBounds(
    {
      left: Math.min(start.x, current.x),
      top: Math.min(start.y, current.y),
      right: Math.max(start.x, current.x),
      bottom: Math.max(start.y, current.y),
    },
    width,
    height
  );
}

function resizeBoundsFromHandle(
  startBounds: GridBounds,
  handle: Exclude<BoundaryHandle, 'move'>,
  point: { x: number; y: number },
  width: number,
  height: number
): GridBounds {
  const next = { ...startBounds };

  if (handle === 'topLeft' || handle === 'left' || handle === 'bottomLeft') {
    next.left = point.x;
  }
  if (handle === 'topRight' || handle === 'right' || handle === 'bottomRight') {
    next.right = point.x;
  }
  if (handle === 'topLeft' || handle === 'top' || handle === 'topRight') {
    next.top = point.y;
  }
  if (handle === 'bottomLeft' || handle === 'bottom' || handle === 'bottomRight') {
    next.bottom = point.y;
  }

  return normalizeEditableBounds(next, width, height);
}

function nudgeBoundsByHandle(
  bounds: GridBounds,
  handle: Exclude<BoundaryHandle, 'move'>,
  direction: NudgeDirection,
  width: number,
  height: number
): GridBounds {
  const next = { ...bounds };
  const delta = direction === 'left' || direction === 'up' ? -1 : 1;

  if ((handle === 'topLeft' || handle === 'left' || handle === 'bottomLeft') && (direction === 'left' || direction === 'right')) {
    next.left += delta;
  }
  if ((handle === 'topRight' || handle === 'right' || handle === 'bottomRight') && (direction === 'left' || direction === 'right')) {
    next.right += delta;
  }
  if ((handle === 'topLeft' || handle === 'top' || handle === 'topRight') && (direction === 'up' || direction === 'down')) {
    next.top += delta;
  }
  if ((handle === 'bottomLeft' || handle === 'bottom' || handle === 'bottomRight') && (direction === 'up' || direction === 'down')) {
    next.bottom += delta;
  }

  return normalizeEditableBounds(next, width, height);
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function clampIntegerValue(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

async function fetchMardPalette(paletteName: string): Promise<PaletteColor[]> {
  const response = await fetch(`/api/palettes/mard?paletteName=${encodeURIComponent(paletteName)}`);
  const body = await response.json();
  if (!response.ok) {
    throw new Error(body.error || '读取色板失败');
  }

  return (body as PaletteApiResponse).colors
    .map((color) => paletteColorFromHex(color.key, color.hex))
    .filter((color): color is PaletteColor => color !== null);
}

function keepPaletteSelection(current: string, palette: PaletteColor[]): string {
  if (current && palette.some((color) => color.key === current)) {
    return current;
  }
  return palette[0]?.key || '';
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('读取图片失败'));
    reader.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('加载图片失败'));
    image.src = src;
  });
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function clampInteger(value: string, min: number, max: number): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return min;
  return Math.min(max, Math.max(min, parsed));
}

function parseOptionalGridCount(value: string): number | null {
  if (!value.trim()) return null;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 5 || parsed > 300) return null;
  return parsed;
}
