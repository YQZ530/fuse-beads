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
  grid?: DetectedGrid;
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

  const fallbackBounds = { left: 0, top: 0, right: canvas.width, bottom: canvas.height };
  const cropBounds = options.bounds
    ? clampBounds(normalizeAnalysisBounds(options.bounds), canvas.width, canvas.height)
    : options.grid
      ? clampBounds(options.grid.bounds, canvas.width, canvas.height)
      : fallbackBounds;
  const detectedGrid = options.grid
    ? {
        ...options.grid,
        bounds: cropBounds,
      }
    : buildManualDetectedGrid(cropBounds, options.cols, options.rows);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const cropInsetRatio = options.cropInsetRatio ?? 0.16;
  const minimumVisibleRatio = options.minimumVisibleRatio ?? 0.5;
  const generated =
    options.grid && options.grid.verticalLines.length > 1 && options.grid.horizontalLines.length > 1
      ? generateCellsFromBoundaryLines(options.grid.verticalLines, options.grid.horizontalLines, cropBounds, cropInsetRatio, minimumVisibleRatio)
      : generateCellsFromGeometry(detectedGrid.geometry, cropBounds, cropInsetRatio, minimumVisibleRatio);
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

function buildManualDetectedGrid(bounds: GridBounds, cols: number, rows: number): DetectedGrid {
  const pitchX = Math.max(1, (bounds.right - bounds.left) / Math.max(1, cols));
  const pitchY = Math.max(1, (bounds.bottom - bounds.top) / Math.max(1, rows));
  const geometry: GridGeometry = {
    centerX: bounds.left,
    centerY: bounds.top,
    pitchX,
    pitchY,
    centerIsCellCenter: false,
  };
  const { xBoundaries, yBoundaries } = generateGridBoundaries(geometry, bounds);

  return {
    bounds,
    verticalLines: xBoundaries,
    horizontalLines: yBoundaries,
    estimatedCols: cols,
    estimatedRows: rows,
    geometry,
    confidence: 1,
  };
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

function generateCellsFromBoundaryLines(
  xBoundaries: number[],
  yBoundaries: number[],
  visibleBounds: GridBounds,
  cropInsetRatio: number,
  minimumVisibleRatio: number
): GeneratedCellsResult {
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
      const visibleRatio = getRectVisibleRatio(rect, visibleBounds);
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

function getRectVisibleRatio(
  rect: { x: number; y: number; width: number; height: number },
  visibleBounds: GridBounds
): number {
  const left = Math.max(rect.x, visibleBounds.left);
  const top = Math.max(rect.y, visibleBounds.top);
  const right = Math.min(rect.x + rect.width, visibleBounds.right);
  const bottom = Math.min(rect.y + rect.height, visibleBounds.bottom);
  const visibleArea = Math.max(0, right - left) * Math.max(0, bottom - top);
  const totalArea = Math.max(1, rect.width * rect.height);
  return clamp(visibleArea / totalArea, 0, 1);
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
