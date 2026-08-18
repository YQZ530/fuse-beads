import {
  colorDistance,
  findClosestPaletteColor,
  hexToRgb,
  MappedPixel,
  PaletteColor,
  RgbColor,
} from './pixelation';
import { TRANSPARENT_KEY, transparentColorData } from './pixelEditingUtils';

export interface GridBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface GridGeometry {
  centerX: number;
  centerY: number;
  pitchX: number;
  pitchY: number;
  centerIsCellCenter: boolean;
}

export interface DetectedGrid {
  bounds: GridBounds;
  verticalLines: number[];
  horizontalLines: number[];
  estimatedCols: number | null;
  estimatedRows: number | null;
  geometry: GridGeometry;
  confidence: number;
}

export interface DetectGridOptions {
  bounds?: GridBounds;
  expectedCols?: number;
  expectedRows?: number;
}

export interface AnalyzedPatternCell {
  row: number;
  col: number;
  detectedText: string;
  detectedColorKey?: string;
  detectedHex?: string;
  recognitionMethod: 'background_color' | 'manual' | 'ocr_fallback';
  confidence: number;
  uncertainty: number;
  status: 'pending' | 'confirmed' | 'changed' | 'transparent';
  visibility?: 'full' | 'partial';
  visibleRatio?: number;
  recommendedColorKeys?: string[];
  crop: { x: number; y: number; width: number; height: number };
  previewCrop?: { x: number; y: number; width: number; height: number };
  sampledRgb?: RgbColor;
}

export interface ColorCountEntry {
  count: number;
  color: string;
  colorKey: string;
  isExtraColor?: boolean;
  recommendedColor?: string;
  recommendedColorKey?: string;
}

export interface PatternAnalysisResult {
  grid: DetectedGrid;
  gridDimensions: { N: number; M: number };
  mappedPixelData: MappedPixel[][];
  colorCounts: Record<string, ColorCountEntry>;
  totalBeadCount: number;
  cells: AnalyzedPatternCell[];
}

export interface PatternAnalysisOptions {
  cols: number;
  rows: number;
  palette: PaletteColor[];
  bounds?: GridBounds;
  cropInsetRatio?: number;
  minimumVisibleRatio?: number;
  transparentWhiteThreshold?: number;
  treatNearWhiteAsTransparent?: boolean;
}

export interface PaletteComplianceIssue {
  colorKey: string;
  color: string;
  count: number;
  recommendedColor: string;
  recommendedColorKey: string;
}

interface AxisScore {
  index: number;
  score: number;
}

interface AxisRange {
  start: number;
  end: number;
}

interface AxisGridFit {
  start: number;
  end: number;
  lines: number[];
  count: number;
  pitch: number;
  confidence: number;
}

interface PitchEstimate {
  pitch: number;
  confidence: number;
}

interface PhaseEstimate {
  offset: number;
  confidence: number;
}

interface PitchWindow {
  min: number;
  max: number;
}

export interface GeneratedCell {
  row: number;
  col: number;
  rect: { x: number; y: number; width: number; height: number };
  crop: { x: number; y: number; width: number; height: number };
  visibleRatio: number;
  visibility: 'full' | 'partial';
}

export interface GeneratedCellsResult {
  cells: GeneratedCell[];
  cols: number;
  rows: number;
  xBoundaries: number[];
  yBoundaries: number[];
}

export interface GenerateCellsOptions {
  cropInsetRatio?: number;
  minimumVisibleRatio?: number;
}

const DEFAULT_BOUNDS_PADDING = 2;

export function detectGridGeometry(canvas: HTMLCanvasElement, options: DetectGridOptions = {}): GridGeometry {
  return detectGridFromCanvas(canvas, options).geometry;
}

export function generateCells(
  geometry: GridGeometry,
  crop: GridBounds,
  options: GenerateCellsOptions = {}
): GeneratedCellsResult {
  const cropBounds = normalizeAnalysisBounds(crop);
  const cropInsetRatio = options.cropInsetRatio ?? 0.16;
  const minimumVisibleRatio = options.minimumVisibleRatio ?? 0.5;
  return generateCellsFromGeometry(geometry, cropBounds, cropInsetRatio, minimumVisibleRatio);
}

export function detectGridFromCanvas(canvas: HTMLCanvasElement, options: DetectGridOptions = {}): DetectedGrid {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('无法获取图像 Canvas 上下文');
  }

  const { width, height } = canvas;
  const scanBounds = options.bounds ? clampBounds(options.bounds, width, height) : { left: 0, top: 0, right: width, bottom: height };
  const scanWidth = Math.max(1, scanBounds.right - scanBounds.left);
  const scanHeight = Math.max(1, scanBounds.bottom - scanBounds.top);
  const expectedCols = normalizeExpectedGridCount(options.expectedCols);
  const expectedRows = normalizeExpectedGridCount(options.expectedRows);
  const imageData = ctx.getImageData(scanBounds.left, scanBounds.top, scanWidth, scanHeight);
  const edgeMap = createEdgeMap(imageData);
  const verticalScores = smoothScores(scoreVerticalLines(imageData, edgeMap), 2);
  const horizontalScores = smoothScores(scoreHorizontalLines(imageData, edgeMap), 2);
  const contentBounds = detectContentBounds(imageData, verticalScores, horizontalScores);
  const expectedPitchX = getExpectedPitchFromContent(contentBounds.left, contentBounds.right, expectedCols, scanWidth);
  const expectedPitchY = getExpectedPitchFromContent(contentBounds.top, contentBounds.bottom, expectedRows, scanHeight);
  const relativeVerticalLines = findLinePeaks(verticalScores, getPeakMinDistance(scanWidth, expectedCols, expectedPitchX));
  const relativeHorizontalLines = findLinePeaks(horizontalScores, getPeakMinDistance(scanHeight, expectedRows, expectedPitchY));
  const centerVerticalScores = smoothScores(
    scoreVerticalLines(imageData, edgeMap, getCenterPatchRange(scanHeight, expectedRows, expectedPitchY)),
    2
  );
  const centerHorizontalScores = smoothScores(
    scoreHorizontalLines(imageData, edgeMap, getCenterPatchRange(scanWidth, expectedCols, expectedPitchX)),
    2
  );
  const centerXRange = getCenterPatchRange(scanWidth, expectedCols, expectedPitchX);
  const centerYRange = getCenterPatchRange(scanHeight, expectedRows, expectedPitchY);
  const centerVerticalLines = findLinePeaks(centerVerticalScores, getPeakMinDistance(scanWidth, expectedCols, expectedPitchX))
    .filter((line) => line >= centerXRange.start && line <= centerXRange.end);
  const centerHorizontalLines = findLinePeaks(centerHorizontalScores, getPeakMinDistance(scanHeight, expectedRows, expectedPitchY))
    .filter((line) => line >= centerYRange.start && line <= centerYRange.end);
  const verticalFit = fitAxisGridFromCenterPatch(
    centerVerticalScores,
    centerVerticalLines,
    scanWidth,
    contentBounds.left,
    contentBounds.right,
    expectedCols,
    expectedPitchX
  );
  const horizontalFit = fitAxisGridFromCenterPatch(
    centerHorizontalScores,
    centerHorizontalLines,
    scanHeight,
    contentBounds.top,
    contentBounds.bottom,
    expectedRows,
    expectedPitchY
  );
  const fallbackRelativeVerticalLines = verticalFit?.lines ?? relativeVerticalLines;
  const fallbackRelativeHorizontalLines = horizontalFit?.lines ?? relativeHorizontalLines;
  const pitchX = verticalFit?.pitch ?? estimateMedianLineGap(fallbackRelativeVerticalLines) ?? getFallbackPitch(scanWidth, expectedCols);
  const pitchY = horizontalFit?.pitch ?? estimateMedianLineGap(fallbackRelativeHorizontalLines) ?? getFallbackPitch(scanHeight, expectedRows);
  const centerX = findAnchorLineNearCenter(
    fallbackRelativeVerticalLines.length ? fallbackRelativeVerticalLines : centerVerticalLines,
    scanWidth,
    pitchX
  ) + scanBounds.left;
  const centerY = findAnchorLineNearCenter(
    fallbackRelativeHorizontalLines.length ? fallbackRelativeHorizontalLines : centerHorizontalLines,
    scanHeight,
    pitchY
  ) + scanBounds.top;
  const geometry: GridGeometry = {
    centerX,
    centerY,
    pitchX,
    pitchY,
    centerIsCellCenter: false,
  };
  const bounds = {
    left: scanBounds.left,
    top: scanBounds.top,
    right: scanBounds.right,
    bottom: scanBounds.bottom,
  };
  const generatedBoundaries = generateGridBoundaries(geometry, bounds);
  const verticalLines = generatedBoundaries.xBoundaries;
  const horizontalLines = generatedBoundaries.yBoundaries;
  const estimatedCols = verticalLines.length >= 2
    ? verticalLines.length - 1
    : verticalFit?.count ?? null;
  const estimatedRows = horizontalLines.length >= 2
    ? horizontalLines.length - 1
    : horizontalFit?.count ?? null;
  const confidence = verticalFit || horizontalFit
    ? Math.round((((verticalFit?.confidence ?? 0.25) + (horizontalFit?.confidence ?? 0.25)) / 2) * 100) / 100
    : estimateGridConfidence(relativeVerticalLines, relativeHorizontalLines, scanWidth, scanHeight);

  return {
    bounds,
    verticalLines,
    horizontalLines,
    estimatedCols,
    estimatedRows,
    geometry,
    confidence,
  };
}

export function analyzePatternCanvas(
  canvas: HTMLCanvasElement,
  options: PatternAnalysisOptions
): PatternAnalysisResult {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('无法获取图像 Canvas 上下文');
  }
  if (!Number.isInteger(options.cols) || !Number.isInteger(options.rows) || options.cols <= 0 || options.rows <= 0) {
    throw new Error('图纸行列数必须是正整数');
  }
  if (!options.palette.length) {
    throw new Error('色板为空，无法解析图纸');
  }

  const detectedGrid = detectGridFromCanvas(canvas, {
    ...(options.bounds ? { bounds: options.bounds } : {}),
    expectedCols: options.cols,
    expectedRows: options.rows,
  });
  const cropBounds = options.bounds ? normalizeAnalysisBounds(options.bounds) : clampBounds(detectedGrid.bounds, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const cropInsetRatio = options.cropInsetRatio ?? 0.16;
  const minimumVisibleRatio = options.minimumVisibleRatio ?? 0.5;
  const generated = generateCellsFromGeometry(detectedGrid.geometry, cropBounds, cropInsetRatio, minimumVisibleRatio);
  const mappedPixelData: MappedPixel[][] = [];
  const cells: AnalyzedPatternCell[] = [];

  for (let row = 0; row < generated.rows; row += 1) {
    const mappedRow: MappedPixel[] = [];
    for (let col = 0; col < generated.cols; col += 1) {
      const generatedCell = generated.cells[row * generated.cols + col];
      const crop = generatedCell.crop;
      const previewCrop = generatedCell.rect;
      const visibleRatio = generatedCell.visibleRatio;
      const isPartial = generatedCell.visibility === 'partial';
      const sampledRgb = isPartial ? undefined : sampleDominantCellColor(imageData, crop);
      let mappedPixel: MappedPixel;
      let cell: AnalyzedPatternCell;

      if (isPartial || !sampledRgb || shouldTreatAsTransparent(sampledRgb, options)) {
        mappedPixel = { ...transparentColorData };
        cell = {
          row,
          col,
          detectedText: TRANSPARENT_KEY,
          recognitionMethod: 'background_color',
          confidence: isPartial || !sampledRgb ? 1 : 0.7,
          uncertainty: isPartial || !sampledRgb ? 0 : 0.3,
          status: 'transparent',
          visibility: isPartial ? 'partial' : 'full',
          visibleRatio,
          crop,
          previewCrop,
          sampledRgb,
        };
      } else {
        const closest = findClosestPaletteColor(sampledRgb, options.palette);
        const distance = colorDistance(sampledRgb, closest.rgb);
        const recommendations = nearestPaletteColors(sampledRgb, options.palette, 5).map((color) => color.key);
        const confidence = distanceToConfidence(distance);
        mappedPixel = {
          key: closest.key,
          color: closest.hex.toUpperCase(),
          isExternal: false,
        };
        cell = {
          row,
          col,
          detectedText: closest.key,
          detectedColorKey: closest.key,
          detectedHex: closest.hex.toUpperCase(),
          recognitionMethod: 'background_color',
          confidence,
          uncertainty: 1 - confidence,
          status: confidence >= 0.82 ? 'confirmed' : 'pending',
          visibility: 'full',
          visibleRatio,
          recommendedColorKeys: recommendations,
          crop,
          previewCrop,
          sampledRgb,
        };
      }

      mappedRow.push(mappedPixel);
      cells.push(cell);
    }
    mappedPixelData.push(mappedRow);
  }

  const { colorCounts, totalBeadCount } = recalculatePatternStats(mappedPixelData, options.palette);

  return {
    grid: {
      ...detectedGrid,
      bounds: cropBounds,
      verticalLines: generated.xBoundaries,
      horizontalLines: generated.yBoundaries,
      estimatedCols: generated.cols,
      estimatedRows: generated.rows,
    },
    gridDimensions: { N: generated.cols, M: generated.rows },
    mappedPixelData,
    colorCounts,
    totalBeadCount,
    cells,
  };
}

export function recalculatePatternStats(
  mappedPixelData: MappedPixel[][],
  palette?: PaletteColor[]
): {
  colorCounts: Record<string, ColorCountEntry>;
  totalBeadCount: number;
} {
  const colorCounts: Record<string, ColorCountEntry> = {};
  let totalBeadCount = 0;

  for (const row of mappedPixelData) {
    for (const cell of row) {
      if (!cell || cell.isExternal || cell.key === TRANSPARENT_KEY) continue;
      const hex = cell.color.toUpperCase();
      if (!colorCounts[hex]) {
        colorCounts[hex] = {
          count: 0,
          color: hex,
          colorKey: cell.key,
        };
      }
      colorCounts[hex].count += 1;
      totalBeadCount += 1;
    }
  }

  return {
    colorCounts: annotateColorCountsWithPalette(colorCounts, palette),
    totalBeadCount,
  };
}

export function annotatePatternResultForPalette(
  result: PatternAnalysisResult,
  palette: PaletteColor[]
): PatternAnalysisResult {
  const { colorCounts, totalBeadCount } = recalculatePatternStats(result.mappedPixelData, palette);
  return {
    ...result,
    colorCounts,
    totalBeadCount,
  };
}

export function getPaletteComplianceIssues(
  result: PatternAnalysisResult,
  palette: PaletteColor[]
): PaletteComplianceIssue[] {
  if (!palette.length) return [];
  const annotatedResult = annotatePatternResultForPalette(result, palette);
  return Object.values(annotatedResult.colorCounts)
    .filter((entry): entry is ColorCountEntry & { recommendedColor: string; recommendedColorKey: string } =>
      Boolean(entry.isExtraColor && entry.recommendedColor && entry.recommendedColorKey)
    )
    .map((entry) => ({
      colorKey: entry.colorKey,
      color: entry.color,
      count: entry.count,
      recommendedColor: entry.recommendedColor,
      recommendedColorKey: entry.recommendedColorKey,
    }));
}

export function remapPatternResultToPalette(
  result: PatternAnalysisResult,
  palette: PaletteColor[]
): PatternAnalysisResult {
  if (!palette.length) return result;

  const paletteByKey = buildPaletteKeyMap(palette);
  const mappedPixelData = result.mappedPixelData.map((rowData) =>
    rowData.map((cell) => {
      const replacement = getPaletteReplacement(cell, palette, paletteByKey);
      return replacement
        ? {
            key: replacement.key,
            color: replacement.hex.toUpperCase(),
            isExternal: false,
          }
        : { ...cell };
    })
  );

  const cells = result.cells.map((cell): AnalyzedPatternCell => {
    const currentPixel = result.mappedPixelData[cell.row]?.[cell.col];
    const replacement = currentPixel ? getPaletteReplacement(currentPixel, palette, paletteByKey) : null;
    if (!replacement) {
      return cloneAnalyzedPatternCell(cell);
    }

    return {
      ...cell,
      crop: { ...cell.crop },
      previewCrop: cell.previewCrop ? { ...cell.previewCrop } : undefined,
      detectedText: replacement.key,
      detectedColorKey: replacement.key,
      detectedHex: replacement.hex.toUpperCase(),
      status: 'changed',
      recognitionMethod: 'manual',
      confidence: Math.max(cell.confidence, 0.9),
      uncertainty: Math.min(cell.uncertainty, 0.1),
      recommendedColorKeys: [replacement.key],
    };
  });

  const { colorCounts, totalBeadCount } = recalculatePatternStats(mappedPixelData, palette);

  return {
    ...result,
    mappedPixelData,
    cells,
    colorCounts,
    totalBeadCount,
  };
}

export function updateAnalyzedCellColor(
  result: PatternAnalysisResult,
  row: number,
  col: number,
  color: PaletteColor | null
): PatternAnalysisResult {
  const mappedPixelData = result.mappedPixelData.map((rowData) => rowData.map((cell) => ({ ...cell })));
  const cells = result.cells.map((cell) => cloneAnalyzedPatternCell(cell));
  const target = cells.find((cell) => cell.row === row && cell.col === col);

  if (!mappedPixelData[row]?.[col] || !target) {
    return result;
  }

  if (!color) {
    mappedPixelData[row][col] = { ...transparentColorData };
    target.detectedText = TRANSPARENT_KEY;
    target.detectedColorKey = undefined;
    target.detectedHex = undefined;
    target.status = 'transparent';
    target.recognitionMethod = 'manual';
    target.confidence = 1;
    target.uncertainty = 0;
  } else {
    mappedPixelData[row][col] = {
      key: color.key,
      color: color.hex.toUpperCase(),
      isExternal: false,
    };
    target.detectedText = color.key;
    target.detectedColorKey = color.key;
    target.detectedHex = color.hex.toUpperCase();
    target.status = 'changed';
    target.recognitionMethod = 'manual';
    target.confidence = 1;
    target.uncertainty = 0;
  }

  const { colorCounts, totalBeadCount } = recalculatePatternStats(mappedPixelData);

  return {
    ...result,
    mappedPixelData,
    cells,
    colorCounts,
    totalBeadCount,
  };
}

export function updateAnalyzedColorGroup(
  result: PatternAnalysisResult,
  sourceColorKey: string,
  color: PaletteColor | null
): PatternAnalysisResult {
  return updateAnalyzedColorGroups(result, [sourceColorKey], color);
}

export function updateAnalyzedColorGroups(
  result: PatternAnalysisResult,
  sourceColorKeys: string[],
  color: PaletteColor | null
): PatternAnalysisResult {
  const sourceKeySet = new Set(sourceColorKeys);
  const mappedPixelData = result.mappedPixelData.map((rowData) =>
    rowData.map((cell) => {
      if (!cell || cell.isExternal || !sourceKeySet.has(cell.key)) {
        return { ...cell };
      }

      return color
        ? {
            key: color.key,
            color: color.hex.toUpperCase(),
            isExternal: false,
          }
        : { ...transparentColorData };
    })
  );

  const cells: AnalyzedPatternCell[] = result.cells.map((cell): AnalyzedPatternCell => {
    const currentPixel = result.mappedPixelData[cell.row]?.[cell.col];
    if (!currentPixel || currentPixel.isExternal || !sourceKeySet.has(currentPixel.key)) {
      return cloneAnalyzedPatternCell(cell);
    }

    if (!color) {
      return {
        ...cell,
        crop: { ...cell.crop },
        previewCrop: cell.previewCrop ? { ...cell.previewCrop } : undefined,
        detectedText: TRANSPARENT_KEY,
        detectedColorKey: undefined,
        detectedHex: undefined,
        status: 'transparent',
        recognitionMethod: 'manual',
        confidence: 1,
        uncertainty: 0,
      };
    }

    return {
      ...cell,
      crop: { ...cell.crop },
      previewCrop: cell.previewCrop ? { ...cell.previewCrop } : undefined,
      detectedText: color.key,
      detectedColorKey: color.key,
      detectedHex: color.hex.toUpperCase(),
      status: 'changed',
      recognitionMethod: 'manual',
      confidence: 1,
      uncertainty: 0,
    };
  });

  const { colorCounts, totalBeadCount } = recalculatePatternStats(mappedPixelData);

  return {
    ...result,
    mappedPixelData,
    cells,
    colorCounts,
    totalBeadCount,
  };
}

function cloneAnalyzedPatternCell(cell: AnalyzedPatternCell): AnalyzedPatternCell {
  return {
    ...cell,
    crop: { ...cell.crop },
    previewCrop: cell.previewCrop ? { ...cell.previewCrop } : undefined,
  };
}

function annotateColorCountsWithPalette(
  colorCounts: Record<string, ColorCountEntry>,
  palette?: PaletteColor[]
): Record<string, ColorCountEntry> {
  if (!palette?.length) {
    return Object.fromEntries(
      Object.entries(colorCounts).map(([hex, entry]) => [hex, { ...entry }])
    );
  }

  const paletteByKey = buildPaletteKeyMap(palette);
  return Object.fromEntries(
    Object.entries(colorCounts).map(([hex, entry]) => {
      if (paletteByKey.has(entry.colorKey.toUpperCase())) {
        return [hex, { ...entry }];
      }

      const recommendedColor = getClosestPaletteColorFromHex(entry.color, palette);
      return [
        hex,
        {
          ...entry,
          isExtraColor: true,
          recommendedColor: recommendedColor?.hex.toUpperCase(),
          recommendedColorKey: recommendedColor?.key,
        },
      ];
    })
  );
}

function getPaletteReplacement(
  cell: MappedPixel,
  palette: PaletteColor[],
  paletteByKey: Map<string, PaletteColor>
): PaletteColor | null {
  if (!cell || cell.isExternal || cell.key === TRANSPARENT_KEY || paletteByKey.has(cell.key.toUpperCase())) {
    return null;
  }

  return getClosestPaletteColorFromHex(cell.color, palette);
}

function getClosestPaletteColorFromHex(hex: string, palette: PaletteColor[]): PaletteColor | null {
  const rgb = hexToRgb(hex);
  if (!rgb || !palette.length) return null;
  return findClosestPaletteColor(rgb, palette);
}

function buildPaletteKeyMap(palette: PaletteColor[]): Map<string, PaletteColor> {
  return new Map(palette.map((color) => [color.key.toUpperCase(), color]));
}

function createEdgeMap(imageData: ImageData): Float32Array {
  const { width, height, data } = imageData;
  const gray = new Float32Array(width * height);
  const magnitudes = new Float32Array(width * height);

  for (let index = 0; index < width * height; index += 1) {
    const dataIndex = index * 4;
    const alpha = data[dataIndex + 3];
    gray[index] = alpha < 32 ? 255 : getLuma(data[dataIndex], data[dataIndex + 1], data[dataIndex + 2]);
  }

  const sampledMagnitudes: number[] = [];
  const sampleStep = Math.max(1, Math.floor(Math.sqrt((width * height) / 5000)));

  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const topLeft = gray[(y - 1) * width + x - 1];
      const top = gray[(y - 1) * width + x];
      const topRight = gray[(y - 1) * width + x + 1];
      const left = gray[y * width + x - 1];
      const right = gray[y * width + x + 1];
      const bottomLeft = gray[(y + 1) * width + x - 1];
      const bottom = gray[(y + 1) * width + x];
      const bottomRight = gray[(y + 1) * width + x + 1];
      const gx = -topLeft - left * 2 - bottomLeft + topRight + right * 2 + bottomRight;
      const gy = -topLeft - top * 2 - topRight + bottomLeft + bottom * 2 + bottomRight;
      const magnitude = Math.sqrt(gx * gx + gy * gy);
      magnitudes[y * width + x] = magnitude;

      if (x % sampleStep === 0 && y % sampleStep === 0) {
        sampledMagnitudes.push(magnitude);
      }
    }
  }

  const strongEdgeThreshold = Math.max(24, percentile(sampledMagnitudes, 0.78));
  const edgeMap = new Float32Array(width * height);
  for (let index = 0; index < magnitudes.length; index += 1) {
    edgeMap[index] = magnitudes[index] >= strongEdgeThreshold ? Math.min(1, magnitudes[index] / 255) : 0;
  }

  return edgeMap;
}

function scoreVerticalLines(imageData: ImageData, edgeMap: Float32Array, yRange?: AxisRange): AxisScore[] {
  const { width, height, data } = imageData;
  const scores: AxisScore[] = [];
  const yStart = clamp(Math.floor(yRange?.start ?? 0), 0, Math.max(0, height - 1));
  const yEnd = clamp(Math.ceil(yRange?.end ?? height), yStart + 1, height);
  const yStep = Math.max(1, Math.floor((yEnd - yStart) / 900));

  for (let x = 0; x < width; x += 1) {
    let score = 0;
    let samples = 0;
    for (let y = yStart; y < yEnd; y += yStep) {
      const index = (y * width + x) * 4;
      const luma = getLuma(data[index], data[index + 1], data[index + 2]);
      const alpha = data[index + 3];
      if (alpha < 32) continue;
      score += edgeMap[y * width + x] * 1.8;
      if (luma < 100) score += 0.85;
      if (x > 0) {
        const leftIndex = (y * width + x - 1) * 4;
        const leftLuma = getLuma(data[leftIndex], data[leftIndex + 1], data[leftIndex + 2]);
        score += Math.min(1, Math.abs(luma - leftLuma) / 120);
      }
      samples += 1;
    }
    scores.push({ index: x, score: samples ? score / samples : 0 });
  }

  return scores;
}

function scoreHorizontalLines(imageData: ImageData, edgeMap: Float32Array, xRange?: AxisRange): AxisScore[] {
  const { width, height, data } = imageData;
  const scores: AxisScore[] = [];
  const xStart = clamp(Math.floor(xRange?.start ?? 0), 0, Math.max(0, width - 1));
  const xEnd = clamp(Math.ceil(xRange?.end ?? width), xStart + 1, width);
  const xStep = Math.max(1, Math.floor((xEnd - xStart) / 900));

  for (let y = 0; y < height; y += 1) {
    let score = 0;
    let samples = 0;
    for (let x = xStart; x < xEnd; x += xStep) {
      const index = (y * width + x) * 4;
      const luma = getLuma(data[index], data[index + 1], data[index + 2]);
      const alpha = data[index + 3];
      if (alpha < 32) continue;
      score += edgeMap[y * width + x] * 1.8;
      if (luma < 100) score += 0.85;
      if (y > 0) {
        const aboveIndex = ((y - 1) * width + x) * 4;
        const aboveLuma = getLuma(data[aboveIndex], data[aboveIndex + 1], data[aboveIndex + 2]);
        score += Math.min(1, Math.abs(luma - aboveLuma) / 120);
      }
      samples += 1;
    }
    scores.push({ index: y, score: samples ? score / samples : 0 });
  }

  return scores;
}

function smoothScores(scores: AxisScore[], radius: number): AxisScore[] {
  return scores.map((score, index) => {
    let sum = 0;
    let count = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const neighbor = scores[index + offset];
      if (!neighbor) continue;
      sum += neighbor.score;
      count += 1;
    }
    return { index: score.index, score: count ? sum / count : score.score };
  });
}

function findLinePeaks(scores: AxisScore[], minDistance: number): number[] {
  const values = scores.map((score) => score.score);
  const mean = values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / Math.max(1, values.length);
  const stdDev = Math.sqrt(variance);
  const threshold = Math.max(mean + stdDev * 0.85, percentile(values, 0.82));
  const groups: AxisScore[][] = [];
  let current: AxisScore[] = [];

  for (const score of scores) {
    if (score.score >= threshold) {
      current.push(score);
    } else if (current.length) {
      groups.push(current);
      current = [];
    }
  }
  if (current.length) groups.push(current);

  const peaks = groups
    .map((group) => group.reduce((best, item) => (item.score > best.score ? item : best), group[0]))
    .sort((a, b) => b.score - a.score);

  const selected: number[] = [];
  for (const peak of peaks) {
    if (selected.every((existing) => Math.abs(existing - peak.index) >= minDistance)) {
      selected.push(peak.index);
    }
  }

  return selected.sort((a, b) => a - b);
}

function detectContentBounds(
  imageData: ImageData,
  verticalScores: AxisScore[],
  horizontalScores: AxisScore[]
): GridBounds {
  const { width, height } = imageData;
  const xThreshold = Math.max(0.04, percentile(verticalScores.map((score) => score.score), 0.62));
  const yThreshold = Math.max(0.04, percentile(horizontalScores.map((score) => score.score), 0.62));
  const xs = verticalScores.filter((score) => score.score >= xThreshold).map((score) => score.index);
  const ys = horizontalScores.filter((score) => score.score >= yThreshold).map((score) => score.index);

  if (!xs.length || !ys.length) {
    return { left: 0, top: 0, right: width, bottom: height };
  }

  return {
    left: Math.max(0, Math.min(...xs) - DEFAULT_BOUNDS_PADDING),
    top: Math.max(0, Math.min(...ys) - DEFAULT_BOUNDS_PADDING),
    right: Math.min(width, Math.max(...xs) + DEFAULT_BOUNDS_PADDING),
    bottom: Math.min(height, Math.max(...ys) + DEFAULT_BOUNDS_PADDING),
  };
}

function fitAxisGridFromCenterPatch(
  scores: AxisScore[],
  patchLines: number[],
  span: number,
  contentStart: number,
  contentEnd: number,
  expectedCount: number | null,
  expectedPitch: number | null
): AxisGridFit | null {
  const pitchEstimate =
    estimatePitchFromLinePeaks(patchLines, span, expectedCount, expectedPitch) ??
    estimatePitchFromScorePeriod(scores, span, expectedCount, expectedPitch);
  if (!pitchEstimate) return null;

  const phaseEstimate = findBestGridPhase(scores, pitchEstimate.pitch);
  if (!phaseEstimate) return null;

  const count = expectedCount ?? estimateGridCountFromContent(
    contentStart,
    contentEnd,
    pitchEstimate.pitch,
    phaseEstimate.offset,
    span
  );
  if (!count || count < 5 || count > 300) return null;

  const gridSpan = count * pitchEstimate.pitch;
  const preferredCenter = getPreferredAxisCenter(contentStart, contentEnd, span);
  const preferredStart = preferredCenter - gridSpan / 2;
  const phasedStart = snapCoordinateToGridLine(preferredStart, phaseEstimate.offset, pitchEstimate.pitch);
  const start = shiftGridStartIntoSpan(phasedStart, gridSpan, pitchEstimate.pitch, span);
  const end = start + gridSpan;

  return {
    start,
    end,
    lines: buildProjectedGridLines(start, pitchEstimate.pitch, count),
    count,
    pitch: pitchEstimate.pitch,
    confidence: clamp((pitchEstimate.confidence + phaseEstimate.confidence) / 2, 0, 1),
  };
}

function estimatePitchFromLinePeaks(
  lines: number[],
  span: number,
  expectedCount: number | null,
  expectedPitch: number | null
): PitchEstimate | null {
  if (lines.length < 2) return null;

  const window = getPitchWindow(span, expectedCount, expectedPitch);
  const votes = new Map<number, { weightedPitch: number; weight: number; count: number }>();

  for (let startIndex = 0; startIndex < lines.length - 1; startIndex += 1) {
    for (let endIndex = startIndex + 1; endIndex < lines.length; endIndex += 1) {
      const distance = lines[endIndex] - lines[startIndex];
      if (distance > window.max * 8) break;

      for (let multiple = 1; multiple <= 8; multiple += 1) {
        const candidate = distance / multiple;
        if (candidate < window.min || candidate > window.max) continue;
        const bucket = Math.round(candidate * 2) / 2;
        const weight = getExpectedPitchWeight(candidate, span, expectedCount, expectedPitch) / Math.sqrt(multiple);
        const current = votes.get(bucket) ?? { weightedPitch: 0, weight: 0, count: 0 };
        current.weightedPitch += candidate * weight;
        current.weight += weight;
        current.count += 1;
        votes.set(bucket, current);
      }
    }
  }

  let best: { pitch: number; weight: number; count: number } | null = null;
  for (const vote of votes.values()) {
    if (vote.weight <= 0) continue;
    const pitch = vote.weightedPitch / vote.weight;
    if (!best || vote.weight > best.weight) {
      best = { pitch, weight: vote.weight, count: vote.count };
    }
  }

  if (!best || best.count < 2) return null;

  return {
    pitch: best.pitch,
    confidence: clamp(best.weight / Math.max(3, lines.length - 1), 0.2, 0.95),
  };
}

function estimatePitchFromScorePeriod(
  scores: AxisScore[],
  span: number,
  expectedCount: number | null,
  expectedPitch: number | null
): PitchEstimate | null {
  const window = getPitchWindow(span, expectedCount, expectedPitch);
  let best: { pitch: number; score: number } | null = null;

  for (let pitch = window.min; pitch <= window.max; pitch += 0.5) {
    const phase = findBestGridPhase(scores, pitch);
    if (!phase) continue;
    const score = phase.confidence * getExpectedPitchWeight(pitch, span, expectedCount, expectedPitch);
    if (!best || score > best.score) {
      best = { pitch, score };
    }
  }

  if (!best || best.score < 0.12) return null;

  return {
    pitch: best.pitch,
    confidence: clamp(best.score, 0.15, 0.8),
  };
}

function findBestGridPhase(scores: AxisScore[], pitch: number): PhaseEstimate | null {
  if (!scores.length || pitch <= 0) return null;

  const values = normalizeAxisScoreValues(scores);
  let best: PhaseEstimate | null = null;
  const step = pitch >= 12 ? 0.5 : 0.25;

  for (let offset = 0; offset < pitch; offset += step) {
    const confidence = scoreGridPhase(values, offset, pitch);
    if (!best || confidence > best.confidence) {
      best = { offset, confidence };
    }
  }

  return best;
}

function scoreGridPhase(values: number[], offset: number, pitch: number): number {
  const span = values.length;
  const center = span / 2;
  let sum = 0;
  let weightSum = 0;

  for (let position = offset; position < span; position += pitch) {
    const centerDistance = Math.abs(position - center) / Math.max(1, center);
    const weight = 0.65 + 0.35 * (1 - clamp(centerDistance, 0, 1));
    sum += sampleAxisScore(values, position) * weight;
    weightSum += weight;
  }

  return weightSum > 0 ? sum / weightSum : 0;
}

function normalizeAxisScoreValues(scores: AxisScore[]): number[] {
  const raw = scores.map((score) => score.score);
  const baseline = percentile(raw, 0.45);
  const high = percentile(raw, 0.92);
  const scale = Math.max(0.001, high - baseline);
  return raw.map((value) => clamp((value - baseline) / scale, 0, 1));
}

function sampleAxisScore(values: number[], position: number): number {
  const leftIndex = Math.floor(position);
  const rightIndex = Math.min(values.length - 1, leftIndex + 1);
  if (leftIndex < 0 || leftIndex >= values.length) return 0;
  const mix = position - leftIndex;
  return values[leftIndex] * (1 - mix) + values[rightIndex] * mix;
}

function estimateGridCountFromContent(
  contentStart: number,
  contentEnd: number,
  pitch: number,
  offset: number,
  span: number
): number | null {
  if (pitch <= 0 || contentEnd <= contentStart) return null;
  const startLine = gridLineAtOrBefore(contentStart, offset, pitch);
  const endLine = gridLineAtOrAfter(contentEnd, offset, pitch);
  const count = Math.round((endLine - startLine) / pitch);
  if (!Number.isFinite(count)) return null;
  return clamp(Math.max(5, count), 5, Math.min(300, Math.max(5, Math.round(span / pitch) + 2)));
}

function getPreferredAxisCenter(contentStart: number, contentEnd: number, span: number): number {
  const contentSpan = contentEnd - contentStart;
  if (contentSpan >= span * 0.2 && contentSpan <= span * 0.96) {
    return (contentStart + contentEnd) / 2;
  }
  return span / 2;
}

function buildProjectedGridLines(start: number, pitch: number, count: number): number[] {
  return Array.from({ length: count + 1 }, (_, index) => start + pitch * index);
}

function generateCellsFromGeometry(
  geometry: GridGeometry,
  crop: GridBounds,
  cropInsetRatio: number,
  minimumVisibleRatio: number
): GeneratedCellsResult {
  const { xBoundaries, yBoundaries } = generateGridBoundaries(geometry, crop);
  const cols = Math.max(0, xBoundaries.length - 1);
  const rows = Math.max(0, yBoundaries.length - 1);
  const cells: GeneratedCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const rect = {
        x: xBoundaries[col],
        y: yBoundaries[row],
        width: xBoundaries[col + 1] - xBoundaries[col],
        height: yBoundaries[row + 1] - yBoundaries[row],
      };
      const visibleRatio = getGeometryCellVisibleRatio(rect, geometry);
      cells.push({
        row,
        col,
        rect,
        crop: insetCellRect(rect, cropInsetRatio),
        visibleRatio,
        visibility: visibleRatio < minimumVisibleRatio ? 'partial' : 'full',
      });
    }
  }

  return { cells, cols, rows, xBoundaries, yBoundaries };
}

function generateGridBoundaries(geometry: GridGeometry, crop: GridBounds): { xBoundaries: number[]; yBoundaries: number[] } {
  return {
    xBoundaries: generateAxisBoundaries(crop.left, crop.right, geometry.centerX, geometry.pitchX, geometry.centerIsCellCenter),
    yBoundaries: generateAxisBoundaries(crop.top, crop.bottom, geometry.centerY, geometry.pitchY, geometry.centerIsCellCenter),
  };
}

function generateAxisBoundaries(
  cropStart: number,
  cropEnd: number,
  center: number,
  pitch: number,
  centerIsCellCenter: boolean
): number[] {
  if (!Number.isFinite(cropStart) || !Number.isFinite(cropEnd) || cropEnd <= cropStart) {
    return [0, 1];
  }
  if (!Number.isFinite(center) || !Number.isFinite(pitch) || pitch <= 0) {
    return [cropStart, cropEnd];
  }

  const lineAnchor = centerIsCellCenter ? center - pitch / 2 : center;
  const kStart = Math.floor((cropStart - lineAnchor) / pitch) - 1;
  const kEnd = Math.ceil((cropEnd - lineAnchor) / pitch) + 1;
  const boundaries = [cropStart];

  for (let k = kStart; k <= kEnd; k += 1) {
    const line = lineAnchor + k * pitch;
    if (line > cropStart && line < cropEnd) {
      boundaries.push(line);
    }
  }

  boundaries.push(cropEnd);
  return dedupeSortedNumbers(boundaries.sort((a, b) => a - b), 0.01);
}

function insetCellRect(
  rect: { x: number; y: number; width: number; height: number },
  insetRatio: number
): { x: number; y: number; width: number; height: number } {
  const insetX = Math.max(0, rect.width * insetRatio);
  const insetY = Math.max(0, rect.height * insetRatio);
  return {
    x: Math.floor(rect.x + insetX),
    y: Math.floor(rect.y + insetY),
    width: Math.max(1, Math.floor(rect.width - insetX * 2)),
    height: Math.max(1, Math.floor(rect.height - insetY * 2)),
  };
}

function getGeometryCellVisibleRatio(
  rect: { width: number; height: number },
  geometry: GridGeometry
): number {
  const widthRatio = rect.width / Math.max(1, geometry.pitchX);
  const heightRatio = rect.height / Math.max(1, geometry.pitchY);
  return clamp(Math.min(widthRatio, heightRatio), 0, 1);
}

function dedupeSortedNumbers(values: number[], tolerance: number): number[] {
  const result: number[] = [];
  for (const value of values) {
    if (!result.length || Math.abs(value - result[result.length - 1]) > tolerance) {
      result.push(value);
    }
  }
  return result;
}

function snapCoordinateToGridLine(coordinate: number, offset: number, pitch: number): number {
  return offset + Math.round((coordinate - offset) / pitch) * pitch;
}

function gridLineAtOrBefore(coordinate: number, offset: number, pitch: number): number {
  return offset + Math.floor((coordinate - offset) / pitch) * pitch;
}

function gridLineAtOrAfter(coordinate: number, offset: number, pitch: number): number {
  return offset + Math.ceil((coordinate - offset) / pitch) * pitch;
}

function shiftGridStartIntoSpan(start: number, gridSpan: number, pitch: number, span: number): number {
  if (gridSpan >= span) {
    return (span - gridSpan) / 2;
  }

  let next = start;
  while (next < 0) next += pitch;
  while (next + gridSpan > span) next -= pitch;

  return clamp(next, 0, span - gridSpan);
}

function getCenterPatchRange(span: number, expectedCount: number | null, expectedPitch: number | null): AxisRange {
  const roughPitch = expectedPitch ?? (expectedCount ? span / expectedCount : span / 48);
  const minPatch = Math.min(span, 72);
  const maxPatch = Math.max(minPatch, Math.min(span, 420, span * 0.72));
  const size = clamp(roughPitch * 8, minPatch, maxPatch);
  const start = Math.max(0, (span - size) / 2);
  return { start, end: Math.min(span, start + size) };
}

function getPeakMinDistance(span: number, expectedCount: number | null, expectedPitch: number | null): number {
  const roughPitch = expectedPitch ?? (expectedCount ? span / expectedCount : span / 60);
  return Math.max(3, Math.floor(roughPitch * 0.35));
}

function getPitchWindow(span: number, expectedCount: number | null, expectedPitch: number | null): PitchWindow {
  const maxAbsolute = Math.min(96, Math.max(8, span / 2));
  const roughPitch = expectedPitch ?? (expectedCount ? span / expectedCount : null);
  if (roughPitch) {
    const min = Math.max(4, roughPitch * 0.75);
    const max = Math.min(maxAbsolute, Math.max(min + 1, roughPitch * 1.35));
    return { min, max };
  }

  return {
    min: Math.max(4, span / 180),
    max: Math.min(maxAbsolute, Math.max(18, span / 5)),
  };
}

function getExpectedPitchWeight(
  pitch: number,
  span: number,
  expectedCount: number | null,
  expectedPitch: number | null
): number {
  if (!expectedCount && !expectedPitch) return 1;
  const roughPitch = expectedPitch ?? (expectedCount ? span / expectedCount : null);
  if (!roughPitch || roughPitch <= 0) return 1;
  const ratio = pitch / roughPitch;
  if (ratio < 0.65 || ratio > 1.45) return 0.25;
  const distance = Math.abs(Math.log(ratio)) / Math.log(1.45);
  return 1 - 0.45 * clamp(distance, 0, 1);
}

function normalizeExpectedGridCount(value?: number): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 5 && value <= 300 ? value : null;
}

function getExpectedPitchFromContent(
  contentStart: number,
  contentEnd: number,
  expectedCount: number | null,
  span: number
): number | null {
  if (!expectedCount) return null;
  const contentSpan = contentEnd - contentStart;
  if (!Number.isFinite(contentSpan) || contentSpan < span * 0.35) return null;
  const pitch = contentSpan / expectedCount;
  return pitch > 2 ? pitch : null;
}

function detectLineBoundedGrid(verticalLines: number[], horizontalLines: number[]): GridBounds | null {
  if (verticalLines.length < 2 || horizontalLines.length < 2) {
    return null;
  }

  const left = verticalLines[0];
  const top = horizontalLines[0];
  const right = verticalLines[verticalLines.length - 1];
  const bottom = horizontalLines[horizontalLines.length - 1];

  if (right <= left || bottom <= top) {
    return null;
  }

  return { left, top, right, bottom };
}

function estimateGridConfidence(verticalLines: number[], horizontalLines: number[], width: number, height: number): number {
  const verticalConfidence = verticalLines.length >= 2 ? regularityConfidence(verticalLines, width) : 0.15;
  const horizontalConfidence = horizontalLines.length >= 2 ? regularityConfidence(horizontalLines, height) : 0.15;
  return Math.round(((verticalConfidence + horizontalConfidence) / 2) * 100) / 100;
}

function estimateMedianLineGap(lines: number[]): number | null {
  if (lines.length < 2) return null;
  const gaps = lines
    .slice(1)
    .map((line, index) => line - lines[index])
    .filter((gap) => Number.isFinite(gap) && gap > 0)
    .sort((a, b) => a - b);
  if (!gaps.length) return null;
  return gaps[Math.floor(gaps.length / 2)];
}

function findAnchorLineNearCenter(lines: number[], span: number, pitch: number): number {
  const center = span / 2;
  const candidates = lines.filter((line) => Number.isFinite(line));
  if (candidates.length) {
    return candidates.reduce((best, line) => (Math.abs(line - center) < Math.abs(best - center) ? line : best), candidates[0]);
  }
  if (Number.isFinite(pitch) && pitch > 0) {
    return Math.round(center / pitch) * pitch;
  }
  return center;
}

function getFallbackPitch(span: number, expectedCount: number | null): number {
  if (expectedCount && expectedCount > 0) {
    return Math.max(1, span / expectedCount);
  }
  return Math.max(1, span / 50);
}

function regularityConfidence(lines: number[], span: number): number {
  if (lines.length < 3) return 0.35;
  const gaps = lines.slice(1).map((line, index) => line - lines[index]);
  const mean = gaps.reduce((sum, gap) => sum + gap, 0) / gaps.length;
  const deviation = gaps.reduce((sum, gap) => sum + Math.abs(gap - mean), 0) / gaps.length;
  const densityBonus = Math.min(0.25, lines.length / Math.max(20, span) * 2);
  return clamp(1 - deviation / Math.max(1, mean) + densityBonus, 0, 1);
}

function getCellCrop(bounds: GridBounds, cols: number, rows: number, col: number, row: number, insetRatio: number) {
  const gridWidth = bounds.right - bounds.left;
  const gridHeight = bounds.bottom - bounds.top;
  const cellWidth = gridWidth / cols;
  const cellHeight = gridHeight / rows;
  const insetX = Math.max(1, cellWidth * insetRatio);
  const insetY = Math.max(1, cellHeight * insetRatio);
  const x = bounds.left + col * cellWidth + insetX;
  const y = bounds.top + row * cellHeight + insetY;
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    width: Math.max(1, Math.floor(cellWidth - insetX * 2)),
    height: Math.max(1, Math.floor(cellHeight - insetY * 2)),
  };
}

function sampleDominantCellColor(
  imageData: ImageData,
  crop: { x: number; y: number; width: number; height: number }
): RgbColor | undefined {
  const { width: imageWidth, height: imageHeight, data } = imageData;
  const buckets = new Map<string, { count: number; r: number; g: number; b: number }>();
  const xStart = clamp(crop.x, 0, imageWidth - 1);
  const yStart = clamp(crop.y, 0, imageHeight - 1);
  const xEnd = clamp(crop.x + crop.width, 0, imageWidth);
  const yEnd = clamp(crop.y + crop.height, 0, imageHeight);
  const xStep = Math.max(1, Math.floor((xEnd - xStart) / 18));
  const yStep = Math.max(1, Math.floor((yEnd - yStart) / 18));

  for (let y = yStart; y < yEnd; y += yStep) {
    for (let x = xStart; x < xEnd; x += xStep) {
      const index = (y * imageWidth + x) * 4;
      const alpha = data[index + 3];
      if (alpha < 32) continue;

      const r = data[index];
      const g = data[index + 1];
      const b = data[index + 2];
      const luma = getLuma(r, g, b);

      // Center text and grid lines are often near-black. Keep true dark bead cells by not discarding
      // too aggressively; only skip tiny ink-like samples when enough other samples exist.
      const bucketKey = `${Math.round(r / 16)},${Math.round(g / 16)},${Math.round(b / 16)}`;
      const bucket = buckets.get(bucketKey) ?? { count: 0, r: 0, g: 0, b: 0 };
      const weight = luma < 35 ? 0.35 : 1;
      bucket.count += weight;
      bucket.r += r * weight;
      bucket.g += g * weight;
      bucket.b += b * weight;
      buckets.set(bucketKey, bucket);
    }
  }

  let best: { count: number; r: number; g: number; b: number } | undefined;
  for (const bucket of buckets.values()) {
    if (!best || bucket.count > best.count) {
      best = bucket;
    }
  }

  if (!best || best.count <= 0) return undefined;
  return {
    r: Math.round(best.r / best.count),
    g: Math.round(best.g / best.count),
    b: Math.round(best.b / best.count),
  };
}

function nearestPaletteColors(targetRgb: RgbColor, palette: PaletteColor[], count: number): PaletteColor[] {
  return palette
    .map((color) => ({ color, distance: colorDistance(targetRgb, color.rgb) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count)
    .map((item) => item.color);
}

function shouldTreatAsTransparent(rgb: RgbColor, options: PatternAnalysisOptions): boolean {
  if (!options.treatNearWhiteAsTransparent) return false;
  const threshold = options.transparentWhiteThreshold ?? 246;
  return rgb.r >= threshold && rgb.g >= threshold && rgb.b >= threshold;
}

function distanceToConfidence(distance: number): number {
  return clamp(1 - distance / 34, 0.05, 0.99);
}

function getLuma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function percentile(values: number[], percentileValue: number): number {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(sorted.length * percentileValue)));
  return sorted[index];
}

function clampBounds(bounds: GridBounds, width: number, height: number): GridBounds {
  const left = clamp(Math.floor(bounds.left), 0, width - 1);
  const top = clamp(Math.floor(bounds.top), 0, height - 1);
  const right = clamp(Math.ceil(bounds.right), left + 1, width);
  const bottom = clamp(Math.ceil(bounds.bottom), top + 1, height);
  return { left, top, right, bottom };
}

function normalizeAnalysisBounds(bounds: GridBounds): GridBounds {
  const left = Number.isFinite(bounds.left) ? bounds.left : 0;
  const top = Number.isFinite(bounds.top) ? bounds.top : 0;
  const right = Number.isFinite(bounds.right) && bounds.right > left ? bounds.right : left + 1;
  const bottom = Number.isFinite(bounds.bottom) && bounds.bottom > top ? bounds.bottom : top + 1;
  return { left, top, right, bottom };
}

function getVisibleCellRatio(
  crop: { x: number; y: number; width: number; height: number },
  imageWidth: number,
  imageHeight: number
): number {
  const xStart = clamp(crop.x, 0, imageWidth);
  const yStart = clamp(crop.y, 0, imageHeight);
  const xEnd = clamp(crop.x + crop.width, 0, imageWidth);
  const yEnd = clamp(crop.y + crop.height, 0, imageHeight);
  const visibleArea = Math.max(0, xEnd - xStart) * Math.max(0, yEnd - yStart);
  const fullArea = Math.max(1, crop.width * crop.height);
  return clamp(visibleArea / fullArea, 0, 1);
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function rgbToHex(rgb: RgbColor): string {
  const toHex = (value: number) => value.toString(16).padStart(2, '0').toUpperCase();
  return `#${toHex(rgb.r)}${toHex(rgb.g)}${toHex(rgb.b)}`;
}

export function paletteColorFromHex(key: string, hex: string): PaletteColor | null {
  const rgb = hexToRgb(hex);
  return rgb ? { key, hex: hex.toUpperCase(), rgb } : null;
}
