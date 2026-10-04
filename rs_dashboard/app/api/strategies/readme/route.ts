import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { STRATEGIES_METADATA } from '@/lib/strategyRegistry';

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key') || '';
  const meta = STRATEGIES_METADATA[key];
  if (!meta) {
    return NextResponse.json({ success: false, error: 'Unknown strategy key' }, { status: 400 });
  }

  try {
    let filePath = meta.readmePath;
    if (!fs.existsSync(filePath)) {
      const dirFallback = path.join(path.dirname(meta.path), 'strategy.md');
      if (fs.existsSync(dirFallback)) {
        filePath = dirFallback;
      }
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    return NextResponse.json({ success: true, name: meta.name, content });
  } catch {
    return NextResponse.json({ success: false, error: 'Readme not found for this strategy yet.' }, { status: 404 });
  }
}
