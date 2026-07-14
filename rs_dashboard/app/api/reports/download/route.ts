import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const ALLOWED_DIRS = ['reports', 'portfolio'];

const EXT_TYPES: Record<string, string> = {
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.csv': 'text/csv',
  '.png': 'image/png',
  '.md': 'text/markdown; charset=utf-8',
};

export async function GET(req: NextRequest) {
  const url = new URL(req.url);
  const file = url.searchParams.get('file');

  if (!file) {
    return NextResponse.json({ error: 'file parameter required' }, { status: 400 });
  }

  // Security: normalise separators, reject traversals, restrict to allowed dirs
  const normalised = file.replace(/\\/g, '/').replace(/\/+/g, '/');
  if (
    normalised.includes('..') ||
    !ALLOWED_DIRS.some(d => normalised.startsWith(d + '/'))
  ) {
    return NextResponse.json({ error: 'Access denied' }, { status: 403 });
  }

  const absPath = path.join(PROJECT_ROOT, normalised);
  if (!fs.existsSync(absPath)) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 });
  }

  const buffer = fs.readFileSync(absPath);
  const ext = path.extname(absPath).toLowerCase();
  const contentType = EXT_TYPES[ext] || 'application/octet-stream';
  const filename = path.basename(absPath);

  return new NextResponse(buffer, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(buffer.length),
    },
  });
}
