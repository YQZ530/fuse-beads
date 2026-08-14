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

export interface DetectedGrid {
  bounds: GridBounds;
  verticalLines: number[];
  horizontalLines: number[];
  estimatedCols: number | null;
  estimatedRows: number | null;
  confidence: number;
}

export interface DetectGridOptions {
  bounds?: GridBounds;
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
  recommendedColorKeys?: string[];
  crop: { x: number; y: number; width: number; height: number };
  previewCrop?: { x: number; y: number; width: number; height: number };
  sampledRgb?: RgbColor;
}

export interface ColorCountEntry {
  count: number;
  color: string;
  colorKey: string;
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
  transparentWhiteThreshold?: number;
  treatNearWhiteAsTransparent?: boolean;
}

interface AxisScore {
  index: number;
  score: number;
}

const DEFAULT_BOUNDS_PADDING = 2;

export function detectGridFromCanvas(canvas: HTMLCanvasElement, options: DetectGridOptions = {}): DetectedGrid {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) {
    throw new Error('无法获取图像 Canvas 上下文');
  }

  const { width, height } = canvas;
  const scanBounds = options.bounds ? clampBounds(options.bounds, width, height) : { left: 0, top: 0, right: width, bottom: height };
  const scanWidth = Math.max(1, scanBounds.right - scanBounds.left);
  const scanHeight = Math.max(1, scanBounds.bottom - scanBounds.top);
  const imageData = ctx.getImageData(scanBounds.left, scanBounds.top, scanWidth, scanHeight);
  const edgeMap = createEdgeMap(imageData);
  const verticalScores = smoothScores(scoreVerticalLines(imageData, edgeMap), 2);
  const horizontalScores = smoothScores(scoreHorizontalLines(imageData, edgeMap), 2);
  const relativeVerticalLines = findLinePeaks(verticalScores, Math.max(4, Math.floor(scanWidth / 220)));
  const relativeHorizontalLines = findLinePeaks(horizontalScores, Math.max(4, Math.floor(scanHeight / 220)));
  const relativeBounds = detectContentBounds(imageData, verticalScores, horizontalScores);
  const verticalLines = relativeVerticalLines.map((line) => line + scanBounds.left);
  const horizontalLines = relativeHorizontalLines.map((line) => line + scanBounds.top);
  const bounds = {
    left: relativeBounds.left + scanBounds.left,
    top: relativeBounds.top + scanBounds.top,
    right: relativeBounds.right + scanBounds.left,
    bottom: relativeBounds.bottom + scanBounds.top,
  };

  const estimatedCols = verticalLines.length >= 2 ? verticalLines.length - 1 : null;
  const estimatedRows = horizontalLines.length >= 2 ? horizontalLines.length - 1 : null;
  const confidence = estimateGridConfidence(relativeVerticalLines, relativeHorizontalLines, scanWidth, scanHeight);

  return {
    bounds,
    verticalLines,
    horizontalLines,
    estimatedCols,
    estimatedRows,
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

  const detectedGrid = detectGridFromCanvas(canvas, options.bounds ? { bounds: options.bounds } : {});
  const bounds = clampBounds(options.bounds ?? detectedGrid.bounds, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const cropInsetRatio = options.cropInsetRatio ?? 0.16;
  const mappedPixelData: MappedPixel[][] = [];
  const cells: AnalyzedPatternCell[] = [];

  for (let row = 0; row < options.rows; row += 1) {
    const mappedRow: MappedPixel[] = [];
    for (let col = 0; col < options.cols; col += 1) {
      const crop = getCellCrop(bounds, options.cols, options.rows, col, row, cropInsetRatio);
      const previewCrop = getCellCrop(bounds, options.cols, options.rows, col, row, 0);
      const sampledRgb = sampleDominantCellColor(imageData, crop);
      let mappedPixel: MappedPixel;
      let cell: AnalyzedPatternCell;

      if (!sampledRgb || shouldTreatAsTransparent(sampledRgb, options)) {
        mappedPixel = { ...transparentColorData };
        cell = {
          row,
          col,
          detectedText: TRANSPARENT_KEY,
          recognitionMethod: 'background_color',
          confidence: sampledRgb ? 0.7 : 1,
          uncertainty: sampledRgb ? 0.3 : 0,
          status: 'transparent',
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

  const { colorCounts, totalBeadCount } = recalculatePatternStats(mappedPixelData);

  return {
    grid: {
      ...detectedGrid,
      bounds,
    },
    gridDimensions: { N: options.cols, M: options.rows },
    mappedPixelData,
    colorCounts,
    totalBeadCount,
    cells,
  };
}

export function recalculatePatternStats(
  mappedPixelData: MappedPixel[][]
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

  return { colorCounts, totalBeadCount };
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

function scoreVerticalLines(imageData: ImageData, edgeMap: Float32Array): AxisScore[] {
  const { width, height, data } = imageData;
  const scores: AxisScore[] = [];
  const yStep = Math.max(1, Math.floor(height / 900));

  for (let x = 0; x < width; x += 1) {
    let score = 0;
    let samples = 0;
    for (let y = 0; y < height; y += yStep) {
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

function scoreHorizontalLines(imageData: ImageData, edgeMap: Float32Array): AxisScore[] {
  const { width, height, data } = imageData;
  const scores: AxisScore[] = [];
  const xStep = Math.max(1, Math.floor(width / 900));

  for (let y = 0; y < height; y += 1) {
    let score = 0;
    let samples = 0;
    for (let x = 0; x < width; x += xStep) {
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

function estimateGridConfidence(verticalLines: number[], horizontalLines: number[], width: number, height: number): number {
  const verticalConfidence = verticalLines.length >= 2 ? regularityConfidence(verticalLines, width) : 0.15;
  const horizontalConfidence = horizontalLines.length >= 2 ? regularityConfidence(horizontalLines, height) : 0.15;
  return Math.round(((verticalConfidence + horizontalConfidence) / 2) * 100) / 100;
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
