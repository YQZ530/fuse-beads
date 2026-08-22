import { NextRequest, NextResponse } from 'next/server';
import { removeProjectPatterns } from '../../../_projectStore';

export const runtime = 'nodejs';

interface RemovePatternsRequest {
  patternIds?: string[];
}

export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as RemovePatternsRequest;
    const project = await removeProjectPatterns({
      projectId: id,
      patternIds: body.patternIds ?? [],
    });

    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '移除图纸失败' },
      { status: 400 }
    );
  }
}
