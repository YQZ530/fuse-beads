import { NextResponse } from 'next/server';
import { readInventory, readMardColors, readMardPaletteOptions } from '@/lib/warehouseStore';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const [inventory, paletteOptions, allMardColors] = await Promise.all([
      readInventory(),
      readMardPaletteOptions(),
      readMardColors('291'),
    ]);

    return NextResponse.json({
      ok: true,
      inventory,
      paletteOptions,
      allMardColors,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '读取豆仓失败' },
      { status: 400 }
    );
  }
}
