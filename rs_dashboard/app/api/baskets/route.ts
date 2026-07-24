import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs/promises';
import { PROJECT_ROOT } from '@/lib/pyExec';

const STORE_PATH = path.join(PROJECT_ROOT, 'debug', 'saved_baskets.json');

async function readStore(): Promise<unknown[]> {
  try {
    const raw = await fs.readFile(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export async function GET() {
  const baskets = await readStore();
  return NextResponse.json({ success: true, data: baskets });
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null) as { baskets?: unknown } | null;
  if (!body || !Array.isArray(body.baskets)) {
    return NextResponse.json({ success: false, error: 'baskets must be an array' }, { status: 400 });
  }
  try {
    await fs.mkdir(path.dirname(STORE_PATH), { recursive: true });
    await fs.writeFile(STORE_PATH, JSON.stringify(body.baskets, null, 2), 'utf8');
    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
