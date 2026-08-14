import { NextRequest, NextResponse } from 'next/server';
import { replenishWarehouse } from '@/lib/warehouseStore';

export const runtime = 'nodejs';

interface ReplenishWarehouseRequest {
  warehouseId?: string;
  entries?: Array<{ colorKey?: string; count?: number }>;
  note?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as ReplenishWarehouseRequest;
    const inventory = await replenishWarehouse({
      warehouseId: body.warehouseId || '',
      entries: (body.entries ?? []).map((entry) => ({
        colorKey: entry.colorKey || '',
        count: Number(entry.count ?? 0),
      })),
      note: body.note,
    });

    return NextResponse.json({
      ok: true,
      inventory,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '补货导入失败' },
      { status: 400 }
    );
  }
}
