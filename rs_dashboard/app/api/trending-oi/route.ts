import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'trending_oi_fetch.py');

export interface TrendingOiRow {
  date: string;
  time: string;
  spot: number | null;
  day_hl_break: string | null;
  total_call_oi: number;
  total_put_oi: number;
  chng_in_call_oi: number | null;
  chng_in_put_oi: number | null;
  diff_in_oi: number | null;
  direction_pct: number | null;
  direction: 'up' | 'down' | null;
  chng_in_direction: number | null;
  net_pcr: number | null;
  day_hl_diff_oi: string | null;
  sentiment: 'Bullish' | 'Bearish' | null;
  total_call_ltp: number;
  call_ltp_chng: number | null;
  ce_pe_ltp_chng: number | null;
  total_put_ltp: number;
  put_ltp_chng: number | null;
}

export interface TrendingOiResponse {
  expiry: string;
  interval: string;
  spot: number;
  selected_strikes: number[];
  available_strikes: number[];
  expiries: string[];
  rows: TrendingOiRow[];
  backtrace_status: 'ok' | 'unavailable';
  coverage_note: string;
  error?: string;
}

interface CacheEntry {
  data: TrendingOiResponse;
  ts: number;
}

const serverCache = new Map<string, CacheEntry>();
const LIVE_CACHE_TTL_MS = 45_000; // matches the ~60s reconstruction cadence this replaces
const HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60_000; // a closed session's data never changes

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const expiry = searchParams.get('expiry') ?? 'nearest';
  const interval = searchParams.get('interval') ?? '5';
  const date = searchParams.get('date') ?? '';
  const strikes = searchParams.get('strikes') ?? '';

  const cacheKey = `trending-oi:${expiry}:${interval}:${date}:${strikes}`;
  const ttl = date ? HISTORICAL_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;

  const hit = serverCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < ttl) {
    return NextResponse.json({ success: true, data: hit.data }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  const args = ['--expiry', expiry, '--interval', interval];
  if (date) args.push('--date', date);
  if (strikes) args.push('--strikes', strikes);

  try {
    const data = await dedupe(cacheKey, () =>
      spaced('dhan-spawn:NIFTY', () =>
        // A full band is ~42 paced Dhan calls; the script caps strikes to keep it under this.
        runPythonJson<TrendingOiResponse>(SCRIPT_PATH, args, 90_000)
      )
    );

    if (data.error) {
      console.error('[/api/trending-oi] Python script error:', data.error);
      return NextResponse.json({ success: false, error: data.error }, { status: 500 });
    }

    serverCache.set(cacheKey, { data, ts: Date.now() });

    return NextResponse.json({ success: true, data }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/trending-oi] Error executing fetch script:', message);

    if (hit) {
      return NextResponse.json({ success: true, data: hit.data }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
