// Pure position / P&L / order-sizing rules for /index-scalper. No React, no fetch.
//
// Positions come from the broker (REAL) or from the SIM ledger; both are normalised to ScalperLeg so the chart overlay and
// the positions strip have one shape. Quantity is always UNITS (NSE index options: lots x lot size).

import { parseTradingSymbol } from './positionLegs.ts';
import { dedupePositions, positionProduct } from './positionProduct.ts';
import { pnlMultiplier, type Underlying } from './indexScalperInstrument.ts';

export interface ScalperLeg {
  /** Stable key: `securityId|product` for a REAL broker row (a security can carry an INTRADAY and a MARGIN row), the
   *  security id for a SIM row. Entry spots are keyed by `securityId`, not by this. */
  id: string;
  securityId: string;
  /** Broker product of a REAL row (INTRADAY / MARGIN); '' for SIM. */
  product: string;
  symbol: string;
  strike: number;
  type: 'CE' | 'PE' | 'FUT';
  /** Signed units: >0 long, <0 short. */
  netQty: number;
  /** Average price of the open quantity (premium). */
  avg: number;
  /** Last traded premium, null when unknown (never 0: unknown is not zero). */
  ltp: number | null;
  sim: boolean;
  /** Multiplier per point per netQty unit (Dhan CRUDEOILM 10, else 1). */
  mult?: number;
}

/** Index level this leg is drawn at on the chart: the spot recorded when this page opened it, else the strike. */
export interface LegAnchor { level: number; kind: 'entry' | 'strike' }

export function legAnchor(leg: ScalperLeg, spotAtEntry: number | undefined): LegAnchor {
  if (spotAtEntry !== undefined && Number.isFinite(spotAtEntry) && spotAtEntry > 0) return { level: spotAtEntry, kind: 'entry' };
  return { level: leg.strike, kind: 'strike' };
}

/** Open P&L in rupees; null when the LTP is unknown. */
export function legPnl(leg: ScalperLeg): number | null {
  if (leg.ltp === null || !Number.isFinite(leg.ltp)) return null;
  const mult = leg.mult ?? 1;
  return (leg.ltp - leg.avg) * leg.netQty * mult;
}

export function totalPnl(legs: ScalperLeg[]): number | null {
  return pnlSummary(legs).pnl;
}

/** Open P&L plus how many legs it leaves out for want of a live price, so a partial total is never shown as complete. */
export function pnlSummary(legs: ScalperLeg[]): { pnl: number | null; unpriced: number } {
  let sum = 0;
  let any = false;
  let unpriced = 0;
  for (const l of legs) {
    const p = legPnl(l);
    if (p === null) { unpriced++; continue; }
    sum += p;
    any = true;
  }
  return { pnl: any ? sum : null, unpriced };
}

/** Hard cap on lots per click (also enforced server-side through the `isx` source cap). */
export const MAX_LOTS = 20;

export type SizeCheck = { ok: true; units: number } | { ok: false; error: string };

/** Units for an order of `lots`, or why it is refused. A lot size that is unknown is refused, never guessed. */
export function orderUnits(lots: number, lotSize: number | null): SizeCheck {
  if (lotSize === null || !Number.isInteger(lotSize) || lotSize <= 0) return { ok: false, error: 'Lot size unknown' };
  if (!Number.isInteger(lots) || lots < 1) return { ok: false, error: 'Lots must be a whole number, at least 1' };
  if (lots > MAX_LOTS) return { ok: false, error: `Max ${MAX_LOTS} lots per order` };
  return { ok: true, units: lots * lotSize };
}

/** correlationId prefix the order route stamps on every order this page sends (`source: 'isx'`). */
export const ISX_SOURCE = 'isx';

export const ownKey = (securityId: string, product: string) => `${securityId}|${product.toUpperCase()}`;

/** Signed units this page's own orders have FILLED today, per `ownKey(securityId, product)`, read from Dhan's order
 *  book (every order this page sends carries an `isx…` correlationId). Unfilled / rejected orders count 0 — only
 *  `filledQty` moves ownership — and this page's exits net it back down. Quantity opened by a strategy, another terminal
 *  or by hand never appears here, so it can never be closed from this page. */
export function ownedQtyFromOrders(orders: Record<string, unknown>[], source = ISX_SOURCE): Map<string, number> {
  const out = new Map<string, number>();
  for (const o of orders) {
    if (!String(o.correlationId ?? '').startsWith(source)) continue;
    const filled = Number(o.filledQty);
    if (!Number.isFinite(filled) || filled <= 0) continue;
    const side = String(o.transactionType ?? '').toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') continue;
    const securityId = String(o.securityId ?? '');
    if (!securityId) continue;
    const k = ownKey(securityId, String(o.productType ?? ''));
    out.set(k, (out.get(k) ?? 0) + (side === 'BUY' ? filled : -filled));
  }
  return out;
}

/** Close order for one broker row: what this page owns, clamped by what the broker still shows, side opposite to it.
 *  null when the page owns nothing in that direction (the rest belongs to someone else and is left alone). */
export function ownedCloseOrder(brokerNet: number, owned: number): { side: 'BUY' | 'SELL'; units: number } | null {
  if (!Number.isFinite(brokerNet) || !Number.isFinite(owned) || brokerNet === 0 || owned === 0) return null;
  if (Math.sign(brokerNet) !== Math.sign(owned)) return null;
  return { side: brokerNet > 0 ? 'SELL' : 'BUY', units: Math.min(Math.abs(brokerNet), Math.abs(owned)) };
}

/** Apply a fill to a signed position, returning the new net qty and average (average of the open lot only). */
export function applyFill(netQty: number, avg: number, side: 'BUY' | 'SELL', units: number, price: number): { netQty: number; avg: number } {
  const signed = side === 'BUY' ? units : -units;
  const next = netQty + signed;
  if (next === 0) return { netQty: 0, avg: 0 };
  // Adding to (or opening) a position blends the average; reducing keeps it; flipping restarts at the fill price.
  if (netQty === 0 || Math.sign(netQty) === Math.sign(signed)) {
    return { netQty: next, avg: (Math.abs(netQty) * avg + units * price) / Math.abs(next) };
  }
  if (Math.sign(next) === Math.sign(netQty)) return { netQty: next, avg };
  return { netQty: next, avg: price };
}

/** Option or futures contract out of a trading symbol ("NIFTY-Dec2026-25350-PE", "CRUDEOILM-17Nov2026-9000-CE", "CRUDEOILM-19Nov2026-FUT"). */
export function parseScalperContract(tradingSymbol: string, underlying: Underlying = 'NIFTY'): { strike: number; type: 'CE' | 'PE' | 'FUT' } | null {
  const p = parseTradingSymbol(tradingSymbol);
  if (p && p.underlying === underlying && (p.type === 'CE' || p.type === 'PE')) {
    return { strike: p.strike, type: p.type };
  }
  const s = tradingSymbol.trim().toUpperCase();
  // Check future: starts with the underlying root, followed by digits/hyphen, ending with FUT
  if (s.startsWith(underlying) && (/-(?:FUT|\d{2}[A-Z]{3}\d{4}-FUT)$/.test(s) || /FUT$/.test(s))) {
    return { strike: 0, type: 'FUT' };
  }
  return null;
}

/** NIFTY option strike/type out of a Dhan trading symbol ("NIFTY-Dec2026-25350-PE"); null for anything else. Kept for backwards compatibility. */
export function parseNiftyOption(tradingSymbol: string): { strike: number; type: 'CE' | 'PE' } | null {
  const parsed = parseScalperContract(tradingSymbol, 'NIFTY');
  if (parsed && (parsed.type === 'CE' || parsed.type === 'PE')) return { strike: parsed.strike, type: parsed.type };
  return null;
}

/** Normalise raw Dhan position rows into Scalper legs (open quantity only), one per (security, product) row.
 *  Dhan's verbatim duplicate rows are collapsed first so no leg is counted or closed twice. */
export function legsFromDhanPositions(
  rows: Record<string, unknown>[],
  ltpById: Map<string, number>,
  underlying: Underlying = 'NIFTY',
): ScalperLeg[] {
  const out: ScalperLeg[] = [];
  const seen = new Set<string>();
  const mult = pnlMultiplier(underlying, 'dhan');
  for (const r of dedupePositions(rows)) {
    const sym = String(r.tradingSymbol ?? r.trading_symbol ?? '');
    const parsed = parseScalperContract(sym, underlying);
    if (!parsed) continue;
    const netQty = Number(r.netQty);
    if (!Number.isFinite(netQty) || netQty === 0) continue;
    const securityId = String(r.securityId ?? r.security_id ?? '');
    if (!securityId) continue;
    const avgRaw = netQty > 0 ? Number(r.buyAvg) : Number(r.sellAvg);
    const avg = Number.isFinite(avgRaw) && avgRaw > 0 ? avgRaw : Number(r.costPrice);
    if (!Number.isFinite(avg) || avg <= 0) continue;
    const product = positionProduct(r);
    const id = ownKey(securityId, product);
    if (seen.has(id)) continue;
    seen.add(id);
    const live = ltpById.get(securityId);
    out.push({
      id, securityId, product, symbol: sym, strike: parsed.strike, type: parsed.type,
      netQty, avg, ltp: live !== undefined && live > 0 ? live : null, sim: false, mult,
    });
  }
  return out;
}

export function fmtRupees(n: number | null): string {
  if (n === null) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

/** NSE index options trade in steps of Rs 0.05. */
export const OPTION_TICK = 0.05;

/** Why a limit / trigger price is off the exchange tick, with the two nearest valid prices; null when it is on a tick.
 *  The ticket refuses instead of rounding: a real-money price is never changed behind the user's back, and Dhan would
 *  reject the off-tick price anyway. */
export function tickError(label: string, price: number, tick = OPTION_TICK): string | null {
  if (!Number.isFinite(price) || price <= 0) return null;
  const paise = price * 100;
  const step = Math.round(tick * 100);
  const whole = Math.round(paise);
  if (Math.abs(paise - whole) < 1e-6 && whole % step === 0) return null;
  const lo = Math.floor(paise / step + 1e-9) * step;
  return `${label} ${price} is not a multiple of ₹${tick.toFixed(2)}: use ${(lo / 100).toFixed(2)} or ${((lo + step) / 100).toFixed(2)}`;
}
