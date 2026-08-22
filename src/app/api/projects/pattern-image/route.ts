import { readFile } from 'fs/promises';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { resolveSafeProjectAssetPath } from '../_projectStore';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const imagePath = request.nextUrl.searchParams.get('path') || '';
    const resolved = resolveSafeProjectAssetPath(imagePath);
    if (!resolved) {
      return NextResponse.json({ ok: false, error: '图片路径无效' }, { status: 400 });
    }

    const data = await readFile(resolved);
    return new NextResponse(new Uint8Array(data), {
      headers: {
        'Content-Type': contentTypeForPath(resolved),
        'Cache-Control': 'public, max-age=60',
      },
    });
  } catch {
    return NextResponse.json({ ok: false, error: '找不到图片' }, { status: 404 });
  }
}

function contentTypeForPath(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/png';
  }
}
