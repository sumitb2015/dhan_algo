import { NextResponse } from 'next/server';
import { parseYahooChart, type IndexLevel } from '@/lib/usDashboard';

export const dynamic = 'force-dynamic';

// GET /api/live-us/indices - real US index levels from Yahoo Finance (DELAYED, not Dhan). Dhan's US feed has no index
// instruments, so the page shows these next to its live ETF proxies and labels them as delayed Yahoo data.
// One fetch per minute at most, shared between callers (in-flight dedupe); on failure the last good set is returned as stale.
const INDICES: Array<{ symbol: string; name: string }> = [
  { symbol: '^GSPC', name: 'S&P 500' },
  { symbol: '^NDX', name: 'Nasdaq-100' },
  { symbol: '^IXIC', name: 'Nasdaq Comp.' },
  { symbol: '^DJI', name: 'Dow Jones' },
  { symbol: '^RUT', name: 'Russell 2000' },
  { symbol: '^VIX', name: 'VIX' },
];
const TTL_MS = 60_000;

let cache: { at: number; levels: IndexLevel[] } | null = null;
let inflight: Promise<IndexLevel[]> | null = null;

async function fetchOne(symbol: string, name: string): Promise<IndexLevel | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=5d&interval=1d`;
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000), cache: 'no-store' });
    if (!res.ok) return null;
    return parseYahooChart(await res.json(), symbol, name);
  } catch { return null; }
}

async function refresh(): Promise<IndexLevel[]> {
  const got = await Promise.all(INDICES.map(i => fetchOne(i.symbol, i.name)));
  const levels = got.filter((x): x is IndexLevel => x != null);
  if (levels.length === 0) throw new Error('Yahoo index data unavailable');
  // Keep the last good value for any single index that failed this round.
  const prev = new Map((cache?.levels ?? []).map(l => [l.symbol, l]));
  const merged = INDICES.flatMap(i => { const l = levels.find(x => x.symbol === i.symbol) ?? prev.get(i.symbol); return l ? [l] : []; });
  cache = { at: Date.now(), levels: merged };
  return merged;
}

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  if (!cache || now - cache.at >= TTL_MS) {
    if (!inflight) inflight = refresh().finally(() => { inflight = null; });
    try { await inflight; } catch (err) {
      if (!cache) return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Yahoo index data unavailable' }, { status: 502 });
      return NextResponse.json({ success: true, source: 'yahoo', delayed: true, stale: true, fetchedAt: cache.at, levels: cache.levels });
    }
  }
  return NextResponse.json({ success: true, source: 'yahoo', delayed: true, stale: false, fetchedAt: cache!.at, levels: cache!.levels });
}
