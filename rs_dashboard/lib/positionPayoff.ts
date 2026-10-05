/**
 * Position-book adapter for the central payoff library (lib/optionsPayoff.ts).
 *
 * Positions Analysis, Live Builder, Intraday Edge, the live all-positions page and the position snapshot all hold legs in the
 * `ResolvedLeg` / `PositionLeg` shape (qtyLots = contract units, side BUY/SELL, price = entry average, display.ltp = live mark).
 * This module turns that shape into the library's input and the library's model back into the `PayoffStats` the stat strips read,
 * so those pages stop pricing anything themselves. It contains no option maths.
 *
 * Conventions that changed from the old per-page engine (and why):
 *   - "expiry" is the NEAREST expiry in the book, as in the broker's own analyzer (later legs keep their time value). The old pages
 *     valued a mixed book at the FINAL expiry; on the live Nifty book that put the break-evens ~90 points from the broker's, against ~3-6.
 *   - IV is solved from each leg's live mark first (chain IV only as a fallback), on the 15:40 IST clock, so the T+0 curve reproduces
 *     the book's open P&L. The old pages preferred the chain IV, which does not reproduce the mark.
 *   - A leg with no usable IV is priced at intrinsic value only (and listed in `missingIv`), never on a guessed volatility.
 */

import type { PayoffStats, ResolvedLeg } from './optionsStrategy.ts';
import {
  buildPayoffModel, bookGreeks, type PayoffLegInput, type PayoffModel, type PayoffPoint,
} from './optionsPayoff.ts';
import { RISK_FREE_RATE, calculateTimeToExpiryYears, impliedVol, rollForward } from './optionsPricing.ts';

/** A leg as the position pages hold it: a ResolvedLeg, optionally with the live mark under `display.ltp`. */
export type PositionLegLike = ResolvedLeg & { display?: { ltp: number | null } };

/** The nearest monthly future (Black-76 forward), as returned beside the option chain. */
export interface FutureRef { price: number; expiry: string }

interface Common {
  /** Used for a leg that carries no expiry of its own. A leg with neither is left out. */
  defaultExpiry?: string | null;
  /** Contracts per unit of qtyLots. Position pages hold real units already, so the default is 1. */
  lotSize?: number;
  future?: FutureRef | null;
  now?: number;
  /** Draft/what-if legs have no live mark: treat their quoted `price` as the mark, so T+0 starts from that price. */
  markFromPrice?: boolean;
}

const legExpiry = (l: PositionLegLike, d?: string | null) => l.expiry || d || null;

function forwardFor(expiry: string, spot: number, o: Common): number | undefined {
  if (o.future && o.future.price > 0 && o.future.expiry) return rollForward(o.future.price, o.future.expiry, expiry, RISK_FREE_RATE, o.now);
  void spot;
  return undefined; // the library then uses the synthetic forward spot·e^{rT}
}

/** Position legs → library legs. */
export function toPayoffLegs(legs: PositionLegLike[], spot: number, o: Common = {}): PayoffLegInput[] {
  const lot = o.lotSize ?? 1;
  const out: PayoffLegInput[] = [];
  for (const l of legs) {
    const expiry = legExpiry(l, o.defaultExpiry);
    if (!expiry) continue;
    const mark = l.display?.ltp ?? (o.markFromPrice ? l.price : null);
    out.push({
      type: l.type, strike: l.strike, expiry,
      qty: (l.side === 'SELL' ? -1 : 1) * l.qtyLots * lot,
      entryPrice: Math.max(l.price, 1e-9),
      mark: mark !== null && mark !== undefined && mark > 0 ? mark : undefined,
      // The chain's IV is only a fallback: the library solves IV from the live mark first so T+0 reproduces the open P&L.
      chainIv: l.iv !== null && l.iv > 0 ? l.iv : undefined,
      forward: forwardFor(expiry, spot, o),
      lotSize: lot > 1 ? lot : undefined,
    });
  }
  return out;
}

/**
 * Fill each leg's IV by inverting its live mark through the central pricing library (mark first; the chain's own IV is kept only when
 * there is no live mark to invert). Legs that cannot be solved are returned untouched, so "no usable IV" stays visible downstream.
 */
export function withSolvedIv<T extends PositionLegLike>(legs: T[], spot: number, o: Common = {}): T[] {
  if (!(spot > 0)) return legs;
  const now = o.now ?? Date.now();
  return legs.map((l) => {
    const expiry = legExpiry(l, o.defaultExpiry);
    const mark = l.display?.ltp;
    if (!expiry || mark === null || mark === undefined || !(mark > 0)) return l;
    const T = calculateTimeToExpiryYears(expiry, now);
    const F = forwardFor(expiry, spot, o) ?? spot * Math.exp(RISK_FREE_RATE * T);
    const solved = impliedVol(l.type, F, l.strike, T, mark, { isFutures: true });
    return solved ? { ...l, iv: solved } : l;
  });
}

export interface PositionPayoff {
  model: PayoffModel;
  expiryCurve: PayoffPoint[];
  /** The curve `targetDays` from now (0 = today's mark-to-market). */
  targetCurve: PayoffPoint[] | null;
  stats: PayoffStats;
  /** Legs (indices into the input) priced at intrinsic value for want of an IV. */
  missingIv: number[];
}

export interface PositionPayoffOptions extends Common {
  strikeStep: number;
  /** Half-width of the drawn window as a fraction of spot (the page's zoom step). */
  spanPct: number;
  targetDays?: number;
  margin?: number;
  atmIv?: number;
}

/** The payoff of a position book: curves, stats and warnings, all from the central library. */
export function positionPayoff(legs: PositionLegLike[], spot: number, o: PositionPayoffOptions): PositionPayoff | null {
  const lot = o.lotSize ?? 1;
  const kept = legs.filter((l) => !!legExpiry(l, o.defaultExpiry));
  if (!kept.length || !(spot > 0)) return null;
  const model = buildPayoffModel({
    spot, legs: toPayoffLegs(kept, spot, o), now: o.now,
    rangePct: o.spanPct, strikeStep: o.strikeStep, daysForward: o.targetDays ?? 0,
    margin: o.margin, atmIv: o.atmIv,
    fallbackIv: 0, // no IV, no guess: priced at intrinsic and reported in `missingIv`
  });
  if (!model) return null;
  return {
    model,
    expiryCurve: model.points,
    targetCurve: o.targetDays === undefined ? null : model.today,
    stats: payoffStatsFromModel(model, kept, spot, lot),
    missingIv: model.ivAssumedIdx.map((i) => legs.indexOf(kept[i])),
  };
}

/** The PayoffStats the stat strips read, from a (non-light) payoff model. */
export function payoffStatsFromModel(model: PayoffModel, legs: PositionLegLike[], spot: number, lotSize = 1): PayoffStats {
  const pts = model.points;
  let worst = pts[0], best = pts[0];
  for (const p of pts) { if (p.pnl < worst.pnl) worst = p; if (p.pnl > best.pnl) best = p; }

  const netPremium = legs.reduce((sum, l) => sum + (l.side === 'SELL' ? l.price : -l.price) * l.qtyLots, 0);
  let intrinsicValue = 0;
  let timeValue = 0;
  for (const l of legs) {
    const intrinsicNow = l.type === 'CE' ? Math.max(spot - l.strike, 0) : Math.max(l.strike - spot, 0);
    const sign = l.side === 'SELL' ? 1 : -1;
    intrinsicValue += sign * l.qtyLots * intrinsicNow * lotSize;
    timeValue += sign * l.qtyLots * (l.price - intrinsicNow) * lotSize;
  }

  const maxProfit: number | 'Unlimited' = model.maxProfitUnlimited ? 'Unlimited' : model.maxProfit;
  const maxLoss: number | 'Unlimited' = model.maxLossUnlimited ? 'Unlimited' : model.maxLoss;
  const rewardRisk = maxLoss === 'Unlimited' || maxProfit === 'Unlimited' || maxLoss === 0 ? null : Math.abs(maxProfit / maxLoss);

  return {
    maxProfit, maxLoss,
    breakevensExpiry: model.breakevens,
    rewardRisk,
    netPremium,
    intrinsicValue,
    timeValue,
    popPct: model.pop,
    maxLossInRange: worst.pnl,
    maxLossAtSpot: worst.spot,
    maxProfitInRange: best.pnl,
    maxProfitAtSpot: best.spot,
    rangeLo: pts[0].spot,
    rangeHi: pts[pts.length - 1].spot,
  };
}

export interface PositionNetGreeks<T extends PositionLegLike = PositionLegLike> {
  delta: number; gamma: number; theta: number; vega: number;
  /** Per-unit Greeks of each input leg, in input order (multiply by ±qtyLots for the position figure). */
  perLeg: { delta: number; gamma: number; theta: number; vega: number; iv: number; ivSource: 'mark' | 'chain' | 'assumed' }[];
  /** Legs with neither a live price nor a chain IV, priced on an assumed IV: their Greeks are indicative. */
  assumed: T[];
}

/** Net and per-leg Greeks of a position book through the central library (IV from each leg's live mark). */
export function positionNetGreeks<T extends PositionLegLike>(legs: T[], spot: number, o: Common & { fallbackIv?: number } = {}): PositionNetGreeks<T> {
  const empty: PositionNetGreeks<T> = { delta: 0, gamma: 0, theta: 0, vega: 0, perLeg: [], assumed: [] };
  const kept = legs.filter((l) => !!legExpiry(l, o.defaultExpiry));
  if (!kept.length || !(spot > 0)) return empty;
  const res = bookGreeks({
    spot, now: o.now, fallbackIv: o.fallbackIv ?? 0.15,
    legs: toPayoffLegs(kept, spot, o),
  });
  if (!res) return empty;
  const perLeg = res.legs.map((g) => ({ ...g.unit, iv: g.iv, ivSource: g.ivSource }));
  return {
    ...res.net, perLeg,
    assumed: res.legs.filter((g) => g.ivSource === 'assumed').map((g) => kept[g.index]),
  };
}

/**
 * Net Greeks for a book that spans several underlyings (the scalper Greeks modal): each underlying is valued against its own spot
 * (and futures), then summed. `perLeg` is in input order; a leg whose underlying has no spot yet is left out of the sums and listed in `assumed`.
 */
export function positionNetGreeksBy<T extends PositionLegLike>(
  legs: T[],
  keyOf: (l: T) => string,
  marketOf: (key: string) => { spot: number; future?: FutureRef | null } | undefined,
  o: Omit<Common, 'future'> & { fallbackIv?: number } = {},
): PositionNetGreeks<T> {
  const out: PositionNetGreeks<T> = { delta: 0, gamma: 0, theta: 0, vega: 0, perLeg: new Array(legs.length), assumed: [] };
  const groups = new Map<string, number[]>();
  legs.forEach((l, i) => groups.set(keyOf(l), [...(groups.get(keyOf(l)) ?? []), i]));
  for (const [key, idxs] of groups) {
    const m = marketOf(key);
    if (!m || !(m.spot > 0)) { for (const i of idxs) out.assumed.push(legs[i]); continue; }
    const g = positionNetGreeks(idxs.map((i) => legs[i]), m.spot, { ...o, future: m.future });
    out.delta += g.delta; out.gamma += g.gamma; out.theta += g.theta; out.vega += g.vega;
    idxs.forEach((legIdx, k) => { if (g.perLeg[k]) out.perLeg[legIdx] = g.perLeg[k]; });
    out.assumed.push(...g.assumed);
  }
  return out;
}
