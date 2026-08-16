import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { runPythonJson, dedupe, PROJECT_ROOT } from '@/lib/pyExec';
import type { Bar } from '@/lib/volumeProfile';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'volume_footprint_fetch.py');

/** Index names carry spaces ("NIFTY 500"), unlike the equity-only routes. */
const SYMBOL_RE = /^[A-Z0-9&\- ]{1,24}$/;

const CACHE_MS = 8_000;
// Bounded: each entry holds up to ~11k bars, and the universe is 229 symbols × 4 depth
// choices × 3 sources. Left unbounded this leaks every combination a user ever opens for
// the life of the server process, which under `next start` is days.
const CACHE_MAX = 24;
const cache = new Map<string, { at: number; payload: FootprintFetchResponse }>();

function cacheSet(key: string, payload: FootprintFetchResponse) {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.at >= CACHE_MS) cache.delete(k);
  }
  // Map iterates in insertion order, so the first key is the oldest insert.
  while (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
  cache.set(key, { at: now, payload });
}

export interface FootprintFetchResponse {
  success: boolean;
  symbol: string;
  /** "store", "dhan" or "store+dhan" — which source(s) the bars came from. */
  source?: string;
  /** Last session held by the local parquet archive, null when the symbol isn't in it. */
  store_last?: string | null;
  sessions?: number;
  updated_at?: string;
  last_bar?: string | null;
  /** Dhan's error when it returned nothing — an empty response is not proof of "no data". */
  api_error?: string | null;
  bars: Bar[];
  error?: string;
}

/**
 * Raw 1-minute bars for the Volume Footprint page.
 *
 * Deliberately returns bars and nothing else: every profile figure is derived client-side
 * so that dragging a slider (tick size, imbalance %, value area %) recomputes instantly
 * without a round trip.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams;
  const symbol = (params.get('symbol') ?? '').trim().toUpperCase();
  const days = Math.min(Math.max(Number(params.get('days') ?? 5) || 5, 1), 30);
  const source = ['auto', 'store', 'dhan'].includes(params.get('source') ?? '')
    ? (params.get('source') as string)
    : 'auto';

  const fail = (error: string, status: number) =>
    NextResponse.json({ success: false, symbol, bars: [], error } satisfies FootprintFetchResponse, { status });

  if (!symbol) return fail('symbol is required', 400);
  if (!SYMBOL_RE.test(symbol)) return fail('invalid symbol', 400);

  const key = `${symbol}|${days}|${source}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json(hit.payload);
  }

  try {
    // Dedupe rather than pace: a fetch can take seconds and the page polls every 10s, so
    // concurrent viewers of the same symbol must share one spawn instead of stacking
    // processes against Dhan's rate limit.
    const payload = await dedupe(`volume-footprint:${key}`, () =>
      runPythonJson<FootprintFetchResponse>(
        SCRIPT,
        ['--symbol', symbol, '--days', String(days), '--source', source],
        90_000,
      ),
    );

    if (payload?.success) cacheSet(key, payload);
    return NextResponse.json(payload ?? { success: false, symbol, bars: [], error: 'empty response' });
  } catch (e) {
    return fail(e instanceof Error ? e.message : String(e), 500);
  }
}
