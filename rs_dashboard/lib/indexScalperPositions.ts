// Pure position / P&L / order-sizing rules for /index-scalper. No React, no fetch.
//
// Positions come from the broker (REAL) or from the SIM ledger; both are normalised to ScalperLeg so the chart overlay and
// the positions strip have one shape. Quantity is always UNITS (NSE index options: lots x lot size).

import { parseTradingSymbol } from './positionLegs.ts';

export interface ScalperLeg {
  /** Stable key: Dhan security id (REAL) or the same id for the SIM row. */
  id: string;
  securityId: string;
  symbol: string;
  strike: number;
  type: 'CE' | 'PE';
  /** Signed units: >0 long, <0 short. */
  netQty: number;
  /** Average price of the open quantity (premium). */
  avg: number;
  /** Last traded premium, null when unknown (never 0: unknown is not zero). */
  ltp: number | null;
  sim: boolean;
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
  return (leg.ltp - leg.avg) * leg.netQty;
}

export function totalPnl(legs: ScalperLeg[]): number | null {
  let sum = 0;
  let any = false;
  for (const l of legs) {
    const p = legPnl(l);
    if (p === null) continue;
    sum += p;
    any = true;
  }
  return any ? sum : null;
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

/** Units to close for `leg`: always the position's own open quantity (capped by what is live), side opposite to it. */
export function closeOrder(leg: ScalperLeg, liveNetQty: number): { side: 'BUY' | 'SELL'; units: number } | null {
  if (liveNetQty === 0) return null;
  // Never exceed what the broker still shows, and never flip a position the broker has already reduced.
  const units = Math.abs(liveNetQty);
  if (leg.netQty !== 0 && Math.sign(leg.netQty) !== Math.sign(liveNetQty)) return null;
  return { side: liveNetQty > 0 ? 'SELL' : 'BUY', units };
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

/** NIFTY option strike/type out of a Dhan trading symbol ("NIFTY-Dec2026-25350-PE"); null for anything else
 *  (BANKNIFTY, FINNIFTY, futures, other brokers' formats). Parsing is lib/positionLegs.ts's, not a private copy. */
export function parseNiftyOption(tradingSymbol: string): { strike: number; type: 'CE' | 'PE' } | null {
  const p = parseTradingSymbol(tradingSymbol);
  if (!p || p.underlying !== 'NIFTY' || !Number.isFinite(p.strike)) return null;
  return { strike: p.strike, type: p.type === 'CE' ? 'CE' : 'PE' };
}

/** Normalise raw Dhan position rows into NIFTY option legs (open quantity only). */
export function legsFromDhanPositions(rows: Record<string, unknown>[], ltpById: Map<string, number>): ScalperLeg[] {
  const out: ScalperLeg[] = [];
  for (const r of rows) {
    const sym = String(r.tradingSymbol ?? r.trading_symbol ?? '');
    const parsed = parseNiftyOption(sym);
    if (!parsed) continue;
    const netQty = Number(r.netQty);
    if (!Number.isFinite(netQty) || netQty === 0) continue;
    const securityId = String(r.securityId ?? r.security_id ?? '');
    if (!securityId) continue;
    const avgRaw = netQty > 0 ? Number(r.buyAvg) : Number(r.sellAvg);
    const avg = Number.isFinite(avgRaw) && avgRaw > 0 ? avgRaw : Number(r.costPrice);
    if (!Number.isFinite(avg) || avg <= 0) continue;
    const live = ltpById.get(securityId);
    out.push({
      id: securityId, securityId, symbol: sym, strike: parsed.strike, type: parsed.type,
      netQty, avg, ltp: live !== undefined && live > 0 ? live : null, sim: false,
    });
  }
  return out;
}

export function fmtRupees(n: number | null): string {
  if (n === null) return '—';
  const sign = n > 0 ? '+' : n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}
