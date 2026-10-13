import { NextRequest, NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const VIX_CSV = path.join(path.resolve(process.cwd(), '..'), 'Historical Data', 'Indices', 'INDIA_VIX.csv');

/** Daily India VIX closes (read-only, from the repo's own CSV). `?days=` caps the tail (default 250, max 2000). */
export async function GET(req: NextRequest) {
  const days = Math.min(2000, Math.max(5, Number(req.nextUrl.searchParams.get('days')) || 250));
  try {
    const lines = fs.readFileSync(VIX_CSV, 'utf8').split(/\r?\n/).filter(Boolean).slice(1);
    const rows = lines.map(l => {
      const c = l.split(',');
      return { date: (c[0] ?? '').slice(0, 10), high: parseFloat(c[2]), low: parseFloat(c[3]), close: parseFloat(c[4]) };
    }).filter(r => r.date && Number.isFinite(r.close) && r.close > 0);
    return NextResponse.json({ success: true, rows: rows.slice(-days) });
  } catch {
    return NextResponse.json({ success: false, rows: [], error: 'INDIA_VIX.csv not readable' }, { status: 500 });
  }
}
