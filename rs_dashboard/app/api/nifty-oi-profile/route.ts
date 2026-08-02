import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'nifty_oi_profile_fetch.py');

export interface CandleData {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  oi: number;
}

export interface StrikeProfile {
  strike: number;
  is_atm: boolean;
  ce_oi: number;
  pe_oi: number;
  ce_oi_change: number;
  pe_oi_change: number;
  ce_ltp: number;
  pe_ltp: number;
  ce_volume: number;
  pe_volume: number;
  ce_iv: number;
  pe_iv: number;
}

export interface NiftyOIProfileResponse {
  symbol: string;
  spot_price: number;
  futures_price: number;
  ref_price: number;
  atm_strike: number;
  chosen_expiry: string;
  nearest_expiry: string;
  current_monthly_expiry: string;
  expiries: string[];
  monthly_expiries: string[];
  candles: CandleData[];
  strike_profiles: StrikeProfile[];
  summary: {
    total_call_oi: number;
    total_put_oi: number;
    total_call_oi_change: number;
    total_put_oi_change: number;
    pcr: number;
    pcr_change: number;
    max_call_oi_strike: number;
    max_put_oi_strike: number;
    resistance_level: number;
    support_level: number;
  };
  last_updated: string;
  error?: string;
}

interface CacheEntry {
  data: NiftyOIProfileResponse;
  ts: number;
}

const serverCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 8_000; // 8 seconds memory cache to eliminate rate limits

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const expiry = searchParams.get('expiry') ?? 'nearest';
  const step = searchParams.get('step') ?? '50';
  const range = searchParams.get('range') ?? '10';
  const days = searchParams.get('days') ?? '3';

  const cacheKey = `nifty-oi-profile:${expiry}:${step}:${range}:${days}`;

  // Check 8s memory cache to protect Dhan API rate limit
  const hit = serverCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json({ success: true, data: hit.data }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  }

  try {
    const data = await dedupe(cacheKey, () =>
      spaced('dhan-spawn:NIFTY', () =>
        runPythonJson<NiftyOIProfileResponse>(
          SCRIPT_PATH,
          ['--expiry', expiry, '--step', step, '--range', range, '--days', days],
          45_000
        )
      )
    );

    if (data.error) {
      console.error('[/api/nifty-oi-profile] Python script error:', data.error);
      return NextResponse.json({ success: false, error: data.error }, { status: 500 });
    }

    serverCache.set(cacheKey, { data, ts: Date.now() });

    return NextResponse.json({ success: true, data }, {
      headers: { 'Cache-Control': 'no-store' }
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[/api/nifty-oi-profile] Error executing fetch script:', message);

    // If cache has a stale entry, serve it as fallback instead of throwing error
    if (hit) {
      return NextResponse.json({ success: true, data: hit.data }, {
        headers: { 'Cache-Control': 'no-store' }
      });
    }

    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
