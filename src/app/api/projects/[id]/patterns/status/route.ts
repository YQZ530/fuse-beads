import { NextRequest, NextResponse } from 'next/server';
import { updateProjectPatternStatuses, type ProjectStatus } from '../../../_projectStore';

export const runtime = 'nodejs';

interface UpdatePatternStatusRequest {
  patternIds?: string[];
  status?: ProjectStatus;
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as UpdatePatternStatusRequest;
    const project = await updateProjectPatternStatuses({
      projectId: id,
      patternIds: body.patternIds ?? [],
      status: body.status || 'draft',
    });

    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '移动图纸状态失败' },
      { status: 400 }
    );
  }
}
