/**
 * Fresh Money board — the per-broker half of the trade route (server only). REAL MONEY.
 *
 * Prices always come from Dhan (the board and P&L are Dhan-keyed); only ORDERS and the broker's own order / position
 * books go to Kotak or Zerodha. Each broker's three-way outcome (placed / rejected / unknown) is kept as is.
 *  - Dhan:    placeDhanOrder with our correlationId; an UNKNOWN is looked up by /orders/external/{correlationId}.
 *  - Kotak:   buildKotakOrderPayload + placeKotakOrder (no idempotency key); an UNKNOWN is looked up in the order
 *             book by symbol / side / quantity / time (findRecentKotakOrder, unique match only).
 *  - Zerodha: Kite /orders/regular with our own tag; an UNKNOWN is looked up by that tag.
 */
import { placeDhanOrder } from '@/lib/dhanPlaceOrder';
import { dhanGet, getDhanCredentials } from '@/lib/dhanToken';
import { readBrokerOrder } from '@/lib/brokerOrderStatus';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { kotakOptionContract, kotakDerivativeBySymbol } from '@/lib/kotakContracts';
import { buildKotakOrderPayload } from '@/lib/kotakOrderPayload';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { isKotakTokenValid, kotakGet, kotakRows, kotakPriority, KOTAK_PATHS } from '@/lib/kotakToken';
import { findRecentKotakOrder, shapeKotakPosition } from '@/lib/kotakShape';
import { zerodhaOptionContract, cachedZerodhaContract, slicesFor } from '@/lib/zerodhaContracts';
import { zerodhaLotCapError } from '@/lib/zerodhaOrderRules';
import { placeZerodhaOrder, findOrderByTag } from '@/lib/zerodhaPlaceOrder';
import { isZerodhaTokenValid, kiteGet } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition } from '@/lib/zerodhaShape';
import { stateFromBroker, type FmBroker, type FmOrder, type OptType, type TxnSide } from '@/lib/freshMoneyTrades';

export const BROKERS: readonly FmBroker[] = ['dhan', 'kotak', 'zerodha'];
export const brokerName = (b: FmBroker) => (b === 'kotak' ? 'Kotak' : b === 'zerodha' ? 'Zerodha' : 'Dhan');
const isMcx = (u: string) => u === 'CRUDEOIL' || u === 'CRUDEOILM';

/** Whether the broker's session is usable right now (no network call). */
export function brokerSessionOk(b: FmBroker): boolean {
  if (b === 'kotak') return isKotakTokenValid();
  if (b === 'zerodha') return isZerodhaTokenValid();
  try { getDhanCredentials(); return true; } catch { return false; }
}

/** The broker's contract handle and its own lot size (null when its master does not list the contract). */
export async function brokerContract(
  b: FmBroker, underlying: string, expiry: string, strike: number, opt: OptType,
): Promise<{ handle: string; brokerLot: number | null } | null> {
  if (b === 'kotak') {
    const c = await kotakOptionContract(underlying, expiry, strike, opt).catch(() => null);
    return c ? { handle: c.tradingsymbol, brokerLot: c.lotSize } : null;
  }
  if (b === 'zerodha') {
    const c = await zerodhaOptionContract(underlying, expiry, strike, opt).catch(() => null);
    return c ? { handle: c.tradingsymbol, brokerLot: c.lotSize } : null;
  }
  return null; // Dhan: the caller already has Dhan's contract
}

/** A correlation id the broker accepts (Dhan correlationId <= 25, Kite tag alphanumeric <= 20). */
export function newCorrelationId(b: FmBroker): string {
  const r = crypto.randomUUID().replace(/-/g, '');
  return b === 'zerodha' ? `FM${r.slice(0, 18)}` : `fm${Date.now().toString(36)}${r.slice(0, 8)}`;
}

export type SendOutcome = { status: 'placed'; orderId: string } | { status: 'rejected'; error: string; http?: number } | { status: 'unknown'; error: string };

/** One MARKET, intraday order. `open` orders carry the 'fm' source (per-order lot caps); closes never do. */
export async function sendOrder(
  o: Pick<FmOrder, 'broker' | 'securityId' | 'segment' | 'underlying' | 'side' | 'qty' | 'correlationId'>, open: boolean,
): Promise<SendOutcome> {
  const b = o.broker ?? 'dhan';
  if (!brokerSessionOk(b)) return { status: 'rejected', error: `${brokerName(b)} is not logged in — nothing was sent`, http: 409 };
  if (b === 'kotak') {
    const built = buildKotakOrderPayload({
      tradingsymbol: o.securityId, quantity: o.qty, side: o.side, exchange: isMcx(o.underlying) ? 'mcx_fo' : 'nse_fo',
      product: 'MIS', orderType: 'MARKET', ...(open ? { source: 'fm' } : {}),
    }, kotakDerivativeBySymbol(o.securityId, o.underlying));
    if ('error' in built) return { status: 'rejected', error: built.error, http: 400 };
    const r = await placeKotakOrder(built.payload);
    if (r.status === 'placed') { invalidateBrokerCache('kotak'); return { status: 'placed', orderId: r.orderId }; }
    return r;
  }
  if (b === 'zerodha') {
    const contract = cachedZerodhaContract(o.securityId);
    const capError = zerodhaLotCapError(o.qty, open ? 'fm' : undefined, o.securityId, contract);
    if (capError) return { status: 'rejected', error: capError, http: 400 };
    // One order = one order id this ledger tracks: an order Kite would need cut at the freeze is refused (20 lots stay
    // under every freeze today), never silently split.
    if (slicesFor(o.securityId, o.qty).length > 1) return { status: 'rejected', error: `${o.qty} is above the exchange freeze quantity for one Zerodha order — use fewer lots`, http: 400 };
    const r = await placeZerodhaOrder({
      tradingsymbol: o.securityId, exchange: isMcx(o.underlying) ? 'MCX' : 'NFO', transaction_type: o.side,
      order_type: 'MARKET', quantity: o.qty, product: 'MIS', validity: 'DAY', market_protection: -1,
    }, o.correlationId);
    if (r.status === 'placed') { invalidateBrokerCache('zerodha'); return { status: 'placed', orderId: r.orderId }; }
    return r;
  }
  const r = await placeDhanOrder({
    securityId: o.securityId, quantity: o.qty, side: o.side, orderType: 'MARKET', exchangeSegment: o.segment ?? 'NSE_FNO',
    productType: 'INTRADAY', ...(open ? { source: 'fm' } : {}), correlationId: o.correlationId,
  });
  if (r.status === 'invalid') return { status: 'rejected', error: r.error, http: r.http };
  return r;
}

/** Read one unsettled order; the patch, or null when nothing new is known. Throws when the book is unreadable. */
export async function readOrder(o: FmOrder, unknown: boolean): Promise<Partial<FmOrder> | null> {
  const b = o.broker ?? 'dhan';
  if (!o.orderId) {
    if (!unknown) return null;
    // An UNKNOWN: find the order it became, if the broker booked it.
    let orderId: string | null = null;
    if (b === 'zerodha') orderId = findOrderByTag(await kiteGet('/orders'), o.correlationId);
    else if (b === 'kotak') orderId = findRecentKotakOrder(kotakRows(await kotakGet(KOTAK_PATHS.orderBook)), { symbol: o.securityId, side: o.side, qty: o.qty, since: o.ts });
    else {
      const raw = await dhanGet(`/orders/external/${o.correlationId}`, 5_000);
      const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | null;
      if (row && String(row.correlationId ?? '') === o.correlationId && row.orderId) orderId = String(row.orderId);
    }
    // Adopt the id; its fill and price are read next round.
    return orderId ? { orderId, state: 'pending' } : null;
  }
  const s = await readBrokerOrder(o.orderId, b);
  if (!s) return null;
  const avgPrice = s.averageTradedPrice > 0 ? s.averageTradedPrice : null;
  // readBrokerOrder already speaks Dhan's vocabulary for all three (classifyKotakStatus / classifyZerodhaStatus: exact
  // matches, so "CANCEL PENDING" stays live).
  const state = stateFromBroker(s.orderStatus, s.filledQty, o.qty, avgPrice);
  if (state === o.state && s.filledQty === o.filledQty && avgPrice === o.avgPrice) return null;
  return { filledQty: s.filledQty, avgPrice, state, reason: s.reason || undefined };
}

const INTRADAY: Record<FmBroker, string> = { dhan: 'INTRADAY', kotak: 'MIS', zerodha: 'MIS' };

/**
 * The broker's intraday net quantity per contract handle (Dhan security id / trading symbol), in the broker's own unit,
 * or null when the book cannot be read. Live (never cached): close sizing reads it.
 */
export async function brokerNets(b: FmBroker): Promise<Map<string, number> | null> {
  try {
    const out = new Map<string, number>();
    const add = (key: string, product: string, net: number) => {
      if (product.toUpperCase() !== INTRADAY[b]) return;
      out.set(key, (out.get(key) ?? 0) + net);
    };
    if (b === 'dhan') {
      const rows = await dhanGet('/positions', 6_000);
      if (!Array.isArray(rows)) return null;
      for (const r of rows as Record<string, unknown>[]) add(String(r.securityId ?? ''), String(r.productType ?? ''), Number(r.netQty) || 0);
    } else if (b === 'zerodha') {
      const net = (await kiteGet('/portfolio/positions') as { net?: Record<string, unknown>[] } | null)?.net;
      if (!Array.isArray(net)) return null;
      for (const p of net.map(shapeZerodhaPosition)) add(p.tradingSymbol, String(p.productType ?? ''), Number(p.netQty) || 0);
    } else {
      kotakPriority(2_500);
      for (const p of kotakRows(await kotakGet(KOTAK_PATHS.positions)).map(shapeKotakPosition)) add(p.tradingSymbol, String(p.productType ?? ''), Number(p.netQty) || 0);
    }
    return out;
  } catch {
    return null;
  }
}

export type { TxnSide };
