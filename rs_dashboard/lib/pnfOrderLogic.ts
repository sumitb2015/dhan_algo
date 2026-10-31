// Pure rules for the Point & Figure page's trade bar: request validation, order sizing, the close plan, the straddle
// outcome, the paper ledger and the position readout. Tested in lib/pnfOrderLogic.test.ts; the route does the IO.
// The browser only names WHAT to trade (the chart's target) and how many lots: contracts, lot sizes and, for a close,
// the side, quantity and product are all resolved on the server (app/api/straddle-pnf/order/route.ts).

import { isComplete, parseTarget, type Target } from './pnfTarget.ts';

export const MAX_PNF_LOTS = 20;
/** Cash equity is sized in shares. */
export const MAX_PNF_SHARES = 500;

export type PnfBroker = 'dhan' | 'kotak' | 'zerodha';
export type PnfAction = 'BUY' | 'SELL';
/** Dhan's product names; Kotak / Zerodha get MIS / NRML / CNC (brokerProduct). */
export type PnfProduct = 'INTRADAY' | 'MARGIN' | 'CNC';

/** Display info for one leg of the history route's contract (kept for the chart page; never trusted for an order). */
export interface PnfLegInput {
  securityId: string;
  segment: string;
  instrument?: string;
  lot?: number;
  displayName?: string;
  expiry?: string;
  strike?: number;
  optionType?: 'CE' | 'PE';
  underlying?: string;
}

export interface PnfOrderRequest {
  broker: PnfBroker;
  mode: 'PAPER' | 'REAL';
  target: Target;
  /** true = close the whole broker position on the target's contract(s); action / lots / product are then derived. */
  close: boolean;
  action: PnfAction;
  lots: number;
  product: PnfProduct;
  /** 'auto' = the AUTO engine (its own correlation tag / Kotak per-source cap); absent = the trade bar. */
  source: 'bar' | 'auto';
  /**
   * AUTO's exit: close only what AUTO opened — per leg `units` (the ledger's own quantity), capped by what the broker still
   * shows in that direction under the intraday product (planOwnExit). REAL only; never sized from the Lots box.
   */
  exitOwn: { side: PnfAction; units: number[] } | null;
  /** MARKET (default), or a resting LIMIT / SL-limit from the chart's B / S rail (single-leg charts, REAL at the broker). */
  orderType: 'MARKET' | 'LIMIT' | 'SL';
  /** LIMIT: the limit; SL: the limit once triggered. */
  price?: number;
  /** SL only. */
  trigger?: number;
  /** Modify / cancel a resting order this page placed (REAL, single leg). */
  brokerOp: { op: 'modify' | 'cancel'; orderId: string } | null;
}

const ORDER_ID_RE = /^[A-Za-z0-9-]{1,40}$/;

/** A resting order's prices: positive, and an SL-limit's limit on the far side of its trigger (BUY >= trigger, SELL <=). */
export function checkRestingPrices(side: PnfAction, orderType: 'LIMIT' | 'SL', price: unknown, trigger: unknown): { price: number; trigger?: number } | string {
  const p = Number(price);
  if (!Number.isFinite(p) || p <= 0) return 'price must be a positive number';
  if (orderType === 'LIMIT') return { price: p };
  const t = Number(trigger);
  if (!Number.isFinite(t) || t <= 0) return 'an SL-limit needs a positive trigger';
  if (side === 'BUY' ? p < t : p > t) return `a ${side} SL-limit's limit must be ${side === 'BUY' ? 'at or above' : 'at or below'} its trigger`;
  return { price: p, trigger: t };
}

/** The fat-finger band: a resting price further than `maxPct` from the live price is refused (rejected, never clamped). */
export function inBand(price: number, ltp: number, maxPct = 20): boolean {
  return ltp > 0 && price > 0 && Math.abs(price - ltp) / ltp * 100 <= maxPct;
}

export const lotCap = (t: Target) => (t.kind === 'equity' ? MAX_PNF_SHARES : MAX_PNF_LOTS);

/** A request body -> a valid order request, or the reason it is refused. */
export function parsePnfOrder(body: unknown): PnfOrderRequest | string {
  if (!body || typeof body !== 'object') return 'Invalid request';
  const b = body as Record<string, unknown>;
  const broker = b.broker;
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') return 'broker must be dhan, kotak or zerodha';
  const mode = b.mode;
  if (mode !== 'PAPER' && mode !== 'REAL') return 'mode must be PAPER or REAL';
  const target = parseTarget(b.target);
  if (!target || !isComplete(target)) return 'A complete chart target (instrument, expiry, strike, side) is required';
  if (target.kind === 'index') return 'An index cannot be traded directly - pick its future or an option';
  const close = b.close === true;
  const source = b.source === 'auto' ? 'auto' : 'bar';
  const base = { orderType: 'MARKET' as const, brokerOp: null };
  if (close) return { broker, mode, target, close, action: 'SELL', lots: 0, product: 'INTRADAY', source, exitOwn: null, ...base };
  if (b.exitOwn !== undefined) {
    const x = b.exitOwn as { side?: unknown; units?: unknown };
    if (mode !== 'REAL') return 'exitOwn is a REAL-mode exit (paper exits never reach the broker)';
    if (x?.side !== 'BUY' && x?.side !== 'SELL') return 'exitOwn.side must be BUY or SELL';
    const units = Array.isArray(x.units) ? x.units : [];
    if (units.length < 1 || units.length > 2 || !units.every(u => Number.isInteger(u) && (u as number) > 0)) return 'exitOwn.units must be 1-2 positive whole quantities';
    return { broker, mode, target, close: false, action: x.side, lots: 0, product: 'INTRADAY', source, exitOwn: { side: x.side, units: units as number[] }, ...base };
  }

  const action = b.action;
  if (action !== 'BUY' && action !== 'SELL') return 'action must be BUY or SELL';
  const lots = Number(b.lots);
  const cap = lotCap(target);
  const unit = target.kind === 'equity' ? 'shares' : 'lots';
  if (!Number.isInteger(lots) || lots < 1) return `${unit} must be a positive whole number`;
  if (lots > cap) return `Order exceeds the ${cap}-${unit} cap for one order`;
  const product = b.product;
  const allowed: PnfProduct[] = target.kind === 'equity' ? ['INTRADAY', 'CNC'] : ['INTRADAY', 'MARGIN'];
  if (!allowed.includes(product as PnfProduct)) return `product must be ${allowed.join(' or ')} for this instrument`;
  const orderType = b.orderType === undefined || b.orderType === 'MARKET' ? 'MARKET' : b.orderType;
  if (orderType !== 'MARKET' && orderType !== 'LIMIT' && orderType !== 'SL') return 'orderType must be MARKET, LIMIT or SL';
  let brokerOp: PnfOrderRequest['brokerOp'] = null;
  if (b.brokerOp !== undefined) {
    const x = b.brokerOp as { op?: unknown; orderId?: unknown };
    if (x?.op !== 'modify' && x?.op !== 'cancel') return 'brokerOp.op must be modify or cancel';
    if (typeof x.orderId !== 'string' || !ORDER_ID_RE.test(x.orderId)) return 'brokerOp.orderId is invalid';
    if (mode !== 'REAL') return 'Only a REAL resting order is at the broker';
    brokerOp = { op: x.op, orderId: x.orderId };
  }
  if (orderType === 'MARKET') {
    if (brokerOp?.op === 'modify') return 'A modify needs the new LIMIT / SL prices';
    return { broker, mode, target, close, action, lots, product: product as PnfProduct, source, exitOwn: null, orderType, brokerOp };
  }
  const prices = checkRestingPrices(action, orderType, b.price, b.trigger);
  if (typeof prices === 'string') return prices;
  return { broker, mode, target, close, action, lots, product: product as PnfProduct, source, exitOwn: null, orderType, ...prices, brokerOp };
}

export const brokerProduct = (p: PnfProduct, broker: PnfBroker): string =>
  broker === 'dhan' ? p : p === 'INTRADAY' ? 'MIS' : p === 'MARGIN' ? 'NRML' : 'CNC';

/**
 * The broker quantity for `lots` of one leg: shares for cash equity, LOTS for Dhan MCX (Dhan orders MCX in lots), else
 * lots x the broker's own lot size. `lotUnits` is that per-lot broker quantity (1 for equity and Dhan MCX).
 */
export const orderQty = (lots: number, lotUnits: number) => lots * lotUnits;

export interface BookRow { key: string; product: string; net: number }

/** The closing orders for one leg: one per non-flat broker row of that contract, opposite side, |net|, the row's own product. */
export function planLegClose(key: string, rows: BookRow[]): { side: PnfAction; qty: number; product: string }[] {
  return rows
    .filter(r => r.key === key && Number.isFinite(r.net) && r.net !== 0)
    .map(r => ({ side: r.net > 0 ? 'SELL' as const : 'BUY' as const, qty: Math.abs(r.net), product: r.product }));
}

/** `flat`: an AUTO exit found nothing of its own left at the broker (closed elsewhere), so nothing was sent. */
export type LegStatus = 'placed' | 'rejected' | 'unknown' | 'skipped' | 'flat';
export interface LegResult {
  label: string; side: PnfAction; qty: number; product: string; status: LegStatus; orderId?: string; error?: string;
}

/**
 * Opening a straddle sends CE then PE. When CE went in and PE was cleanly refused, CE must be reversed or it stays open
 * alone. An UNKNOWN leg is never reversed (it may have filled and the reversal could open the other side), nor a close.
 */
export const needsRollback = (results: LegResult[], close: boolean): boolean =>
  !close && results.length === 2 && results[0].status === 'placed' && results[1].status === 'rejected';

/**
 * AUTO's exit for one leg: the intraday row of that contract in the direction being closed (a BUY closes a short, net < 0),
 * quantity min(own units, |net|). 0 = nothing of it left at the broker. Other products, and the other direction, are never
 * touched: two charts or a manual trade on the same contract keep what is theirs.
 */
export function planOwnExit(key: string, rows: BookRow[], side: PnfAction, units: number, broker: PnfBroker): { qty: number; product: string } {
  const product = brokerProduct('INTRADAY', broker);
  const net = rows.filter(r => r.key === key && r.product === product).reduce((s, r) => s + (Number(r.net) || 0), 0);
  const open = side === 'BUY' ? Math.max(0, -net) : Math.max(0, net);
  return { qty: Math.min(units, open), product };
}

/** One word for a send: every leg placed, none, some (a leg is live alone), or an outcome the broker did not confirm. */
export function sendOutcome(results: LegResult[]): 'placed' | 'rejected' | 'partial' | 'unknown' | 'flat' {
  if (results.some(r => r.status === 'unknown')) return 'unknown';
  const sent = results.filter(r => r.status !== 'flat');
  if (!sent.length) return results.length ? 'flat' : 'rejected';
  const placed = sent.filter(r => r.status === 'placed').length;
  if (placed === sent.length) return 'placed';
  return placed === 0 ? 'rejected' : 'partial';
}

// ── Paper ledger ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** One paper leg: signed lots, average price, booked rupees. */
export interface PaperLeg { lots: number; avg: number; realised: number }
export const FLAT_LEG: PaperLeg = { lots: 0, avg: 0, realised: 0 };

/**
 * A paper fill of `deltaLots` (signed) at `price`. Adding averages the price; reducing books (price - avg) on the closed
 * lots; crossing zero books the whole old side and opens the rest at `price`. `unitsPerLot` turns points into rupees.
 */
export function applyPaperFill(leg: PaperLeg, deltaLots: number, price: number, unitsPerLot: number): PaperLeg {
  if (deltaLots === 0) return leg;
  if (leg.lots === 0 || Math.sign(leg.lots) === Math.sign(deltaLots)) {
    const lots = leg.lots + deltaLots;
    return { lots, avg: (leg.avg * Math.abs(leg.lots) + price * Math.abs(deltaLots)) / Math.abs(lots), realised: leg.realised };
  }
  const closed = Math.min(Math.abs(leg.lots), Math.abs(deltaLots));
  const realised = leg.realised + (price - leg.avg) * closed * Math.sign(leg.lots) * unitsPerLot;
  const lots = leg.lots + deltaLots;
  return { lots, avg: lots === 0 ? 0 : Math.sign(lots) === Math.sign(leg.lots) ? leg.avg : price, realised };
}

/** Booked + open paper P&L in rupees; a leg without a price counts only what it booked. */
export function paperPnl(legs: PaperLeg[], prices: (number | null)[], unitsPerLot: number[]): number {
  return legs.reduce((sum, l, i) => {
    const px = prices[i];
    const open = l.lots !== 0 && px != null && px > 0 ? (px - l.avg) * l.lots * (unitsPerLot[i] ?? 1) : 0;
    return sum + l.realised + open;
  }, 0);
}

// ── Position readout ─────────────────────────────────────────────────────────────────────────────────────────────────

const lotWord = (n: number, equity: boolean) => (equity ? `${n} sh` : `${n} lot${n === 1 ? '' : 's'}`);
const fmtLots = (n: number) => String(Math.round(n * 100) / 100);

/**
 * The position on the chart's contract(s) from signed lots per leg: `LONG 2 lots`, a matched straddle as
 * `SHORT 1 lot straddle`, anything else per leg (`CE -1 · PE +2`). Null when flat.
 */
export function describePosition(lots: number[], sides: string[], equity: boolean): { side: 'LONG' | 'SHORT' | 'MIXED'; text: string } | null {
  if (lots.every(n => n === 0)) return null;
  if (lots.length === 1) {
    const n = lots[0];
    return { side: n > 0 ? 'LONG' : 'SHORT', text: `${n > 0 ? 'LONG' : 'SHORT'} ${lotWord(Number(fmtLots(Math.abs(n))), equity)}` };
  }
  if (lots[0] === lots[1]) {
    const n = lots[0];
    return { side: n > 0 ? 'LONG' : 'SHORT', text: `${n > 0 ? 'LONG' : 'SHORT'} ${lotWord(Number(fmtLots(Math.abs(n))), false)} straddle` };
  }
  return { side: 'MIXED', text: lots.map((n, i) => `${sides[i]} ${n > 0 ? '+' : n < 0 ? '−' : ''}${fmtLots(Math.abs(n))}`).join(' · ') };
}
