import { NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';

// On-demand live LTP for the Top 8 Charts page's Refresh button.
//
// /api/equity-candles only reflects whatever debug/today_quotes.json last had
// (written by a separate script/bridge, not by this route) — pressing Refresh
// on that alone can re-serve the same stale "today" close. This route instead
// hits Dhan's OHLC endpoint directly for a fresh last_price, batching both
// segments (NSE_EQ stocks, IDX_I indices) in one request. The client overlays
// the returned ltp onto its already-loaded candle history's last row rather
// than needing a prevClose from here — the CSV's second-to-last row is
// already the correct prior-day baseline (see dataLoader.ts's patch logic).
//
// Security ids are hardcoded rather than resolved via a Python/master-list
// spawn: this is a fixed set of 16 large-cap/benchmark symbols (see
// TOP8_STOCKS/TOP8_INDICES in TopMarketCapCharts.tsx) whose Dhan ids don't
// change, so a spawn's ~1.5s master-list load would be pure overhead here.

const DHAN_OHLC_URL = 'https://api.dhan.co/v2/marketfeed/ohlc';

// symbol (matches Tile.symbol in TopMarketCapCharts.tsx) -> [segment, security id]
const SECURITY_IDS: Record<string, ['NSE_EQ' | 'IDX_I', number]> = {
  // Stocks — NIFTY_TOP10_BY_WEIGHT.slice(0, 8), verified against master_list.csv
  HDFCBANK:   ['NSE_EQ', 1333],
  ICICIBANK:  ['NSE_EQ', 4963],
  RELIANCE:   ['NSE_EQ', 2885],
  BHARTIARTL: ['NSE_EQ', 10604],
  LT:         ['NSE_EQ', 11483],
  SBIN:       ['NSE_EQ', 3045],
  AXISBANK:   ['NSE_EQ', 5900],
  INFY:       ['NSE_EQ', 1594],
  // Indices — same ids as app/api/scalper/top-indices/route.ts and
  // app/api/index-ticker/route.ts
  NIFTY50:      ['IDX_I', 13],
  BANKNIFTY:    ['IDX_I', 25],
  INDIA_VIX:    ['IDX_I', 21],
  NIFTYIT:      ['IDX_I', 29],
  NIFTY_AUTO:   ['IDX_I', 14],
  NIFTY_PHARMA: ['IDX_I', 32],
  NIFTY_METAL:  ['IDX_I', 31],
  NIFTY_REALTY: ['IDX_I', 34],
};

// Short TTL so a fast double-click (or several tiles' worth of one request)
// collapses onto one upstream call rather than racing Dhan's rate limit.
const CACHE_TTL_MS = 2000;
let cache: { ts: number; body: unknown } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const ltps: Record<string, number> = {};
  const errors: string[] = [];

  try {
    const { clientId, token } = getDhanCredentials();
    if (!token) throw new Error('no Dhan session');

    const body: Record<string, number[]> = {};
    for (const [seg, sid] of Object.values(SECURITY_IDS)) (body[seg] ??= []).push(sid);

    const res = await fetch(DHAN_OHLC_URL, {
      method: 'POST',
      headers: {
        'access-token': token,
        'client-id': clientId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(6000),
    });
    const json = (await res.json()) as {
      status?: string;
      data?: Record<string, Record<string, { last_price?: number }>>;
    };
    if (json.status !== 'success') {
      throw new Error(`ohlc ${res.status}: ${JSON.stringify(json.status).slice(0, 120)}`);
    }

    for (const [symbol, [seg, sid]] of Object.entries(SECURITY_IDS)) {
      const ltp = Number(json.data?.[seg]?.[String(sid)]?.last_price ?? 0);
      if (ltp > 0) ltps[symbol] = ltp;
    }
  } catch (e) {
    errors.push(String(e).slice(0, 160));
  }

  const responseBody = {
    success: Object.keys(ltps).length > 0,
    updated_at: new Date().toISOString(),
    ltps,
    errors,
  };

  cache = { ts: Date.now(), body: responseBody };
  return NextResponse.json(responseBody);
}
