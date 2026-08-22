import { NextRequest, NextResponse } from 'next/server';
import { addPatternsToProject } from '../../../_projectStore';

export const runtime = 'nodejs';

interface AddPatternsRequest {
  patternIds?: string[];
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as AddPatternsRequest;
    const project = await addPatternsToProject({
      projectId: id,
      patternIds: body.patternIds ?? [],
    });

    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '添加图纸失败' },
      { status: 400 }
    );
  }
}
