import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';

// Read-only market data: NIFTY index candles for /index-scalper. Never places orders.
const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'index_scalper_candles.py');

interface Result {
  candles?: { t: number; o: number; h: number; l: number; c: number }[];
  interval?: string;
  error?: string;
}

const cache = new Map<string, { data: Result; ts: number }>();
const TTL_MS = 20_000;

export async function GET(req: NextRequest) {
  const sp = new URL(req.url).searchParams;
  const interval = sp.get('interval') ?? '5';
  if (!['1', '3', '5', '15'].includes(interval)) {
    return NextResponse.json({ success: false, error: 'interval must be 1, 3, 5 or 15' }, { status: 400 });
  }
  const daysRaw = Number(sp.get('days') ?? '10');
  const days = Number.isFinite(daysRaw) ? Math.max(1, Math.min(60, Math.floor(daysRaw))) : 10;
  const key = `idx-scalper:${interval}:${days}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < TTL_MS) {
    return NextResponse.json({ success: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
  }
  try {
    const data = await dedupe(key, () =>
      spaced('dhan-spawn:index-scalper-candles', () =>
        runPythonJson<Result>(SCRIPT, ['--symbol', 'NIFTY', '--interval', interval, '--days', String(days)], 40_000),
      ),
    );
    if (data.error) {
      if (hit) return NextResponse.json({ success: true, stale: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
      return NextResponse.json({ success: false, error: data.error }, { status: 502 });
    }
    cache.set(key, { data, ts: Date.now() });
    return NextResponse.json({ success: true, ...data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    if (hit) return NextResponse.json({ success: true, stale: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
