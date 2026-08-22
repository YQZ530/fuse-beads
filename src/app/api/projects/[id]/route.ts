import { NextResponse } from 'next/server';
import { deleteProject, readProjectById } from '../_projectStore';

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

interface DeleteProjectRequest {
  confirmName?: string;
}

export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const body = (await request.json()) as DeleteProjectRequest;
    await deleteProject({
      projectId: id,
      confirmName: body.confirmName || '',
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '删除项目失败' },
      { status: 400 }
    );
  }
}
