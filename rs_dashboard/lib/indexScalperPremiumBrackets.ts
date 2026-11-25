// Target / stop loss for an OPTION leg managed from the underlying chart (Quick Trade): levels are option PREMIUMS,
// typed into the strike position chip, never index levels dragged on the index axis. Pure: no React. Tested in
// indexScalperPremiumBrackets.test.ts. Orders go through the terminal's onSetBracket (REAL: LIMIT target / SL-M stop on
// that contract, isx tag; SIM: the paper bracket watcher, which compares the leg's own live premium).

import { bracketKind, legPnl, type ScalperLeg } from './indexScalperPositions.ts';

export interface PremiumLevel { price: number; orderId?: string; sim: boolean }
export interface PremiumBrackets { tp?: PremiumLevel; sl?: PremiumLevel }

interface OrderLike { id: string; securityId: string; side: string; orderType: string; price: number | null; trigger: number | null }

/** The leg's current target / stop: a SIM level first, else this contract's working order on the closing side (a stop
 *  order is the SL, a limit the TP: `bracketKind`). Matched by security id only, never by symbol text. */
export function premiumBracketsFor(leg: ScalperLeg, orders: OrderLike[], sim?: { tp?: number; sl?: number }): PremiumBrackets {
  const out: PremiumBrackets = {};
  if (sim?.tp && sim.tp > 0) out.tp = { price: sim.tp, sim: true };
  if (sim?.sl && sim.sl > 0) out.sl = { price: sim.sl, sim: true };
  const isLong = leg.netQty > 0;
  const close = isLong ? 'SELL' : 'BUY';
  for (const o of orders) {
    if (!o.securityId || o.securityId !== leg.securityId || o.side !== close) continue;
    const px = o.price ?? o.trigger;
    if (!px || px <= 0) continue;
    const kind = bracketKind(o.orderType || '', px, leg.avg, isLong);
    if (kind === 'TP' && !out.tp) out.tp = { price: px, orderId: o.id, sim: false };
    if (kind === 'SL' && !out.sl) out.sl = { price: px, orderId: o.id, sim: false };
  }
  return out;
}

const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;

/** Snap to the tick in one direction (`up` = ceil, else floor), tolerant of float noise (0.1 * 3 = 0.30000000000000004). */
function snapAway(price: number, tick: number, up: boolean): number {
  const steps = price / tick;
  const n = up ? Math.ceil(steps - 1e-9) : Math.floor(steps + 1e-9);
  return Number((n * tick).toFixed(2));
}

/** Snap to the premium tick (NSE options 0.05, MCX crude options 0.10). */
export function snapPremium(price: number, tick: number): number {
  return Number((Math.round(price / tick) * tick).toFixed(2));
}

/**
 * Why this level cannot be placed (null = it can). It must be a positive premium on the tick and on the right side of
 * the LIVE premium: a long's target above it and stop below it (a short's the other way round). A target on the wrong
 * side fills at once as a limit; a stop on the wrong side triggers at once. Without a live premium nothing is placed.
 */
export function premiumBracketError(kind: 'TP' | 'SL', price: number, isLong: boolean, ltp: number | null, tick: number): string | null {
  if (!Number.isFinite(price) || price <= 0) return 'Enter a premium above 0';
  if (Math.abs(snapPremium(price, tick) - price) > 1e-6) return `Use the ${tick.toFixed(2)} tick`;
  if (ltp === null || !(ltp > 0)) return 'No live premium: cannot place a target / stop now';
  const above = price > ltp;
  if (kind === 'TP' && isLong && !above) return `A long's target must be above the live premium ${ltp.toFixed(2)}`;
  if (kind === 'TP' && !isLong && above) return `A short's target must be below the live premium ${ltp.toFixed(2)}`;
  if (kind === 'SL' && isLong && above) return `A long's stop must be below the live premium ${ltp.toFixed(2)}`;
  if (kind === 'SL' && !isLong && !above) return `A short's stop must be above the live premium ${ltp.toFixed(2)}`;
  if (price === ltp) return 'The level equals the live premium';
  return null;
}

/**
 * What the TP / SL box holds: a premium ("245.50") or, ending in "%", a percentage of the ENTRY (average) premium
 * ("20%"), applied on the side that kind needs (a long's target above entry and stop below; a short's the other way
 * round). A percentage becomes a premium snapped to the tick, so the order is still a plain LIMIT / SL-M price; a typed
 * premium must already be on the tick. `pct` is set only for a percentage. The caller still checks the result against
 * the live premium (`premiumBracketError`).
 */
export function parseBracketInput(text: string, kind: 'TP' | 'SL', isLong: boolean, avg: number, tick: number): { price: number | null; pct: number | null; error: string | null } {
  const t = text.trim();
  // Plain decimals only: Number() would also read "1e3" as 1000 and "0x10" as 16, and send that as a real price.
  if (!t.endsWith('%')) {
    if (!DECIMAL.test(t)) return { price: null, pct: null, error: 'Enter a premium (245.50) or a % of entry (20%)' };
    return { price: Number(t), pct: null, error: null };
  }
  const body = t.slice(0, -1).trim();
  const pct = DECIMAL.test(body) ? Number(body) : Number.NaN;
  if (!Number.isFinite(pct) || pct <= 0) return { price: null, pct: null, error: 'Enter a percentage above 0, like 20%' };
  if (!(avg > 0)) return { price: null, pct, error: 'No entry premium: type the premium instead' };
  const up = (kind === 'TP') === isLong;
  if (!up && pct >= 100) return { price: null, pct, error: 'Below entry by 100 % or more is a premium of 0 or less' };
  // Snap AWAY from entry (up for a level above it, down for one below): nearest-tick rounding could land a small
  // percentage of a cheap premium on the entry itself (10% of 0.20 -> 0.20).
  const price = snapAway(avg * (1 + (up ? pct : -pct) / 100), tick, up);
  if (!(price > 0)) return { price: null, pct, error: 'That percentage leaves no premium' };
  if (Math.abs(price - avg) < 1e-9) return { price: null, pct, error: `${pct}% of ${avg.toFixed(2)} is under one tick: type the premium instead` };
  return { price, pct, error: null };
}

/** Rupees the leg books if it closes at `price` (from its average; `units` in contract units). */
export function premiumPnlAt(price: number, avg: number, units: number, isLong: boolean): number {
  return (isLong ? price - avg : avg - price) * Math.abs(units);
}

/** A starting value for the editor: the existing level, else 20 % from the live premium on the right side. */
export function defaultPremiumLevel(kind: 'TP' | 'SL', isLong: boolean, ltp: number | null, avg: number, tick: number, existing?: number): number | null {
  if (existing && existing > 0) return existing;
  const ref = ltp && ltp > 0 ? ltp : avg > 0 ? avg : null;
  if (ref === null) return null;
  const up = (kind === 'TP') === isLong;
  return snapPremium(Math.max(tick, ref * (up ? 1.2 : 0.8)), tick);
}

/** P&L (the page's own `legPnl`) and % of the leg from premiums only: null without a live premium, never an
 *  index-point stand-in (the index chart's chip used to show index points x units there). */
export function legPremiumPnl(leg: ScalperLeg): { pnl: number; pct: number } | null {
  const pnl = legPnl(leg);
  if (pnl === null || leg.ltp === null || !(leg.avg > 0)) return null;
  const isLong = leg.netQty > 0;
  return { pnl, pct: ((isLong ? leg.ltp - leg.avg : leg.avg - leg.ltp) / leg.avg) * 100 };
}
