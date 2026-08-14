import { NextRequest, NextResponse } from 'next/server';
import { deleteWarehouseTransaction } from '@/lib/warehouseStore';

export const runtime = 'nodejs';

interface DeleteWarehouseTransactionRequest {
  warehouseId?: string;
  transactionId?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as DeleteWarehouseTransactionRequest;
    const inventory = await deleteWarehouseTransaction({
      warehouseId: body.warehouseId || '',
      transactionId: body.transactionId || '',
    });

    return NextResponse.json({
      ok: true,
      inventory,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '删除库存记录失败' },
      { status: 400 }
    );
  }
}
