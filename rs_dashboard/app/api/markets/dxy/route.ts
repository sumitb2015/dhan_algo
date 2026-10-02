import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';

// US Dollar Index (DX-Y.NYB) — EOD only. Written by the Yahoo sync
// (download_yahoo_daily.py --target dxy, part of refresh_dashboard_data.py),
// so "live" here means the latest synced daily bar vs the one before it.
const CSV = path.join(PROJECT_ROOT, 'Historical Data', 'US_DOLLAR_INDEX_Daily.csv');

export async function GET() {
  try {
    const lines = fs.readFileSync(CSV, 'utf8').trim().split('\n').slice(1)
      .map(l => l.split(','))
      .filter(p => p.length >= 5 && Number(p[4]) > 0);
    if (lines.length < 2) throw new Error('not enough rows');
    const last = lines[lines.length - 1];
    const prev = lines[lines.length - 2];
    const ltp = Number(last[4]);
    const prevClose = Number(prev[4]);
    return NextResponse.json({
      success: true,
      date: last[0],
      ltp,
      prev_close: prevClose,
      change_pct: ((ltp - prevClose) / prevClose) * 100,
      day_high: Number(last[2]),
      day_low: Number(last[3]),
      source: 'yahoo-eod',
    });
  } catch (e) {
    return NextResponse.json(
      { success: false, error: `DXY data unavailable — run the data refresh (${String(e).slice(0, 100)})` },
      { status: 200 },
    );
  }
}
