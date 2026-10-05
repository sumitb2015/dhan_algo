// Pure maths for the Portfolio Greeks desk (/options/delta).
// Per-unit Greeks come from scripts/tools/positions_delta_data.py (Black-76 backed out of live
// premiums on the futures forward). Everything here is aggregation + what-if repricing.

import { calculateTimeToExpiryYears } from './optionsMonitorMath.ts';

/** Same default as computeBsGreeks() in optionsMonitorMath.ts, so every payoff surface prices alike. */
export const RISK_FREE_RATE = 0.065;

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
  tYears?: number;
  greeksSource?: 'black76' | 'chain';
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

// ── Black-76 ────────────────────────────────────────────────────────

function normPdf(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

// Abramowitz-Stegun 7.1.26 erf: |error| < 1.5e-7, plenty for a what-if curve.
function normCdf(x: number): number {
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  return x >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

export function b76(type: 'CE' | 'PE', F: number, K: number, T: number, sigmaPct: number, r = RISK_FREE_RATE) {
  const df = Math.exp(-r * Math.max(T, 0));
  const sigma = Math.max(sigmaPct, 0.5) / 100;
  if (T <= 1e-6) {
    const iv = type === 'CE' ? Math.max(F - K, 0) : Math.max(K - F, 0);
    return { price: iv, delta: type === 'CE' ? (F > K ? 1 : 0) : (F < K ? -1 : 0) };
  }
  const sq = Math.sqrt(T);
  const d1 = (Math.log(F / K) + 0.5 * sigma * sigma * T) / (sigma * sq);
  const d2 = d1 - sigma * sq;
  if (type === 'CE') return { price: df * (F * normCdf(d1) - K * normCdf(d2)), delta: df * normCdf(d1) };
  return { price: df * (K * normCdf(-d2) - F * normCdf(-d1)), delta: df * (normCdf(d1) - 1) };
}

export { normPdf };

function modelable(l: DeskLeg): l is DeskLeg & { iv: number; forward: number; expiry: string } {
  return !!l.iv && l.iv > 0 && !!l.forward && l.forward > 0 && !!l.expiry;
}

/** One clock for every payoff surface: time to 15:40 IST on the expiry date (see optionsMonitorMath.ts). */
const legYears = (l: DeskLeg) => calculateTimeToExpiryYears(l.expiry);

/** Forward for a leg at a hypothetical index level: the leg's own forward moved by the index change (additive basis). */
const forwardAt = (l: DeskLeg & { forward: number }, s: number) => l.forward + (s - (l.spot > 0 ? l.spot : s));

export interface PayoffPoint {
  spot: number;
  expiry: number;
  today: number;
  expPos: number;
  expNeg: number;
}

export interface PayoffResult {
  points: PayoffPoint[];
  breakevens: number[];
  /** Best/worst of the drawn window only. Use `unlimited*` before presenting either as a limit. */
  best: number;
  worst: number;
  unlimitedLossUp: boolean;
  unlimitedLossDown: boolean;
  unlimitedGainUp: boolean;
  frontExpiryYears: number;
  oneSigma: [number, number] | null;
  oneSigmaIv: number | null;
  skipped: number;
}

/**
 * P&L of the whole book across index levels.
 *  - today:  every leg repriced with Black-76 at its own IV and expiry, `daysForward` days from now.
 *  - expiry: at the nearest expiry; a later leg keeps residual time value (floored at 0.25 day, as in the
 *            calendar/diagonal rule in dhan-payoff-diagrams §6).
 * Samples always include every strike so kinks are not rounded off; breakevens are refined by bisection on the
 * model itself, so they do not depend on the sampling grid.
 */
export function payoff(legs: DeskLeg[], spot: number, daysForward: number, rangePct = 0.08, steps = 161): PayoffResult {
  const ok = legs.filter(modelable);
  const skipped = legs.length - ok.length;
  const years = ok.map(legYears);
  const front = years.length ? Math.min(...years) : 0;
  const lo = spot * (1 - rangePct);
  const hi = spot * (1 + rangePct);

  const pnlAt = (s: number, mode: 'expiry' | 'today') => {
    let total = 0;
    ok.forEach((l, i) => {
      const F = forwardAt(l, s);
      const t = mode === 'today'
        ? Math.max(years[i] - daysForward / 365, 0)
        : years[i] - front > 1e-9 ? Math.max(years[i] - front, 0.25 / 365) : 0;
      total += (b76(l.type, F, l.strike, t, l.iv).price - l.entryPrice) * l.netQty;
    });
    return total;
  };

  const xs = new Set<number>();
  for (let i = 0; i < steps; i++) xs.add(lo + ((hi - lo) * i) / (steps - 1));
  ok.forEach(l => { if (l.strike > lo && l.strike < hi) xs.add(l.strike); });
  const grid = [...xs].sort((a, b) => a - b);

  const points: PayoffPoint[] = grid.map(s => {
    const expiry = Math.round(pnlAt(s, 'expiry'));
    return {
      spot: Math.round(s * 100) / 100,
      expiry,
      today: Math.round(pnlAt(s, 'today')),
      expPos: Math.max(expiry, 0),
      expNeg: Math.min(expiry, 0),
    };
  });

  const breakevens: number[] = [];
  for (let i = 1; i < grid.length; i++) {
    const a = pnlAt(grid[i - 1], 'expiry');
    const b = pnlAt(grid[i], 'expiry');
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      let x0 = grid[i - 1], x1 = grid[i], f0 = a;
      for (let k = 0; k < 40; k++) {
        const mid = (x0 + x1) / 2;
        const fm = pnlAt(mid, 'expiry');
        if ((fm < 0) === (f0 < 0)) { x0 = mid; f0 = fm; } else { x1 = mid; }
      }
      breakevens.push((x0 + x1) / 2);
    }
  }

  const netQty = (type: 'CE' | 'PE') => ok.filter(l => l.type === type).reduce((s, l) => s + l.netQty, 0);
  const netCe = netQty('CE');
  const netPe = netQty('PE');

  // SD band: spot × ATM IV × √t (dhan-payoff-diagrams "Sensibull parity"); falls back to the IV of the leg
  // nearest the money when the chain did not supply an ATM IV.
  const frontLegs = ok.filter((_, i) => Math.abs(years[i] - front) < 1e-9);
  const atm = frontLegs.find(l => l.atmIv && l.atmIv > 0)?.atmIv
    ?? [...frontLegs].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0]?.iv
    ?? null;
  const oneSigma: [number, number] | null = atm && front > 0
    ? [spot * (1 - (atm / 100) * Math.sqrt(front)), spot * (1 + (atm / 100) * Math.sqrt(front))]
    : null;

  return {
    points,
    breakevens,
    best: points.length ? Math.max(...points.map(p => p.expiry)) : 0,
    worst: points.length ? Math.min(...points.map(p => p.expiry)) : 0,
    unlimitedLossUp: netCe < 0,
    unlimitedLossDown: netPe < 0,
    unlimitedGainUp: netCe > 0,
    frontExpiryYears: front,
    oneSigma,
    oneSigmaIv: atm,
    skipped,
  };
}

export interface LadderRow {
  movePct: number;
  spot: number;
  pnlToday: number;     // P&L of the book if the move happens now
  pnlDelta: number;     // change vs. current P&L
  netLotDelta: number;  // lot-weighted net delta at that level
}

export const LADDER_MOVES = [-4, -2, -1, 0, 1, 2, 4];

export function ladder(legs: DeskLeg[], spot: number, daysForward = 0): LadderRow[] {
  const ok = legs.filter(modelable);
  const base = ok.reduce((s, l) => s + (b76(l.type, l.forward, l.strike, legYears(l), l.iv).price - l.entryPrice) * l.netQty, 0);
  return LADDER_MOVES.map(movePct => {
    const s = spot * (1 + movePct / 100);
    let pnl = 0;
    let lotDelta = 0;
    for (const l of ok) {
      const t = Math.max(legYears(l) - daysForward / 365, 0);
      const m = b76(l.type, forwardAt(l, s), l.strike, t, l.iv);
      pnl += (m.price - l.entryPrice) * l.netQty;
      lotDelta += (l.lotSize > 0 ? l.netQty / l.lotSize : 0) * m.delta;
    }
    return { movePct, spot: s, pnlToday: Math.round(pnl), pnlDelta: Math.round(pnl - base), netLotDelta: lotDelta };
  });
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
