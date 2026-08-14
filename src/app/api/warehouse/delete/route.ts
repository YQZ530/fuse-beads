import { NextRequest, NextResponse } from 'next/server';
import { deleteWarehouse } from '@/lib/warehouseStore';

export const runtime = 'nodejs';

interface DeleteWarehouseRequest {
  warehouseId?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DeleteWarehouseRequest;
    const inventory = await deleteWarehouse({
      warehouseId: body.warehouseId || '',
    });

    return NextResponse.json({
      ok: true,
      inventory,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '删除豆仓失败' },
      { status: 400 }
    );
  }
}
