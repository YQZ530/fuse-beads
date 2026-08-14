import { NextRequest, NextResponse } from 'next/server';
import { createWarehouse } from '@/lib/warehouseStore';

export const runtime = 'nodejs';

interface CreateWarehouseRequest {
  name?: string;
  paletteName?: string;
  ownedCount?: number;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CreateWarehouseRequest;
    const result = await createWarehouse({
      name: body.name || '',
      paletteName: body.paletteName || '96',
      ownedCount: Number(body.ownedCount ?? 0),
    });

    return NextResponse.json({
      ok: true,
      inventory: result.inventory,
      warehouse: result.warehouse,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '创建豆仓失败' },
      { status: 400 }
    );
  }
}
