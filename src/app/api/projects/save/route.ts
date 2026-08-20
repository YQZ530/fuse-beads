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
const HEX_COLOR_PATTERN = /^#[0-9A-F]{6}$/i;
const TRANSPARENT_KEY = 'ERASE';

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
  const countedBeads = countAndValidateMappedPixels(body.mappedPixelData);
  if (!body.colorCounts || typeof body.colorCounts !== 'object') {
    throw new Error('colorCounts 不能为空');
  }
  if (!Number.isInteger(body.totalBeadCount) || (body.totalBeadCount ?? -1) < 0) {
    throw new Error('totalBeadCount 必须是非负整数');
  }
  if (countedBeads !== body.totalBeadCount) {
    throw new Error('totalBeadCount 和 mappedPixelData 统计不一致');
  }
  validateColorCounts(body.colorCounts, body.totalBeadCount);
}

function countAndValidateMappedPixels(mappedPixelData: unknown): number {
  if (!Array.isArray(mappedPixelData)) return 0;

  let total = 0;
  mappedPixelData.forEach((row, rowIndex) => {
    if (!Array.isArray(row)) {
      throw new Error(`mappedPixelData 第 ${rowIndex + 1} 行无效`);
    }

    row.forEach((cell, colIndex) => {
      if (!cell || typeof cell !== 'object') {
        throw new Error(`mappedPixelData 第 ${rowIndex + 1} 行第 ${colIndex + 1} 列格子无效`);
      }

      const mappedCell = cell as { key?: unknown; color?: unknown; isExternal?: unknown };
      if (typeof mappedCell.key !== 'string' || !mappedCell.key.trim()) {
        throw new Error(`mappedPixelData 第 ${rowIndex + 1} 行第 ${colIndex + 1} 列缺少 key`);
      }
      if (typeof mappedCell.color !== 'string' || !HEX_COLOR_PATTERN.test(mappedCell.color)) {
        throw new Error(`mappedPixelData 第 ${rowIndex + 1} 行第 ${colIndex + 1} 列 color 格式无效`);
      }
      if (mappedCell.isExternal !== undefined && typeof mappedCell.isExternal !== 'boolean') {
        throw new Error(`mappedPixelData 第 ${rowIndex + 1} 行第 ${colIndex + 1} 列 isExternal 必须是 boolean`);
      }

      if (!mappedCell.isExternal && mappedCell.key !== TRANSPARENT_KEY) {
        total += 1;
      }
    });
  });

  return total;
}

function validateColorCounts(colorCounts: unknown, totalBeadCount: number) {
  if (!colorCounts || typeof colorCounts !== 'object' || Array.isArray(colorCounts)) {
    throw new Error('colorCounts 格式无效');
  }

  let countedTotal = 0;
  for (const [hex, entry] of Object.entries(colorCounts as Record<string, unknown>)) {
    if (!HEX_COLOR_PATTERN.test(hex)) {
      throw new Error(`colorCounts key ${hex} 不是有效 hex`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`colorCounts ${hex} 格式无效`);
    }

    const colorEntry = entry as {
      count?: unknown;
      color?: unknown;
      colorKey?: unknown;
      isExtraColor?: unknown;
      recommendedColor?: unknown;
      recommendedColorKey?: unknown;
    };
    if (!Number.isInteger(colorEntry.count) || (colorEntry.count as number) <= 0) {
      throw new Error(`colorCounts ${hex} count 必须是正整数`);
    }
    if (typeof colorEntry.color !== 'string' || colorEntry.color.toUpperCase() !== hex.toUpperCase()) {
      throw new Error(`colorCounts ${hex} color 不匹配`);
    }
    if (typeof colorEntry.colorKey !== 'string' || !colorEntry.colorKey.trim()) {
      throw new Error(`colorCounts ${hex} 缺少 colorKey`);
    }
    if (colorEntry.isExtraColor !== undefined && typeof colorEntry.isExtraColor !== 'boolean') {
      throw new Error(`colorCounts ${hex} isExtraColor 必须是 boolean`);
    }
    if (
      colorEntry.recommendedColor !== undefined &&
      (typeof colorEntry.recommendedColor !== 'string' || !HEX_COLOR_PATTERN.test(colorEntry.recommendedColor))
    ) {
      throw new Error(`colorCounts ${hex} recommendedColor 格式无效`);
    }
    if (
      colorEntry.recommendedColorKey !== undefined &&
      (typeof colorEntry.recommendedColorKey !== 'string' || !colorEntry.recommendedColorKey.trim())
    ) {
      throw new Error(`colorCounts ${hex} recommendedColorKey 格式无效`);
    }

    countedTotal += colorEntry.count as number;
  }

  if (countedTotal !== totalBeadCount) {
    throw new Error('colorCounts 统计和 totalBeadCount 不一致');
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
