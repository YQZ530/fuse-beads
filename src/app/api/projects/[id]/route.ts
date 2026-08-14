import { NextResponse } from 'next/server';
import { readProjectById } from '../_projectStore';

export const runtime = 'nodejs';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const project = await readProjectById(id);
    if (!project) {
      return NextResponse.json({ ok: false, error: '找不到项目' }, { status: 404 });
    }

    return NextResponse.json({ ok: true, project });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '读取项目失败' },
      { status: 400 }
    );
  }
}
