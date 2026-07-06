import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

const TOKEN_FILE    = path.join(process.cwd(), '..', 'access_token.json');
const POSITIONS_URL = 'https://api.dhan.co/v2/positions';
const OHLC_URL      = 'https://api.dhan.co/v2/marketfeed/ohlc';
const VIX_ID        = 21;

interface TokenCache { clientId: string; token: string; ts: number }
let tokenCache: TokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

function getToken(): { clientId: string; token: string } | null {
  try {
    if (tokenCache && Date.now() - tokenCache.ts < TOKEN_TTL) {
      return { clientId: tokenCache.clientId, token: tokenCache.token };
    }
    const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
      dhanClientId: string;
      accessToken: string;
    };
    tokenCache = { clientId: raw.dhanClientId, token: raw.accessToken, ts: Date.now() };
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  } catch {
    return null;
  }
}

interface RouteCache { data: unknown; ts: number }
let routeCache: RouteCache | null = null;
const ROUTE_TTL = 2000;

export async function GET() {
  // serve from cache if fresh
  if (routeCache && Date.now() - routeCache.ts < ROUTE_TTL) {
    return NextResponse.json(routeCache.data);
  }

  const auth = getToken();
  if (!auth) {
    const payload = { has_positions: false, net_premium: 0, vix: 0, legs: [], timestamp: new Date().toISOString(), error: 'auth' };
    return NextResponse.json(payload);
  }

  const headers = {
    'access-token': auth.token,
    'client-id':    auth.clientId,
    'Content-Type': 'application/json',
    'Accept':       'application/json',
  };

  // ── Step A: fetch open positions ──────────────────────────────────
  let rawPositions: DhanPosition[] = [];
  try {
    const res = await fetch(POSITIONS_URL, {
      headers,
      signal: AbortSignal.timeout(6000),
    });
    const json = await res.json() as DhanPosition[] | { data?: DhanPosition[] };
    // SDK wraps in { data: [...] } or returns array directly
    rawPositions = Array.isArray(json) ? json : (json as { data?: DhanPosition[] }).data ?? [];
  } catch {
    const payload = { has_positions: false, net_premium: 0, vix: 0, legs: [], timestamp: new Date().toISOString(), error: 'api' };
    return NextResponse.json(payload);
  }

  // filter to options legs only
  const optLegs = rawPositions.filter(p =>
    (/-CE-|-PE-/i.test(p.tradingSymbol ?? '')) && (p.netQty ?? 0) !== 0
  );

  // ── Step B: fetch LTPs for option legs + VIX in one OHLC call ────
  // Group security IDs by exchange segment; options are NSE_FNO
  const secIds: number[] = optLegs.map(p => Number(p.securityId)).filter(Boolean);

  const ohlcBody: Record<string, number[]> = { NSE_IDX: [VIX_ID] };
  if (secIds.length > 0) ohlcBody['NSE_FNO'] = secIds;

  let ltpMap: Record<string, number> = {};
  let vix = 0;
  try {
    const res = await fetch(OHLC_URL, {
      method: 'POST',
      headers,
      body: JSON.stringify(ohlcBody),
      signal: AbortSignal.timeout(6000),
    });
    const json = await res.json() as {
      status?: string;
      data?: Record<string, Record<string, { last_price?: number }>>;
    };
    if (json.status === 'success' && json.data) {
      vix = json.data?.NSE_IDX?.[String(VIX_ID)]?.last_price ?? 0;
      const fnoData = json.data?.NSE_FNO ?? {};
      for (const [id, entry] of Object.entries(fnoData)) {
        ltpMap[id] = entry.last_price ?? 0;
      }
    }
  } catch {
    // VIX and LTPs will be 0; proceed with what we have
  }

  // ── Step C: build legs + compute net premium ──────────────────────
  type Leg = {
    symbol: string; strike: number; type: 'CE' | 'PE';
    side: 'SELL' | 'BUY'; ltp: number; netQty: number;
  };

  let netPremium = 0;
  const legs: Leg[] = optLegs.map(p => {
    const ltp  = ltpMap[String(p.securityId)] ?? (p.lastPrice ?? 0);
    const qty  = p.netQty ?? 0;
    const side: 'SELL' | 'BUY' = qty < 0 ? 'SELL' : 'BUY';
    const sym  = p.tradingSymbol ?? '';
    const cepe = /-CE-/i.test(sym) ? 'CE' : 'PE';

    // Extract strike from symbol e.g. "NIFTY-CE-24500-25JUL25" → 24500
    const strikeMatch = sym.match(/-(CE|PE)-(\d+)-/i);
    const strike = strikeMatch ? Number(strikeMatch[2]) : 0;

    netPremium += side === 'SELL' ? ltp : -ltp;

    return { symbol: sym, strike, type: cepe, side, ltp, netQty: qty };
  });

  const payload = {
    has_positions: legs.length > 0,
    net_premium: Math.round(netPremium * 100) / 100,
    vix: Math.round(vix * 100) / 100,
    legs,
    timestamp: new Date().toISOString(),
  };

  routeCache = { data: payload, ts: Date.now() };
  return NextResponse.json(payload);
}

// ── Dhan position shape (v2 API) ──────────────────────────────────
interface DhanPosition {
  tradingSymbol?: string;
  securityId?: string | number;
  netQty?: number;
  lastPrice?: number;
  exchangeSegment?: string;
}
