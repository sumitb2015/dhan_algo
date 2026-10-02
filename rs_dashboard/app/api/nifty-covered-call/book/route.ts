import { NextResponse } from 'next/server';
import { dhanGet, getDhanCredentials } from '@/lib/dhanToken';
import { getCachedPositions, brokerCacheGeneration } from '@/lib/brokerPositionsCache';
import { pacedQuoteCall } from '@/lib/dhanQuotePacer';

// Broker-side read model for the NIFTYBEES Covered Call desk (display only —
// never sizes an order; the order route re-reads positions live):
//   • NIFTYBEES quantity = holdings.totalQty (DP + T1) + today's CNC position
//     netQty. Dhan keeps a same-day delivery buy out of /holdings until the
//     next day, and a same-day sell shows as a negative CNC position, so the
//     sum is the real share count. Verified 2026-10-01: holdings 2300
//     (2100 DP + 200 T1) + CNC position 2200 bought today = 4500.
//   • NIFTYBEES LTP from /marketfeed/ltp through the account-wide quote lane,
//     falling back to the holdings row's lastTradedPrice.
//   • Every NIFTY index CE the broker shows short — for down-only reconcile of
//     this desk's ledger and for the explicit "Adopt" action. These are NOT
//     treated as covered calls by themselves: other strategies short CEs too.

const BEES_SYMBOL = 'NIFTYBEES';
const LTP_URL = 'https://api.dhan.co/v2/marketfeed/ltp';
const RESPONSE_TTL_MS = 3_000;

type Row = Record<string, unknown>;

export interface BrokerShortCall {
  securityId: string;
  tradingSymbol: string;
  strike: number;
  expiry: string;
  shortUnits: number;
  sellAvg: number;
  productType: string;
}

export interface BeesHolding {
  securityId: string;
  qty: number;
  holdingsQty: number;
  dpQty: number;
  t1Qty: number;
  todayQty: number;
  avgCost: number;
  ltp: number;
  ltpSource: 'quote' | 'holdings' | null;
}

export interface CoveredCallBookResponse {
  success: boolean;
  ts: number;
  bees: BeesHolding | null;
  beesError?: string;
  brokerCalls: BrokerShortCall[];
  /** securityId → short units; null when /positions failed (unknown, not flat). */
  brokerShortUnits: Record<string, number> | null;
  positionsError?: string;
}

const num = (v: unknown) => (typeof v === 'number' ? v : Number(v)) || 0;

async function fetchBeesLtp(securityId: string): Promise<number> {
  const { clientId, token } = getDhanCredentials();
  return pacedQuoteCall(async () => {
    const res = await fetch(LTP_URL, {
      method: 'POST',
      headers: { 'access-token': token, 'client-id': clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ NSE_EQ: [Number(securityId)] }),
      signal: AbortSignal.timeout(6_000),
    });
    if (res.status === 429) throw Object.assign(new Error('Dhan quote rate limited (429)'), { status: 429 });
    if (!res.ok) throw new Error(`Dhan LTP HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { NSE_EQ?: Record<string, { last_price?: number }> } };
    return num(json.data?.NSE_EQ?.[securityId]?.last_price);
  });
}

async function build(): Promise<CoveredCallBookResponse> {
  const [holdingsRes, positionsRes] = await Promise.allSettled([
    dhanGet('/holdings'),
    getCachedPositions('dhan', () => dhanGet('/positions')),
  ]);

  const positions = positionsRes.status === 'fulfilled' && Array.isArray(positionsRes.value)
    ? (positionsRes.value as Row[])
    : null;

  // ── NIFTYBEES ──
  let bees: BeesHolding | null = null;
  let beesError: string | undefined;
  const holdings = holdingsRes.status === 'fulfilled' && Array.isArray(holdingsRes.value) ? (holdingsRes.value as Row[]) : [];
  if (holdingsRes.status === 'rejected') {
    // Dhan answers an empty demat with an error body rather than [] — only a
    // problem if there is no same-day position either (checked below).
    beesError = String((holdingsRes.reason as Error)?.message ?? holdingsRes.reason);
  }
  const h = holdings.find((r) => String(r.tradingSymbol ?? '').replace(/-EQ$/, '') === BEES_SYMBOL);
  const p = positions?.find(
    (r) => String(r.tradingSymbol ?? '').replace(/-EQ$/, '') === BEES_SYMBOL && String(r.exchangeSegment) === 'NSE_EQ' && String(r.productType) === 'CNC',
  );
  const holdingsQty = num(h?.totalQty);
  const todayQty = num(p?.netQty);
  const qty = holdingsQty + todayQty;
  if (h || p) {
    const hAvg = num(h?.avgCostPrice);
    const pAvg = num(p?.buyAvg) || num(p?.costPrice);
    // A same-day buy blends into the cost basis; a same-day sell doesn't move it.
    const avgCost = todayQty > 0 && qty > 0 ? (holdingsQty * hAvg + todayQty * pAvg) / qty : hAvg || pAvg;
    const securityId = String(h?.securityId ?? p?.securityId ?? '');
    let ltp = 0;
    let ltpSource: BeesHolding['ltpSource'] = null;
    try {
      if (securityId) ltp = await fetchBeesLtp(securityId);
      if (ltp > 0) ltpSource = 'quote';
    } catch { /* lane busy / 429 — fall back below */ }
    if (!(ltp > 0) && num(h?.lastTradedPrice) > 0) {
      ltp = num(h?.lastTradedPrice);
      ltpSource = 'holdings';
    }
    bees = {
      securityId, qty, holdingsQty, todayQty, avgCost, ltp, ltpSource,
      dpQty: num(h?.dpQty), t1Qty: num(h?.t1Qty),
    };
    beesError = undefined;
  } else if (!beesError) {
    beesError = `No ${BEES_SYMBOL} found in holdings or today's positions`;
  }

  // ── Broker NIFTY CE shorts ──
  let brokerShortUnits: Record<string, number> | null = null;
  const brokerCalls: BrokerShortCall[] = [];
  if (positions) {
    brokerShortUnits = {};
    for (const r of positions) {
      const sym = String(r.tradingSymbol ?? '');
      if (String(r.exchangeSegment) !== 'NSE_FNO' || !sym.startsWith('NIFTY-') || String(r.drvOptionType) !== 'CALL') continue;
      const netQty = num(r.netQty);
      if (netQty >= 0) continue;
      const sid = String(r.securityId);
      brokerShortUnits[sid] = (brokerShortUnits[sid] ?? 0) + -netQty;
      brokerCalls.push({
        securityId: sid,
        tradingSymbol: sym,
        strike: num(r.drvStrikePrice),
        expiry: String(r.drvExpiryDate ?? '').slice(0, 10),
        shortUnits: -netQty,
        sellAvg: num(r.sellAvg) || num(r.costPrice),
        productType: String(r.productType ?? ''),
      });
    }
  }

  return {
    success: Boolean(bees) || Boolean(positions),
    ts: Date.now(),
    bees,
    beesError,
    brokerCalls,
    brokerShortUnits,
    positionsError: positionsRes.status === 'rejected' ? String((positionsRes.reason as Error)?.message ?? positionsRes.reason) : undefined,
  };
}

// Whole-response memo + in-flight dedupe: several tabs polling this must not
// each spend a holdings call and a quote-lane slot. Stamped with the broker
// cache generation so an order fill invalidates it (dhan-broker-cache).
let memo: { at: number; gen: string; body: CoveredCallBookResponse } | null = null;
let inflight: Promise<CoveredCallBookResponse> | null = null;

export async function GET() {
  const gen = brokerCacheGeneration(['dhan']);
  if (memo && memo.gen === gen && Date.now() - memo.at < RESPONSE_TTL_MS) return NextResponse.json(memo.body);
  try {
    const run = inflight ?? (inflight = build().finally(() => { inflight = null; }));
    const body = await run;
    memo = { at: Date.now(), gen, body };
    return NextResponse.json(body, { status: body.success ? 200 : 502 });
  } catch (err) {
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
