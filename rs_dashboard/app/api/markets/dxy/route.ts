import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

// US Dollar Index (DX-Y.NYB). Live path: scripts/tools/dxy_live.py (Yahoo 1-min
// bars), cached 15 s so every open tab shares one spawn. Fallback: latest synced
// daily bar from the Yahoo sync CSV (download_yahoo_daily.py --target dxy).
const LIVE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'dxy_live.py');
const TTL_MS = 15_000;
let cache: { at: number; body: unknown } | null = null;
const CSV = path.join(PROJECT_ROOT, 'Historical Data', 'US_DOLLAR_INDEX_Daily.csv');

export async function GET() {
  if (cache && Date.now() - cache.at < TTL_MS) return NextResponse.json(cache.body);
  try {
    const q = await dedupe('dxy-live', () =>
      runPythonJson<{ ltp: number; prev_close: number; day_high: number; day_low: number; ts: number }>(LIVE_SCRIPT, [], 20_000));
    const body = {
      success: true,
      date: new Date(q.ts).toISOString(),
      ts: q.ts,
      ltp: q.ltp,
      prev_close: q.prev_close,
      change_pct: ((q.ltp - q.prev_close) / q.prev_close) * 100,
      day_high: q.day_high,
      day_low: q.day_low,
      source: 'yahoo-live',
    };
    cache = { at: Date.now(), body };
    return NextResponse.json(body);
  } catch {
    // fall through to the EOD CSV
  }
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
