import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const PROTOTYPE_GRID_SCRIPT =
  process.env.GRID_GEOMETRY_SCRIPT ?? String.raw`C:\Users\z5308\Desktop\perler-beads\scripts\prototype_grid_geometry.py`;
const PYTHON_COMMAND = process.env.PYTHON ?? 'python';
const TEMP_ROOT_NAME = '.grid-python';

interface GridBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

interface GridGeometry {
  centerX: number;
  centerY: number;
  pitchX: number;
  pitchY: number;
  centerIsCellCenter: boolean;
}

interface PrototypeGridRequest {
  imageDataUrl?: unknown;
  crop?: unknown;
  referenceCols?: unknown;
  referenceRows?: unknown;
}

interface PrototypeGridResult {
  imageSize?: {
    width?: unknown;
    height?: unknown;
  };
  mode?: unknown;
  geometry?: Partial<GridGeometry>;
  crop?: Partial<GridBounds>;
  debug?: {
    confidence?: {
      overall?: unknown;
    };
    pitchConfidence?: {
      overall?: unknown;
    };
  };
}

interface GeneratedCell {
  row: number;
  col: number;
  x: number;
  y: number;
  width: number;
  height: number;
  visibleRatio: number;
  visibility: 'full' | 'partial';
}

export async function POST(request: NextRequest) {
  let tempDir: string | null = null;

  try {
    const body = (await request.json()) as PrototypeGridRequest;
    const imageBuffer = parseImageDataUrl(body.imageDataUrl);
    const referenceCols = normalizeGridCount(body.referenceCols);
    const referenceRows = normalizeGridCount(body.referenceRows);
    const shouldUseReference = referenceCols !== null && referenceRows !== null;

    const requestId = randomUUID();
    tempDir = path.join(process.cwd(), TEMP_ROOT_NAME, requestId);
    await mkdir(tempDir, { recursive: true });

    const imagePath = path.join(tempDir, 'input.png');
    const outputDir = tempDir;
    const jsonPath = path.join(outputDir, 'input.geometry.json');
    await writeFile(imagePath, imageBuffer);

    const args = [
      PROTOTYPE_GRID_SCRIPT,
      '--image',
      imagePath,
      '--out-dir',
      outputDir,
    ];
    if (shouldUseReference) {
      args.push('--cols', String(referenceCols), '--rows', String(referenceRows));
    }

    await runPython(args);
    const prototype = JSON.parse(await readFile(jsonPath, 'utf8')) as PrototypeGridResult;
    const imageSize = normalizeImageSize(prototype);
    const geometry = normalizeGeometry(prototype.geometry);
    const crop = normalizeCrop(body.crop, imageSize) ?? normalizeCrop(prototype.crop, imageSize) ?? {
      left: 0,
      top: 0,
      right: imageSize.width,
      bottom: imageSize.height,
    };
    const generated = generateCells(geometry, crop);
    const confidence = getConfidence(prototype);

    return NextResponse.json({
      ok: true,
      source: 'python-prototype',
      mode: typeof prototype.mode === 'string' ? prototype.mode : shouldUseReference ? 'manual' : 'auto',
      usedReference: shouldUseReference,
      ignoredPartialReference: (referenceCols !== null) !== (referenceRows !== null),
      detectedGrid: {
        bounds: crop,
        verticalLines: generated.xBoundaries,
        horizontalLines: generated.yBoundaries,
        estimatedCols: generated.cols,
        estimatedRows: generated.rows,
        geometry,
        confidence,
      },
      cells: generated.cells,
      imageSize,
      pythonCrop: normalizeCrop(prototype.crop, imageSize),
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        error: error instanceof Error ? error.message : 'Python grid detection failed',
      },
      { status: 500 }
    );
  } finally {
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function parseImageDataUrl(value: unknown): Buffer {
  if (typeof value !== 'string') {
    throw new Error('缺少 imageDataUrl');
  }
  const match = value.match(/^data:image\/(?:png|jpeg|jpg|webp);base64,([a-z0-9+/=]+)$/i);
  if (!match) {
    throw new Error('imageDataUrl 必须是图片 data URL');
  }
  return Buffer.from(match[1], 'base64');
}

function normalizeGridCount(value: unknown): number | null {
  if (value === undefined || value === null || value === '') {
    return null;
  }
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return null;
  }
  const rounded = Math.round(numeric);
  return rounded >= 5 && rounded <= 300 ? rounded : null;
}

function normalizeImageSize(result: PrototypeGridResult): { width: number; height: number } {
  const width = Number(result.imageSize?.width);
  const height = Number(result.imageSize?.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Python 没有返回有效图片尺寸');
  }
  return { width, height };
}

function normalizeGeometry(value: Partial<GridGeometry> | undefined): GridGeometry {
  const centerX = Number(value?.centerX);
  const centerY = Number(value?.centerY);
  const pitchX = Number(value?.pitchX);
  const pitchY = Number(value?.pitchY);
  if (
    !Number.isFinite(centerX) ||
    !Number.isFinite(centerY) ||
    !Number.isFinite(pitchX) ||
    !Number.isFinite(pitchY) ||
    pitchX <= 0 ||
    pitchY <= 0
  ) {
    throw new Error('Python 没有返回有效 GridGeometry');
  }

  return {
    centerX,
    centerY,
    pitchX,
    pitchY,
    centerIsCellCenter: value?.centerIsCellCenter === true,
  };
}

function normalizeCrop(value: unknown, imageSize: { width: number; height: number }): GridBounds | null {
  if (!value || typeof value !== 'object') {
    return null;
  }
  const crop = value as Partial<GridBounds>;
  const left = Number(crop.left);
  const top = Number(crop.top);
  const right = Number(crop.right);
  const bottom = Number(crop.bottom);
  if (![left, top, right, bottom].every(Number.isFinite)) {
    return null;
  }
  const safeLeft = clamp(left, 0, imageSize.width - 1);
  const safeTop = clamp(top, 0, imageSize.height - 1);
  const safeRight = clamp(right, safeLeft + 1, imageSize.width);
  const safeBottom = clamp(bottom, safeTop + 1, imageSize.height);
  return {
    left: safeLeft,
    top: safeTop,
    right: safeRight,
    bottom: safeBottom,
  };
}

function getConfidence(result: PrototypeGridResult): number {
  const confidence = Number(result.debug?.confidence?.overall ?? result.debug?.pitchConfidence?.overall);
  return Number.isFinite(confidence) ? clamp(confidence, 0, 1) : 0.5;
}

function generateCells(geometry: GridGeometry, crop: GridBounds): {
  cells: GeneratedCell[];
  cols: number;
  rows: number;
  xBoundaries: number[];
  yBoundaries: number[];
} {
  const xBoundaries = generateAxisBoundaries(crop.left, crop.right, geometry.centerX, geometry.pitchX, geometry.centerIsCellCenter);
  const yBoundaries = generateAxisBoundaries(crop.top, crop.bottom, geometry.centerY, geometry.pitchY, geometry.centerIsCellCenter);
  const cols = Math.max(0, xBoundaries.length - 1);
  const rows = Math.max(0, yBoundaries.length - 1);
  const cells: GeneratedCell[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const x = xBoundaries[col];
      const y = yBoundaries[row];
      const width = xBoundaries[col + 1] - x;
      const height = yBoundaries[row + 1] - y;
      const visibleRatio = clamp(Math.min(width / geometry.pitchX, height / geometry.pitchY), 0, 1);
      cells.push({
        row,
        col,
        x,
        y,
        width,
        height,
        visibleRatio,
        visibility: visibleRatio < 0.5 ? 'partial' : 'full',
      });
    }
  }

  return { cells, cols, rows, xBoundaries, yBoundaries };
}

function generateAxisBoundaries(
  cropStart: number,
  cropEnd: number,
  center: number,
  pitch: number,
  centerIsCellCenter: boolean
): number[] {
  const lineAnchor = centerIsCellCenter ? center - pitch / 2 : center;
  const first = Math.floor((cropStart - lineAnchor) / pitch) - 1;
  const last = Math.ceil((cropEnd - lineAnchor) / pitch) + 1;
  const boundaries = [cropStart];

  for (let index = first; index <= last; index += 1) {
    const line = lineAnchor + index * pitch;
    if (line > cropStart && line < cropEnd) {
      boundaries.push(line);
    }
  }

  boundaries.push(cropEnd);
  return dedupeSortedNumbers(boundaries.sort((a, b) => a - b), 0.01);
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function runPython(args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(PYTHON_COMMAND, args, {
      cwd: process.cwd(),
      windowsHide: true,
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];

    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.on('error', (error) => {
      reject(new Error(`无法启动 Python：${error.message}`));
    });
    child.on('close', (code) => {
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      const stderrText = Buffer.concat(stderr).toString('utf8');
      if (code === 0) {
        resolve({ stdout: stdoutText, stderr: stderrText });
        return;
      }
      reject(new Error(`Python grid detection 失败，exit ${code}: ${stderrText || stdoutText}`));
    });
  });
}
