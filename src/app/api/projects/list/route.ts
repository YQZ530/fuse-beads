import { NextResponse } from 'next/server';
import { readProjectList } from '../_projectStore';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const projects = await readProjectList();
    return NextResponse.json({ ok: true, projects });
  } catch (error) {
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : '读取项目列表失败' },
      { status: 400 }
    );
  }
}
