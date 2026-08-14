import { NextRequest, NextResponse } from 'next/server';
import { createProject } from '../_projectStore';

export const runtime = 'nodejs';

interface CreateProjectRequest {
  name?: string;
  warehouseId?: string;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as CreateProjectRequest;
    const project = await createProject({
      name: body.name || '',
      warehouseId: body.warehouseId || '',
    });

    return NextResponse.json({
      ok: true,
      project,
    });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '创建项目失败' },
      { status: 400 }
    );
  }
}
