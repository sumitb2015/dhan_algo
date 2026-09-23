import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'nifty_time_analysis_fetch.py');

const ALLOWED_INTERVALS = [1, 3, 5, 15, 30] as const;
type Interval = (typeof ALLOWED_INTERVALS)[number];

export interface NiftyTimeAnalysisRow {
  time: string;
  spot: number; spot_dir: -1 | 0 | 1;
  fut: number; fut_dir: -1 | 0 | 1;
  fut_spot_diff: number; fut_spot_diff_dir: -1 | 0 | 1;
  avg_price: number; avg_price_dir: -1 | 0 | 1;
  max_pain: number; max_pain_dir: -1 | 0 | 1;
  pcr: number;
  atm: number; atm_dir: -1 | 0 | 1;
  vix: number; vix_dir: -1 | 0 | 1;
  fut_oi_chg_pct: number | null;
  highest_put_oi_strike: number;
  highest_put_oi_lakhs: number;
  highest_call_oi_strike: number;
  highest_call_oi_lakhs: number;
  straddle_delta: number | null;
  vol_bias: string;
  bias: string;
}

export interface NiftyTimeAnalysisResponse {
  date: string;
  interval: string;
  nearest_expiry: string | null;
  rows: NiftyTimeAnalysisRow[];
  /** True while `date`'s session is still today and possibly still running — false once
   *  the day is over (or a past `date` was requested), meaning the table is complete and
   *  will not change until the next session, so the client can safely stop polling. */
  is_live: boolean;
  legs_ok?: number;
  legs_failed?: number;
  backtrace_status: 'ok' | 'unavailable';
  coverage_note: string;
  /** Set only when this response is a cached fallback served after a live fetch failed. */
  stale?: boolean;
  error?: string;
}

interface CacheEntry {
  data: NiftyTimeAnalysisResponse;
  ts: number;
  ttl: number;
}

const serverCache = new Map<string, CacheEntry>();
// A live session's newest bucket can still be filling in — short TTL. A closed session
// (today after 15:30, or any past `date`) is fixed once fetched, same as trending-oi.
const LIVE_CACHE_TTL_MS = 45_000;
const HISTORICAL_CACHE_TTL_MS = 24 * 60 * 60_000;

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** GET — the whole session's table, reconstructed statelessly from Dhan's own retained
 *  per-minute OI/LTP history (works identically whether the market is open right now or
 *  has been closed for hours — there is no live-only limitation here, unlike the option
 *  chain endpoint this replaced a background collector for). */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const intervalParam = Number(searchParams.get('interval') ?? 15);
  const interval: Interval = (ALLOWED_INTERVALS as readonly number[]).includes(intervalParam)
    ? (intervalParam as Interval)
    : 15;
  const dateParam = searchParams.get('date');
  const date = dateParam && DATE_RE.test(dateParam) ? dateParam : '';

  const cacheKey = `nifty-time-analysis:${interval}:${date}`;
  const hit = serverCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < hit.ttl) {
    return NextResponse.json({ success: true, data: hit.data }, { headers: { 'Cache-Control': 'no-store' } });
  }

  const args = ['--interval', String(interval)];
  if (date) args.push('--date', date);

  try {
    const data = await dedupe(cacheKey, () =>
      // Own pacing lane, not the shared option-chain/spot chain key — this script never
      // touches the live chain endpoint (strikes come from the security master), so
      // queuing it behind those routes would only add latency for no rate-limit benefit.
      spaced('dhan-intraday:NIFTY-time-analysis', () =>
        // ~43 paced Dhan calls (spot + VIX + futures + 21 strikes x2 legs) — same budget
        // as trending-oi's fetch, same timeout.
        runPythonJson<NiftyTimeAnalysisResponse>(SCRIPT_PATH, args, 90_000)
      )
    );

    if (data.error) {
      console.error('[/api/nifty-time-analysis] Python script error:', data.error);
      return NextResponse.json({ success: false, error: data.error }, { status: 500 });
    }

    const ttl = data.is_live === false ? HISTORICAL_CACHE_TTL_MS : LIVE_CACHE_TTL_MS;
    serverCache.set(cacheKey, { data, ts: Date.now(), ttl });

    return NextResponse.json({ success: true, data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/nifty-time-analysis] Error executing fetch script:', message);

    if (hit) {
      console.warn(`[/api/nifty-time-analysis] Serving stale cache entry after fetch failure.`);
      return NextResponse.json({ success: true, data: { ...hit.data, stale: true } }, {
        headers: { 'Cache-Control': 'no-store' },
      });
    }

    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
