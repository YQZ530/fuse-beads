import { NextRequest, NextResponse } from 'next/server';
import { readFile } from 'fs/promises';
import path from 'path';

type ColorMapping = Record<string, { MARD?: string }>;

const ROOT_DIR = process.cwd();
const PALETTE_SETS_PATH = path.join(ROOT_DIR, 'src', 'data', 'mardPaletteSets.csv');
const COLOR_MAPPING_PATH = path.join(ROOT_DIR, 'src', 'app', 'colorSystemMapping.json');
const SUPPORTED_MARD_PALETTES = new Set(['96', '144', '291']);

export async function GET(request: NextRequest) {
  try {
    const paletteName = request.nextUrl.searchParams.get('paletteName') || '291';
    if (!SUPPORTED_MARD_PALETTES.has(paletteName)) {
      throw new Error(`MARD ${paletteName} 色板暂不支持，当前支持 96、144、291`);
    }

    const [paletteSetsCsv, colorMappingText] = await Promise.all([
      readFile(PALETTE_SETS_PATH, 'utf8'),
      readFile(COLOR_MAPPING_PATH, 'utf8'),
    ]);
    const colorMapping = JSON.parse(colorMappingText) as ColorMapping;
    const colorCodes = findPaletteCodes(paletteSetsCsv, 'MARD', paletteName);
    const keyToHex = buildMardKeyToHex(colorMapping);
    const colors = colorCodes.map((key) => {
      const hex = keyToHex.get(key);
      if (!hex) {
        throw new Error(`MARD 色号 ${key} 缺少 hex 映射`);
      }
      return { key, hex };
    });

    return NextResponse.json({
      brand: 'MARD',
      paletteName,
      availablePalettes: listSupportedPaletteOptions(paletteSetsCsv, 'MARD'),
      colors,
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '读取 MARD 色板失败' },
      { status: 400 }
    );
  }
}

function findPaletteCodes(csv: string, brand: string, paletteName: string): string[] {
  const lines = csv.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const brandIndex = header.indexOf('brand');
  const paletteIndex = header.indexOf('paletteName');
  const codesIndex = header.indexOf('colorCodes');

  for (const line of lines.slice(1)) {
    const cells = parseCsvLine(line);
    if (cells[brandIndex] === brand && cells[paletteIndex] === paletteName) {
      return cells[codesIndex].trim().split(/\s+/).filter(Boolean);
    }
  }

  throw new Error(`找不到 ${brand} ${paletteName} 色板`);
}

function listSupportedPaletteOptions(csv: string, brand: string): Array<{ paletteName: string; colorCount: number }> {
  const lines = csv.trim().split(/\r?\n/);
  const header = parseCsvLine(lines[0]);
  const brandIndex = header.indexOf('brand');
  const paletteIndex = header.indexOf('paletteName');
  const colorCountIndex = header.indexOf('colorCount');

  return lines
    .slice(1)
    .map((line) => parseCsvLine(line))
    .filter((cells) => cells[brandIndex] === brand && SUPPORTED_MARD_PALETTES.has(cells[paletteIndex]))
    .map((cells) => ({
      paletteName: cells[paletteIndex],
      colorCount: Number.parseInt(cells[colorCountIndex], 10),
    }))
    .sort((a, b) => a.colorCount - b.colorCount);
}

function buildMardKeyToHex(colorMapping: ColorMapping): Map<string, string> {
  const keyToHex = new Map<string, string>();
  for (const [hex, systems] of Object.entries(colorMapping)) {
    const key = systems.MARD;
    if (!key) continue;
    if (keyToHex.has(key)) {
      throw new Error(`MARD 色号重复：${key}`);
    }
    keyToHex.set(key, hex.toUpperCase());
  }
  return keyToHex;
}

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current);
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current);
  return values;
}
