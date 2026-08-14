import { NextRequest, NextResponse } from 'next/server';
import { mkdir, rename, writeFile } from 'fs/promises';
import path from 'path';
import crypto from 'crypto';

interface SavePatternRequest {
  name?: string;
  originalFileName?: string;
  originalImageDataUrl?: string;
  selectedColorSystem?: 'MARD';
  brand?: 'MARD';
  paletteName?: string;
  gridDimensions?: { N: number; M: number };
  mappedPixelData?: unknown;
  colorCounts?: unknown;
  totalBeadCount?: number;
  sourceType?: string;
  analysisMetadata?: Record<string, unknown>;
}

const ROOT_DIR = process.cwd();
const RESULTS_DIR = path.join(ROOT_DIR, 'results', 'patterns');
const PIC_DIR = path.join(ROOT_DIR, 'pic');

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as SavePatternRequest;
    validateRequest(body);

    const now = new Date();
    const timestamp = formatTimestamp(now);
    const id = crypto.randomUUID();
    const baseName = sanitizeFileName(body.name || stripExtension(body.originalFileName || 'pattern'));
    const fileBase = `${timestamp}_${baseName}`;
    const gridFileName = `${fileBase}.grid.json`;
    const gridPath = path.join(RESULTS_DIR, gridFileName);
    const relativeGridPath = toProjectRelativePath(gridPath);
    let originalImagePath: string | undefined;

    await Promise.all([
      mkdir(RESULTS_DIR, { recursive: true }),
      mkdir(PIC_DIR, { recursive: true }),
    ]);

    if (body.originalImageDataUrl && body.originalFileName) {
      const image = decodeDataUrl(body.originalImageDataUrl);
      const imageExt = extensionFromMime(image.mimeType) || path.extname(body.originalFileName) || '.png';
      const imageFileName = `${fileBase}_original${imageExt}`;
      const imagePath = path.join(PIC_DIR, imageFileName);
      await writeFileAtomic(imagePath, image.buffer);
      originalImagePath = toProjectRelativePath(imagePath);
    }

    const gridJson = {
      schemaVersion: 1,
      id,
      name: body.name || stripExtension(body.originalFileName || 'pattern'),
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
      originalFileName: body.originalFileName || '',
      originalImagePath: originalImagePath || '',
      selectedColorSystem: body.selectedColorSystem || 'MARD',
      brand: body.brand || 'MARD',
      paletteName: body.paletteName || '291',
      gridDimensions: body.gridDimensions,
      mappedPixelData: body.mappedPixelData,
      colorCounts: body.colorCounts,
      totalBeadCount: body.totalBeadCount,
      sourceType: body.sourceType || 'analyzed_pattern_sheet',
      analysisMetadata: {
        ...(body.analysisMetadata || {}),
        savedAt: now.toISOString(),
      },
    };

    await writeFileAtomic(gridPath, `${JSON.stringify(gridJson, null, 2)}\n`);

    return NextResponse.json({
      ok: true,
      id,
      fileName: gridFileName,
      path: relativeGridPath,
      originalImagePath,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '保存图纸失败' },
      { status: 400 }
    );
  }
}

function validateRequest(body: SavePatternRequest) {
  const dims = body.gridDimensions;
  if (!dims || !Number.isInteger(dims.N) || !Number.isInteger(dims.M) || dims.N <= 0 || dims.M <= 0) {
    throw new Error('gridDimensions 必须包含正整数 N/M');
  }
  if (!Array.isArray(body.mappedPixelData) || body.mappedPixelData.length !== dims.M) {
    throw new Error('mappedPixelData 行数和 gridDimensions.M 不匹配');
  }
  for (const row of body.mappedPixelData) {
    if (!Array.isArray(row) || row.length !== dims.N) {
      throw new Error('mappedPixelData 列数和 gridDimensions.N 不匹配');
    }
  }
  if (!body.colorCounts || typeof body.colorCounts !== 'object') {
    throw new Error('colorCounts 不能为空');
  }
  if (!Number.isInteger(body.totalBeadCount) || (body.totalBeadCount ?? -1) < 0) {
    throw new Error('totalBeadCount 必须是非负整数');
  }
}

async function writeFileAtomic(targetPath: string, content: string | Buffer) {
  const tempPath = `${targetPath}.${crypto.randomUUID()}.tmp`;
  await writeFile(tempPath, content);
  await rename(tempPath, targetPath);
}

function sanitizeFileName(input: string): string {
  const cleaned = input
    .trim()
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 80);
  return cleaned || 'pattern';
}

function stripExtension(fileName: string): string {
  return fileName.replace(/\.[^.]+$/, '');
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
  ].join('-') + '_' + [
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function decodeDataUrl(dataUrl: string): { mimeType: string; buffer: Buffer } {
  const match = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('originalImageDataUrl 格式无效');
  }
  return {
    mimeType: match[1],
    buffer: Buffer.from(match[2], 'base64'),
  };
}

function extensionFromMime(mimeType: string): string | undefined {
  switch (mimeType) {
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return undefined;
  }
}

function toProjectRelativePath(filePath: string): string {
  return path.relative(ROOT_DIR, filePath).replace(/\\/g, '/');
}
