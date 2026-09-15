import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';
import { resolveChartTarget, INDEX_ROWS } from '@/app/api/scalper/top-indices/route';
import type { CandleData } from '@/app/api/nifty-oi-profile/route';

// Today's intraday chart for one row of the Markets Overview page (any
// headline NSE index, or the MCX CRUDEOIL/CRUDEOILM rolling futures). The
// security id is resolved via the same table + getFutSid cache that
// scalper/top-indices/route.ts uses for its live quotes — see
// resolveChartTarget there.

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'index_candles_fetch.py');

interface CandlesResult {
  candles: CandleData[];
  error?: string;
}

interface CacheEntry { data: CandleData[]; ts: number }
const serverCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 15_000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const key = (searchParams.get('key') ?? '').toUpperCase();
  const days = searchParams.get('days') ?? '1';

  if (!INDEX_ROWS.some(r => r.key === key)) {
    return NextResponse.json({ success: false, error: 'unknown key' }, { status: 400 });
  }

  const cacheKey = `indices-overview-chart:${key}:${days}`;
  const hit = serverCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json({ success: true, candles: hit.data }, { headers: { 'Cache-Control': 'no-store' } });
  }

  // Rolling-futures rows (CRUDEOIL/CRUDEOILM) resolve their security id in
  // the background on a once-a-day cache — same as the live-quote path — so
  // a null here means "not resolved yet", not an error.
  const target = resolveChartTarget(key);
  if (!target) {
    if (hit) return NextResponse.json({ success: true, candles: hit.data }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ success: false, error: 'security id not resolved yet, retry shortly' }, { status: 503 });
  }

  try {
    const data = await dedupe(cacheKey, () =>
      spaced(`dhan-spawn:indices-overview-chart:${key}`, () =>
        runPythonJson<CandlesResult>(
          SCRIPT_PATH,
          ['--sid', String(target.sid), '--segment', target.segment, '--instrument', target.instrument, '--days', days],
          30_000,
        ),
      ),
    );

    if (data.error) {
      if (hit) return NextResponse.json({ success: true, candles: hit.data }, { headers: { 'Cache-Control': 'no-store' } });
      return NextResponse.json({ success: false, error: data.error }, { status: 500 });
    }

    serverCache.set(cacheKey, { data: data.candles, ts: Date.now() });
    return NextResponse.json({ success: true, candles: data.candles }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (hit) return NextResponse.json({ success: true, candles: hit.data }, { headers: { 'Cache-Control': 'no-store' } });
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
