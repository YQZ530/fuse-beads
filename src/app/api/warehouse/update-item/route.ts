import { NextRequest, NextResponse } from 'next/server';
import { updateWarehouseItem } from '@/lib/warehouseStore';

export const runtime = 'nodejs';

interface UpdateWarehouseItemRequest {
  warehouseId?: string;
  colorKey?: string;
  ownedCount?: number;
  note?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as UpdateWarehouseItemRequest;
    const inventory = await updateWarehouseItem({
      warehouseId: body.warehouseId || '',
      colorKey: body.colorKey || '',
      ownedCount: Number(body.ownedCount ?? 0),
      note: body.note,
    });

    return NextResponse.json({
      ok: true,
      inventory,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '更新库存失败' },
      { status: 400 }
    );
  }
}
