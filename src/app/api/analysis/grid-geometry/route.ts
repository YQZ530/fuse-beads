import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import { mkdir, readFile, rm, writeFile } from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';

export const runtime = 'nodejs';

const PROTOTYPE_GRID_SCRIPT =
  process.env.GRID_GEOMETRY_SCRIPT ?? path.join(process.cwd(), 'scripts', 'prototype_grid_geometry_v2.py');
const PYTHON_COMMAND = process.env.PYTHON ?? 'python';
const TEMP_ROOT_NAME = '.grid-python';
const DEFAULT_BOARD_SIZE = 52;

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
  gridSize?: unknown;
  boardSize?: unknown;
  useCrop?: unknown;
}

interface PrototypeGridResult {
  imageSize?: {
    width?: unknown;
    height?: unknown;
  };
  mode?: unknown;
  geometry?: Partial<GridGeometry>;
  crop?: Partial<GridBounds>;
  grid?: {
    rows?: unknown;
    cols?: unknown;
    gridSize?: unknown;
  };
  debug?: {
    confidence?: {
      overall?: unknown;
    };
    pitchConfidence?: {
      overall?: unknown;
    };
  };
}

export async function POST(request: NextRequest) {
  let tempDir: string | null = null;

  try {
    const body = (await request.json()) as PrototypeGridRequest;
    const imageBuffer = parseImageDataUrl(body.imageDataUrl);
    const boardSize = normalizeBoardSize(body.gridSize ?? body.boardSize);
    const shouldUseCrop = body.useCrop === true;

    const requestId = randomUUID();
    tempDir = path.join(process.cwd(), TEMP_ROOT_NAME, requestId);
    await mkdir(tempDir, { recursive: true });

    const imagePath = path.join(tempDir, 'input.png');
    const outputDir = tempDir;
    const jsonPath = path.join(outputDir, 'input.geometry.v2.json');
    await writeFile(imagePath, imageBuffer);

    const args = [
      PROTOTYPE_GRID_SCRIPT,
      '--image',
      imagePath,
      '--out-dir',
      outputDir,
      '--grid-size',
      String(boardSize),
    ];

    await runPython(args);
    const prototype = JSON.parse(await readFile(jsonPath, 'utf8')) as PrototypeGridResult;
    const imageSize = normalizeImageSize(prototype);
    const geometry = normalizeGeometry(prototype.geometry);
    const requestCrop = normalizeCrop(body.crop, imageSize);
    const prototypeCrop = normalizeCrop(prototype.crop, imageSize);
    const crop = getFixedGridBounds(geometry, boardSize);
    const generated = generateFixedGrid(geometry, boardSize);
    const confidence = getConfidence(prototype);

    return NextResponse.json({
      ok: true,
      source: 'python-prototype',
      mode: typeof prototype.mode === 'string' ? prototype.mode : 'text-lattice-v2',
      boardSize,
      usedReference: false,
      usedCrop: shouldUseCrop,
      ignoredPartialReference: false,
      detectedGrid: {
        bounds: crop,
        verticalLines: generated.xBoundaries,
        horizontalLines: generated.yBoundaries,
        estimatedCols: generated.cols,
        estimatedRows: generated.rows,
        geometry,
        confidence,
      },
      imageSize,
      pythonCrop: prototypeCrop ?? requestCrop,
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

function normalizeBoardSize(value: unknown): 52 | 104 {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return DEFAULT_BOARD_SIZE;
  }
  const rounded = Math.round(numeric);
  return rounded === 104 ? 104 : DEFAULT_BOARD_SIZE;
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

function getFixedGridBounds(geometry: GridGeometry, boardSize: number): GridBounds {
  const left = geometry.centerX - geometry.pitchX / 2;
  const top = geometry.centerY - geometry.pitchY / 2;
  return {
    left,
    top,
    right: left + geometry.pitchX * boardSize,
    bottom: top + geometry.pitchY * boardSize,
  };
}

function generateFixedGrid(
  geometry: GridGeometry,
  boardSize: number
): {
  cols: number;
  rows: number;
  xBoundaries: number[];
  yBoundaries: number[];
} {
  const xBoundaries = generateFixedAxisBoundaries(geometry.centerX, geometry.pitchX, boardSize, geometry.centerIsCellCenter);
  const yBoundaries = generateFixedAxisBoundaries(geometry.centerY, geometry.pitchY, boardSize, geometry.centerIsCellCenter);
  return { cols: boardSize, rows: boardSize, xBoundaries, yBoundaries };
}

function generateFixedAxisBoundaries(
  center: number,
  pitch: number,
  boardSize: number,
  centerIsCellCenter: boolean
): number[] {
  const lineAnchor = centerIsCellCenter ? center - pitch / 2 : center;
  const boundaries: number[] = [];

  for (let index = 0; index <= boardSize; index += 1) {
    boundaries.push(lineAnchor + index * pitch);
  }

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
