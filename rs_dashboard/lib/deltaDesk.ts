// Pure maths for the Portfolio Greeks desk (/options/delta).
// Per-unit Greeks come from scripts/tools/positions_delta_data.py (Black-76 backed out of live
// premiums on the futures forward). Everything here is aggregation + what-if repricing.

import type { PayoffLegInput } from './optionsPayoff.ts';
import {
  RISK_FREE_RATE,
  calculateTimeToExpiryYears,
  computeBsGreeksExact,
  greeksFromMark,
  rollForward,
  spotFromFutures,
} from './optionsPricing.ts';

export { RISK_FREE_RATE };

export interface DeskLeg {
  securityId: string;
  symbol: string;
  displayName: string;
  underlying: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  netQty: number;        // signed contract units (negative = short)
  lotSize: number;
  ltp: number;
  entryPrice: number;
  pnl: number;
  spot: number;
  delta: number;
  gamma?: number;
  theta?: number;
  vega?: number;
  rho?: number;
  vanna?: number;
  charm?: number;
  vomma?: number;
  iv?: number;           // percent, solved from the leg's own live premium
  atmIv?: number;        // percent, ATM IV of the leg's expiry (SD bands use this)
  forward?: number;
  greeksSource?: 'black76' | 'chain';
  spotSource?: 'futures';
}


/** One leg exactly as scripts/tools/positions_delta_data.py returns it: market data only, no maths. */
export interface RawLeg {
  securityId: string;
  symbol: string;
  displayName: string;
  underlying: string;
  expiry: string;
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  netQty: number;
  lotSize: number;
  ltp: number;
  entryPrice: number;
  pnl: number;
  spot: number;
  atmIv?: number;
  futPrice?: number;
  futExpiry?: string;
  chainGreeks?: { delta: number; gamma: number; theta: number; vega: number; iv: number };
}

/**
 * Turn raw market data into legs with IV and the full Greeks profile, entirely through optionsPricing.ts:
 *  - one spot per underlying (the script's, else estimated from the future — flagged `spotSource: 'futures'`);
 *  - Black-76 forward = the nearest future rolled to each leg's expiry (or spot·e^{rT} when there is no future);
 *  - IV solved from each leg's live premium, then exact Greeks at that IV;
 *  - Dhan's chain Greeks only when a leg has no live price (second-order Greeks are then blank).
 */
export function enrichLegs(raw: RawLeg[], now: number = Date.now()): DeskLeg[] {
  const spotOf = new Map<string, { spot: number; estimated: boolean }>();
  for (const l of raw) {
    if (spotOf.has(l.underlying)) continue;
    const given = raw.find(x => x.underlying === l.underlying && x.spot > 0)?.spot ?? 0;
    const fut = raw.find(x => x.underlying === l.underlying && x.futPrice && x.futExpiry);
    if (given > 0) spotOf.set(l.underlying, { spot: given, estimated: false });
    else if (fut) spotOf.set(l.underlying, { spot: spotFromFutures(fut.futPrice!, fut.futExpiry!, RISK_FREE_RATE, now), estimated: true });
    else spotOf.set(l.underlying, { spot: 0, estimated: false });
  }

  return raw.map(l => {
    const { spot, estimated } = spotOf.get(l.underlying)!;
    const T = calculateTimeToExpiryYears(l.expiry, now);
    const forward = l.futPrice && l.futExpiry
      ? rollForward(l.futPrice, l.futExpiry, l.expiry, RISK_FREE_RATE, now)
      : spot > 0 ? spot * Math.exp(RISK_FREE_RATE * T) : 0;

    const base: DeskLeg = {
      securityId: l.securityId, symbol: l.symbol, displayName: l.displayName, underlying: l.underlying,
      expiry: l.expiry, strike: l.strike, type: l.type, side: l.side, netQty: l.netQty, lotSize: l.lotSize,
      ltp: l.ltp, entryPrice: l.entryPrice, pnl: l.pnl, spot, delta: 0,
      atmIv: l.atmIv, ...(estimated ? { spotSource: 'futures' as const } : {}),
    };

    const g = forward > 0 && l.ltp > 0
      ? greeksFromMark({ type: l.type, strike: l.strike, expiry: l.expiry, mark: l.ltp, underlying: forward, isFutures: true }, { timeYears: T })
      : null;
    if (g) {
      return {
        ...base, delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega, rho: g.rho, vanna: g.vanna, charm: g.charm,
        vomma: g.vomma, iv: g.iv * 100, forward, greeksSource: 'black76',
      };
    }
    const c = l.chainGreeks;
    if (c) {
      return { ...base, delta: c.delta, gamma: c.gamma, theta: c.theta, vega: c.vega, iv: c.iv, forward: forward || undefined, greeksSource: 'chain' };
    }
    return base;
  });
}

export type GreekKey = 'delta' | 'gamma' | 'theta' | 'vega' | 'rho' | 'vanna' | 'charm' | 'vomma';
export type Basis = 'exposure' | 'lots' | 'broker';

export interface GreekMeta {
  key: GreekKey;
  symbol: string;
  name: string;
  order: 'first' | 'second';
  hint: string;
}

export const GREEKS: GreekMeta[] = [
  { key: 'delta', symbol: 'Δ', name: 'Delta', order: 'first', hint: 'Change in position value per 1 point move in the index.' },
  { key: 'gamma', symbol: 'Γ', name: 'Gamma', order: 'first', hint: 'Change in delta per 1 point move. Negative = delta works against you as the market runs.' },
  { key: 'theta', symbol: 'Θ', name: 'Theta', order: 'first', hint: 'Rupees gained (+) or lost (−) per calendar day from time decay.' },
  { key: 'vega', symbol: 'ν', name: 'Vega', order: 'first', hint: 'Rupees gained or lost per 1 volatility point rise in implied volatility.' },
  { key: 'rho', symbol: 'ρ', name: 'Rho', order: 'first', hint: 'Rupees gained or lost per 1% rise in the interest rate.' },
  { key: 'vanna', symbol: 'Vanna', name: 'Vanna', order: 'second', hint: 'Change in delta per 1 volatility point. Shows how a volatility spike shifts your directional exposure.' },
  { key: 'charm', symbol: 'Charm', name: 'Charm', order: 'second', hint: 'Change in delta per day that passes. Shows how your direction drifts overnight with no market move.' },
  { key: 'vomma', symbol: 'Vomma', name: 'Vomma', order: 'second', hint: 'Change in vega per 1 volatility point. Positive = vega grows as volatility rises (convex).' },
];

export const BASIS_LABEL: Record<Basis, string> = {
  exposure: 'Index units',
  lots: 'Per lot',
  broker: 'Broker view',
};

export const BASIS_NOTE: Record<Basis, string> = {
  exposure: 'Real exposure: per-unit Greek × signed quantity. Net delta 1.00 = one Nifty share.',
  lots: 'Real exposure divided by lot size, so a 3-lot short counts as 3.',
  broker: 'How the broker\'s Position Analyzer prints it: every leg counts as one lot, whatever its size.',
};

/** Multiplier applied to a leg's per-unit Greek under each basis. */
export function legWeight(leg: DeskLeg, basis: Basis): number {
  if (basis === 'exposure') return leg.netQty;
  if (basis === 'lots') return leg.lotSize > 0 ? leg.netQty / leg.lotSize : 0;
  return leg.netQty > 0 ? 1 : leg.netQty < 0 ? -1 : 0;
}

export function legGreek(leg: DeskLeg, key: GreekKey): number | null {
  const v = leg[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

export type GreekTotals = Record<GreekKey, number>;

export function aggregate(legs: DeskLeg[], basis: Basis): GreekTotals {
  const out = { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, vanna: 0, charm: 0, vomma: 0 } as GreekTotals;
  for (const leg of legs) {
    const w = legWeight(leg, basis);
    for (const g of GREEKS) {
      const v = legGreek(leg, g.key);
      if (v !== null) out[g.key] += w * v;
    }
  }
  return out;
}

export interface GroupRow {
  key: string;
  legs: number;
  lots: number;
  totals: GreekTotals;
  pnl: number;
}

export function groupBy(legs: DeskLeg[], by: (l: DeskLeg) => string, basis: Basis): GroupRow[] {
  const map = new Map<string, DeskLeg[]>();
  for (const l of legs) {
    const k = by(l);
    map.set(k, [...(map.get(k) ?? []), l]);
  }
  return [...map.entries()]
    .map(([key, ls]) => ({
      key,
      legs: ls.length,
      lots: ls.reduce((s, l) => s + Math.abs(l.lotSize > 0 ? l.netQty / l.lotSize : 0), 0),
      totals: aggregate(ls, basis),
      pnl: ls.reduce((s, l) => s + l.pnl, 0),
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

/** Adapter: the Portfolio Greeks legs → the central payoff library's input. IV is solved from each leg's live price there. */
export function deskLegsToPayoffLegs(legs: DeskLeg[]): PayoffLegInput[] {
  return legs
    .filter(l => !!l.expiry && l.entryPrice > 0)
    .map(l => ({
      type: l.type, strike: l.strike, expiry: l.expiry, qty: l.netQty, entryPrice: l.entryPrice,
      mark: l.ltp > 0 ? l.ltp : undefined, forward: l.forward, lotSize: l.lotSize,
    }));
}

export type Posture = { label: string; tone: 'good' | 'bad' | 'flat' };

/** One-word reads of the book, for chips. Thresholds are relative so a 1-lot and a 50-lot book both read sensibly. */
export function posture(real: GreekTotals, lotsTotal: number): Posture[] {
  const lots = Math.max(lotsTotal, 1);
  const delta = real.delta / (65 * lots);
  const tone = (v: number, good: boolean): Posture['tone'] => (Math.abs(v) < 1e-9 ? 'flat' : good ? 'good' : 'bad');
  return [
    {
      label: Math.abs(delta) < 0.05 ? 'Direction neutral' : delta > 0 ? 'Leans bullish' : 'Leans bearish',
      tone: 'flat',
    },
    { label: real.gamma < 0 ? 'Short gamma' : 'Long gamma', tone: tone(real.gamma, real.gamma > 0) },
    { label: real.theta > 0 ? 'Earns decay' : 'Pays decay', tone: tone(real.theta, real.theta > 0) },
    { label: real.vega < 0 ? 'Short volatility' : 'Long volatility', tone: 'flat' },
  ];
}

export function fmtGreek(v: number): string {
  const a = Math.abs(v);
  const dp = a >= 1000 ? 0 : a >= 100 ? 1 : a >= 10 ? 2 : a >= 1 ? 3 : a >= 0.1 ? 4 : a >= 0.01 ? 5 : 6;
  return v.toLocaleString('en-IN', { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

export function fmtInr(v: number, signed = false): string {
  const s = Math.round(Math.abs(v)).toLocaleString('en-IN');
  const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  return `${sign}₹${s}`;
}
