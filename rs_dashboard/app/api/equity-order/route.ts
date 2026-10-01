import { NextRequest, NextResponse } from 'next/server';
import { dhanGet, getDhanCredentials } from '@/lib/dhanToken';
import { getCachedFunds, invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { findEquity } from '@/lib/equityMaster';
import { fetchEquityLtp } from '@/lib/dhanEquityQuote';
import { fetchHoldingsLive, fetchIntradayLongQty, fetchPendingSellQty, readEquityPortfolio, sellableQty } from '@/lib/dhanEquityPortfolio';
import { validateOrder, MAX_ORDER_VALUE, MAX_QTY_PER_ORDER, LIMIT_BAND } from '@/lib/equityOrder';

/**
 * NSE cash-equity order ticket (Dhan).
 *
 * GET  ?symbol=ENGINERSIN → what the ticket needs: live price, tick, current holding, today's
 *      positions and available funds.
 * POST → place ONE order.  REAL MONEY.  The client sends only symbol/side/product/type/qty/price;
 *      the security id and tick come from master_list.csv, the live price from Dhan, and a
 *      delivery sell is checked against a fresh holdings read — none of it trusts the browser.
 */

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';
const RECONCILE_ATTEMPTS = 4;
const RECONCILE_GAP_MS = 1_500;
const IDEMPOTENCY_TTL_MS = 2 * 60_000;

export async function GET(req: NextRequest) {
  const symbol = (req.nextUrl.searchParams.get('symbol') ?? '').trim();
  const eq = symbol ? findEquity(symbol) : null;
  if (!eq) return NextResponse.json({ success: false, error: `Unknown NSE stock "${symbol}"` }, { status: 404 });

  const [ltp, portfolio, funds] = await Promise.allSettled([
    fetchEquityLtp(eq.securityId),
    readEquityPortfolio(),
    getCachedFunds('dhan', () => dhanGet('/fundlimit')),
  ]);
  const held = portfolio.status === 'fulfilled' ? portfolio.value[eq.symbol] : undefined;
  const f = funds.status === 'fulfilled' ? (funds.value as Record<string, unknown>) : null;
  const available = f ? Number(f.availabelBalance ?? f.availableBalance ?? NaN) : NaN; // Dhan spells it "availabelBalance"

  return NextResponse.json({
    success: true,
    data: {
      symbol: eq.symbol,
      name: eq.name,
      securityId: eq.securityId,
      series: eq.series,
      tick: eq.tick,
      ltp: ltp.status === 'fulfilled' ? ltp.value : null,
      ltpError: ltp.status === 'rejected' ? String(ltp.reason?.message ?? ltp.reason) : null,
      holding: { totalQty: held?.totalQty ?? 0, availableQty: held?.availableQty ?? 0, avgCost: held?.avgCost ?? 0 },
      positions: held?.positions ?? [],
      portfolioError: portfolio.status === 'rejected' ? String(portfolio.reason?.message ?? portfolio.reason) : null,
      availableFunds: Number.isFinite(available) ? available : null,
      limits: { maxQty: MAX_QTY_PER_ORDER, maxValue: MAX_ORDER_VALUE, limitBand: LIMIT_BAND },
    },
  });
}

/**
 * The place call timed out, errored, or came back 5xx: we do not know whether Dhan booked it.
 * Look it up by our correlationId rather than reporting a failure — a "failed" order that went
 * through invites a duplicate on retry (same approach as options-screener/order).
 */
async function reconcileByCorrelationId(correlationId: string, clientId: string, token: string) {
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RECONCILE_GAP_MS));
    try {
      const res = await fetch(`${DHAN_ORDERS}/external/${correlationId}`, {
        headers: { 'access-token': token, 'client-id': clientId, Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown> | Record<string, unknown>[];
      const r = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
      if (r && String(r.correlationId ?? '') === correlationId && r.orderId) {
        return { orderId: String(r.orderId), orderStatus: r.orderStatus ?? null };
      }
    } catch { /* Dhan may still be catching up */ }
  }
  return null;
}

interface Outcome { status: number; body: Record<string, unknown> }

// One ticket = one order. A double click or a client retry with the same key gets the first
// result back instead of placing twice. Only a booked order or an unknown outcome is remembered;
// a plain rejection is forgotten so a corrected retry can go through.
// State lives on globalThis so a dev reload / second module copy cannot hand out a second order for one key.
interface RouteState { recent: Map<string, { at: number; outcome: Promise<Outcome> }>; sellLocks: Map<string, Promise<unknown>> }
const g = globalThis as { __equityOrderState?: RouteState };
const state: RouteState = (g.__equityOrderState ??= { recent: new Map(), sellLocks: new Map() });
const recent = state.recent;

/**
 * Sells of one security run one at a time, so the second sell's ownership check sees the first
 * sell's open order instead of both reading the same untouched position (a double-sell must not
 * be able to turn into a short).
 */
function withSellLock<T>(securityId: string, fn: () => Promise<T>): Promise<T> {
  const prev = state.sellLocks.get(securityId) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  const tail = run.catch(() => undefined);
  state.sellLocks.set(securityId, tail);
  void tail.then(() => { if (state.sellLocks.get(securityId) === tail) state.sellLocks.delete(securityId); });
  return run;
}

function prune() {
  const now = Date.now();
  for (const [k, v] of recent) if (now - v.at > IDEMPOTENCY_TTL_MS) recent.delete(k);
}

async function place(body: Record<string, unknown>): Promise<Outcome> {
  const fail = (status: number, error: string, extra: Record<string, unknown> = {}): Outcome => ({
    status, body: { success: false, error, ...extra },
  });

  const eq = findEquity(String(body.symbol ?? ''));
  if (!eq) return fail(400, `Unknown NSE stock "${String(body.symbol ?? '')}"`);

  let ltp: number;
  let availableQty = 0;
  let intradayLongQty = 0;
  let pendingSellQty = 0;
  try {
    ltp = await fetchEquityLtp(eq.securityId);
  } catch (e) {
    return fail(503, `Could not get a live price for ${eq.symbol} (${String((e as Error).message ?? e)}). Nothing was ordered — try again.`);
  }
  // A SELL is checked against a FRESH read of what the account owns (never the cached display read).
  // If it cannot be read, nothing is sold.
  if (body.side === 'SELL') {
    try {
      const product = body.product === 'INTRADAY' ? 'INTRADAY' : 'CNC';
      if (product === 'INTRADAY') intradayLongQty = await fetchIntradayLongQty(eq.securityId);
      else availableQty = sellableQty(await fetchHoldingsLive(), eq.securityId).availableQty;
      pendingSellQty = await fetchPendingSellQty(eq.securityId, product);
    } catch (e) {
      return fail(503, `Could not confirm what you hold in ${eq.symbol} (${String((e as Error).message ?? e)}). Nothing was sold — try again.`);
    }
  }

  const v = validateOrder(body, { ltp, tick: eq.tick, availableQty, intradayLongQty, pendingSellQty });
  if (!v.ok) return fail(400, v.error);
  const o = v.order;

  let creds: { clientId: string; token: string };
  try {
    creds = getDhanCredentials();
  } catch (e) {
    return fail(500, `Dhan token unavailable: ${String(e)}`);
  }

  const correlationId = `eq${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  const label = `${o.side} ${o.quantity} ${eq.symbol}`;
  const summary = `${label} · ${o.product === 'CNC' ? 'Delivery (CNC)' : 'Intraday (MIS)'} · ${o.orderType}${o.orderType === 'LIMIT' ? ` @ ${o.price}` : ''}${o.amo ? ' · AMO' : ''}`;

  const payload: Record<string, unknown> = {
    dhanClientId: creds.clientId,
    correlationId,
    transactionType: o.side,
    exchangeSegment: 'NSE_EQ',
    productType: o.product,
    orderType: o.orderType,
    validity: 'DAY',
    securityId: eq.securityId,
    quantity: o.quantity,
    disclosedQuantity: 0,
    price: o.price,
    triggerPrice: 0,
    afterMarketOrder: o.amo,
  };
  if (o.amo) payload.amoTime = 'OPEN';

  const unknownOutcome = async (why: string): Promise<Outcome> => {
    const found = await reconcileByCorrelationId(correlationId, creds.clientId, creds.token);
    invalidateBrokerCache('dhan');
    if (found) return { status: 200, body: { success: true, orderId: found.orderId, orderStatus: found.orderStatus, summary, product: o.product } };
    return fail(504, `Order status unknown (${why}). Dhan did not confirm ${label} — check the Dhan order book before placing it again.`, { unknown: true });
  };

  let res: Response;
  try {
    res = await fetch(DHAN_ORDERS, {
      method: 'POST',
      headers: { 'access-token': creds.token, 'client-id': creds.clientId, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return unknownOutcome(String(e));
  }
  // A gateway error can arrive after the order was booked; a 4xx/429 is a pre-booking rejection.
  if (res.status >= 500) return unknownOutcome(`HTTP ${res.status}`);

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
  if (!orderId) {
    const err = String(json.errorMessage ?? json.remarks ?? json.message ?? JSON.stringify(json));
    return fail(502, `Dhan rejected ${label}: ${err}`);
  }
  invalidateBrokerCache('dhan');
  return { status: 200, body: { success: true, orderId, orderStatus: json.orderStatus ?? null, summary, product: o.product } };
}

function eqForLock(body: Record<string, unknown>): string | null {
  return findEquity(String(body.symbol ?? ''))?.securityId ?? null;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });

  const key = typeof body.clientKey === 'string' && body.clientKey.length >= 8 ? body.clientKey.slice(0, 64) : '';
  if (!key) return NextResponse.json({ success: false, error: 'clientKey is required' }, { status: 400 });

  prune();
  const existing = recent.get(key);
  if (existing) {
    const o = await existing.outcome;
    return NextResponse.json(o.body, { status: o.status });
  }

  const outcome = body.side === 'SELL' && eqForLock(body) ? withSellLock(eqForLock(body) as string, () => place(body)) : place(body);
  recent.set(key, { at: Date.now(), outcome });
  const o = await outcome;
  if (!o.body.success && !o.body.unknown) recent.delete(key); // rejected before booking: allow a corrected retry
  return NextResponse.json(o.body, { status: o.status });
}
