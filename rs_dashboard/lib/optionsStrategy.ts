/**
 * Core math + template registry for the multi-leg NIFTY options strategy builder.
 * Pure functions only — no fetch/DOM/React here so this file can be unit-verified
 * standalone (see docs/superpowers/plans/2026-07-06-nifty-strategy-builder.md, Task 3/4).
 */

export const STRIKE_STEP = 50; // NIFTY

import { type OptType, bsPrice, riskNeutralProbAbove, impliedVolFromPrice } from './optionsPricing.ts';
import { payoffGrid, buildPayoffModel } from './optionsPayoff.ts';
import { payoffStatsFromModel } from './positionPayoff.ts';
export { bsPrice, riskNeutralProbAbove, impliedVolFromPrice };
export type { OptType };
export type Side = 'BUY' | 'SELL';

export interface ParamDef {
  key: string;
  label: string;
  default: number;
  min: number;
  max: number;
  step: number;
}

export interface LegSpec {
  offsetStrikes: number; // signed, in strike steps from ATM
  type: OptType;
  side: Side;
  qtyRatio: number; // multiplied by lots
}

export interface StrategyTemplate {
  id: string;
  name: string;
  undefinedRisk: boolean; // true if any naked short leg exists at default params
  params: ParamDef[];
  legs: (params: Record<string, number>) => LegSpec[];
}

/**
 * Batman and Double Plateau leg shapes are best-effort standard definitions —
 * they vary across brokers/platforms. All offsets below are defaults only;
 * the settings panel (Task 6) always exposes them as user-adjustable params,
 * never hardcodes them past this registry.
 */
export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'short_straddle', name: 'Short Straddle', undefinedRisk: true, params: [],
    legs: () => [
      { offsetStrikes: 0, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: 0, type: 'PE', side: 'SELL', qtyRatio: 1 },
    ],
  },
  {
    id: 'short_strangle', name: 'Short Strangle', undefinedRisk: true,
    params: [{ key: 'N', label: 'OTM offset (strikes)', default: 2, min: 1, max: 10, step: 1 }],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
    ],
  },
  {
    id: 'iron_butterfly', name: 'Iron Butterfly', undefinedRisk: false,
    params: [{ key: 'W', label: 'Wing width (strikes)', default: 5, min: 1, max: 15, step: 1 }],
    legs: (p) => [
      { offsetStrikes: 0, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: 0, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +p.W, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -p.W, type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'iron_condor', name: 'Iron Condor', undefinedRisk: false,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 3, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Wing width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W), type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'batman', name: 'Batman', undefinedRisk: true,
    params: [
      { key: 'N', label: 'Inner buy offset (strikes)', default: 2, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Spread width (strikes)', default: 2, min: 1, max: 5, step: 1 },
    ],
    legs: (p) => [
      // Call side: Buy inner call (qtyRatio 1), Sell outer call (qtyRatio 2)
      { offsetStrikes: +p.N, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W), type: 'CE', side: 'SELL', qtyRatio: 2 },
      // Put side: Buy inner put (qtyRatio 1), Sell outer put (qtyRatio 2)
      { offsetStrikes: -p.N, type: 'PE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W), type: 'PE', side: 'SELL', qtyRatio: 2 },
    ],
  },
  {
    id: 'jade_lizard', name: 'Jade Lizard', undefinedRisk: true,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 2, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Call spread width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 }, // naked put — no downside protection
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W), type: 'CE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'reverse_jade_lizard', name: 'Reverse Jade Lizard', undefinedRisk: true,
    params: [
      { key: 'N', label: 'Short offset (strikes)', default: 2, min: 1, max: 10, step: 1 },
      { key: 'W', label: 'Put spread width (strikes)', default: 3, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: 1 }, // naked call — no upside protection
      { offsetStrikes: -p.N, type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'double_plateau', name: 'Double Plateau', undefinedRisk: false,
    params: [
      { key: 'N', label: 'Inner buy offset (strikes)', default: 4, min: 1, max: 10, step: 1 },
      { key: 'W1', label: 'Spread width (strikes)', default: 5, min: 1, max: 10, step: 1 },
      { key: 'W2', label: 'Plateau width (strikes)', default: 5, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      // Call side: C1 (Buy), C2 (Sell), C3 (Sell), C4 (Buy)
      { offsetStrikes: +p.N, type: 'CE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W1), type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + p.W1 + p.W2), type: 'CE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: +(p.N + 2 * p.W1 + p.W2), type: 'CE', side: 'BUY', qtyRatio: 1 },
      // Put side: P1 (Buy), P2 (Sell), P3 (Sell), P4 (Buy)
      { offsetStrikes: -p.N, type: 'PE', side: 'BUY', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W1), type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -(p.N + p.W1 + p.W2), type: 'PE', side: 'SELL', qtyRatio: 1 },
      { offsetStrikes: -(p.N + 2 * p.W1 + p.W2), type: 'PE', side: 'BUY', qtyRatio: 1 },
    ],
  },
  {
    id: 'low_gamma_diagonal_call', name: 'Low-Gamma Diagonal Call', undefinedRisk: false,
    params: [
      { key: 'N', label: 'Short OTM offset (strikes)', default: 15, min: 10, max: 25, step: 1 },
      { key: 'LR', label: 'Long lots', default: 3, min: 1, max: 10, step: 1 },
      { key: 'SR', label: 'Short lots', default: 4, min: 1, max: 10, step: 1 },
    ],
    legs: (p) => [
      { offsetStrikes: 0, type: 'CE', side: 'BUY', qtyRatio: p.LR || 3 },
      { offsetStrikes: +p.N, type: 'CE', side: 'SELL', qtyRatio: p.SR || 4 },
    ],
  },
];

export function getTemplate(id: string): StrategyTemplate | undefined {
  return STRATEGY_TEMPLATES.find((t) => t.id === id);
}

export function defaultParams(template: StrategyTemplate): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of template.params) out[p.key] = p.default;
  return out;
}

export function computeAtm(spot: number, strikeStep: number = STRIKE_STEP): number {
  return Math.round(spot / strikeStep) * strikeStep;
}

// ── Chain data shapes (mirrors /api/options/chain's `data.chain.oc`) ───────────

export interface ChainLegData {
  last_price: number;
  previous_close_price?: number;
  oi?: number;
  volume?: number;
  implied_volatility?: number;
  security_id?: number;
  top_bid_price?: number;
  top_ask_price?: number;
  greeks?: { delta?: number; theta?: number; gamma?: number; vega?: number };
}
export interface ChainOc {
  [strike: string]: { ce?: ChainLegData; pe?: ChainLegData };
}

/** Shared strike-key lookup (exact match, then fixed-decimal, then nearest-float fallback). */
export function lookupChainLegData(oc: ChainOc, strike: number, type: OptType): ChainLegData | undefined {
  const entry = oc[String(strike)] ?? oc[strike.toFixed(6)] ?? Object.entries(oc).find(([k]) => Math.abs(parseFloat(k) - strike) < 0.01)?.[1];
  return type === 'CE' ? entry?.ce : entry?.pe;
}

export interface ResolvedLeg {
  strike: number;
  type: OptType;
  side: Side;
  qtyLots: number;
  price: number;
  delta: number | null;
  iv: number | null;
  vega: number | null;
  securityId: string | null;
  // Optional, added for the positions-analytics page. Older callers (strategy
  // builder, baskets) never set these and are unaffected: gamma/theta are only
  // read by the Greeks tab, and `expiry` only by buildMultiExpiryCurve(), which
  // treats a missing value as "expires on the target date" — i.e. intrinsic,
  // exactly what the single-expiry engine already does.
  gamma?: number | null;
  theta?: number | null;
  expiry?: string | null;   // ISO YYYY-MM-DD
}

/**
 * Resolve LegSpecs (offsets from ATM) against a fetched option chain into concrete
 * strikes with current price/delta/IV. Strikes absent from the chain are reported
 * in `missingStrikes` rather than silently defaulted — callers must block Analyze
 * on a non-empty `missingStrikes`.
 */
export function resolveLegs(
  specs: LegSpec[],
  atm: number,
  lots: number,
  oc: ChainOc,
  strikeStep: number = STRIKE_STEP,
): { legs: ResolvedLeg[]; missingStrikes: number[] } {
  const legs: ResolvedLeg[] = [];
  const missingStrikes: number[] = [];

  for (const spec of specs) {
    const strike = atm + spec.offsetStrikes * strikeStep;
    const legData = lookupChainLegData(oc, strike, spec.type);

    if (!legData || typeof legData.last_price !== 'number') {
      missingStrikes.push(strike);
      continue;
    }

    legs.push({
      strike,
      type: spec.type,
      side: spec.side,
      qtyLots: lots * spec.qtyRatio,
      price: legData.last_price,
      delta: legData.greeks?.delta ?? null,
      // Dhan's chain API returns implied_volatility as a raw percentage (e.g. 10.5 for
      // 10.5%), but bsPrice() takes a fraction (0.105) — normalize at the read boundary.
      iv: typeof legData.implied_volatility === 'number' ? legData.implied_volatility / 100 : null,
      vega: legData.greeks?.vega ?? null,
      gamma: legData.greeks?.gamma ?? null,
      theta: legData.greeks?.theta ?? null,
      securityId: legData.security_id ? String(legData.security_id) : null,
    });
  }

  return { legs, missingStrikes };
}

// ── Freeform leg resolution (explicit strikes, not template offsets) ───────────

export interface FreeformLegSpec {
  strike: number;
  type: OptType;
  side: Side;
  qtyLots: number;
}

/** Same chain-lookup contract as resolveLegs(), but strikes are given explicitly. */
export function resolveFreeformLegs(
  specs: FreeformLegSpec[],
  oc: ChainOc,
): { legs: ResolvedLeg[]; missingStrikes: number[] } {
  const legs: ResolvedLeg[] = [];
  const missingStrikes: number[] = [];

  for (const spec of specs) {
    const legData = lookupChainLegData(oc, spec.strike, spec.type);

    if (!legData || typeof legData.last_price !== 'number') {
      missingStrikes.push(spec.strike);
      continue;
    }

    legs.push({
      strike: spec.strike,
      type: spec.type,
      side: spec.side,
      qtyLots: spec.qtyLots,
      price: legData.last_price,
      delta: legData.greeks?.delta ?? null,
      iv: typeof legData.implied_volatility === 'number' ? legData.implied_volatility / 100 : null,
      vega: legData.greeks?.vega ?? null,
      gamma: legData.greeks?.gamma ?? null,
      theta: legData.greeks?.theta ?? null,
      securityId: legData.security_id ? String(legData.security_id) : null,
    });
  }

  return { legs, missingStrikes };
}

// ── Expiry classifier (client-side, no backend change) ─────────────────────────

export type ExpiryKind = 'weekly' | 'monthly';

/** The LAST expiry date within each calendar month is classified as 'monthly'; every other date is 'weekly'. */
export function classifyExpiries(dates: string[]): { date: string; kind: ExpiryKind }[] {
  const byMonth = new Map<string, string[]>();
  for (const d of dates) {
    const key = d.slice(0, 7); // 'YYYY-MM'
    const arr = byMonth.get(key);
    if (arr) arr.push(d);
    else byMonth.set(key, [d]);
  }
  const monthly = new Set<string>();
  for (const arr of byMonth.values()) {
    const sorted = [...arr].sort();
    monthly.add(sorted[sorted.length - 1]);
  }
  return dates.map((d) => ({ date: d, kind: monthly.has(d) ? 'monthly' : 'weekly' }));
}

// ── Payoff engine ────────────────────────────────────────────────────────────

/** Whole calendar days from local midnight today to local midnight on expiryDate (YYYY-MM-DD). */
export function daysToExpiryFrom(expiryDate: string): number {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const expiry = new Date(expiryDate);
  expiry.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((expiry.getTime() - today.getTime()) / 86_400_000));
}

/**
 * Half-width of the sampled spot range, as a fraction of spot. The strategy
 * builder and baskets have always used 1.5%; the positions-analytics payoff
 * chart passes a larger value when zoomed out. Kept as the default so existing
 * callers are byte-identical.
 */
export const DEFAULT_SPAN_PCT = 0.015;

export interface PayoffStats {
  maxProfit: number | 'Unlimited';
  maxLoss: number | 'Unlimited';
  breakevensExpiry: number[];
  rewardRisk: number | null;
  netPremium: number;      // per lot, credit(+)/debit(-)
  intrinsicValue: number;  // rupees, at current spot
  timeValue: number;       // rupees, at current spot
  popPct: number | null;
  /**
   * Worst P&L actually reached inside the sampled spot range, and the spot it
   * occurs at. When `maxLoss` is 'Unlimited' this is the only number there is —
   * but it is a property of the sampled window, NOT a floor, so any UI showing
   * it MUST annotate the range alongside. Displaying it bare reads as a real
   * max loss and understates a naked short by an unbounded amount.
   */
  maxLossInRange: number;
  maxLossAtSpot: number;
  /** Same caveat as maxLossInRange, mirrored for the upside: only meaningful when `maxProfit` is 'Unlimited'. */
  maxProfitInRange: number;
  maxProfitAtSpot: number;
  rangeLo: number;
  rangeHi: number;
}

export function computePayoffStats(
  legs: ResolvedLeg[], spot: number, lotSize: number, expiryDate: string, strikeStep: number = STRIKE_STEP,
  spanPct: number = DEFAULT_SPAN_PCT,
): PayoffStats {
  // Computed by the central payoff library (lib/optionsPayoff.ts) through lib/positionPayoff.ts. Break-evens and bounded extremes are exact
  // (evaluated at every strike, at spot 0 and along the tail); "Unlimited" comes from net signed CE/PE quantity; POP integrates the
  // risk-neutral lognormal over each profitable zone using the ATM IV. A leg priced with no IV is valued at intrinsic only.
  const priced = legs.filter((l) => l.price > 0);
  const model = priced.length
    ? buildPayoffModel({
        spot,
        legs: priced.map((l) => ({
          type: l.type, strike: l.strike, expiry: l.expiry || expiryDate,
          qty: (l.side === 'SELL' ? -1 : 1) * l.qtyLots * lotSize,
          entryPrice: l.price, mark: l.price, chainIv: l.iv !== null && l.iv > 0 ? l.iv : undefined,
        })),
        rangePct: spanPct, strikeStep, fallbackIv: 0,
      })
    : null;
  if (!model) {
    return {
      maxProfit: 0, maxLoss: 0, breakevensExpiry: [], rewardRisk: null, netPremium: 0, intrinsicValue: 0, timeValue: 0, popPct: null,
      maxLossInRange: 0, maxLossAtSpot: spot, maxProfitInRange: 0, maxProfitAtSpot: spot, rangeLo: spot, rangeHi: spot,
    };
  }
  return payoffStatsFromModel(model, legs, spot, lotSize);
}

// ── Minimal Black-Scholes pricer for "Target" (pre-expiry) breakevens ──────────

// bsPrice, riskNeutralProbAbove and impliedVolFromPrice live in optionsPricing.ts (the single options-maths library)
// and are re-exported below so existing imports keep working.

// ── Multi-expiry payoff (a positions book spanning several expiries) ──────────

/** Whole calendar days between two local ISO dates, floored at 0. */
export function daysBetweenDates(fromIso: string, toIso: string): number {
  const a = new Date(fromIso); a.setHours(0, 0, 0, 0);
  const b = new Date(toIso);   b.setHours(0, 0, 0, 0);
  return Math.max(0, Math.round((b.getTime() - a.getTime()) / 86_400_000));
}

// ── Strike × date P&L heatmap (Option Strats analyzer) ──────────────────────────

export interface HeatmapGrid {
  dates: string[]; // ISO YYYY-MM-DD, ascending, today..expiryDate inclusive
  /** Header text overriding the date, set only on expiry day (two columns share today's date: "Now", "Expiry"). */
  labels?: string[];
  rows: number[];  // hypothetical underlying spot levels, descending
  cells: number[][]; // cells[rowIndex][colIndex] = net P&L (rupees)
}

/**
 * Grid of net P&L across hypothetical underlying spot levels (rows) and calendar
 * dates from today through expiryDate (columns). The expiry-day column prices
 * intrinsically (t=0, matches legPayoffAtExpiry); earlier columns use bsPrice()
 * with each leg's live IV scaled by ivMultiplier — a pure stress-test knob that
 * never mutates the resolved legs themselves.
 */
/** Local calendar date as YYYY-MM-DD — toISOString() would format in UTC and shift the
 *  date backward for any positive-offset zone (e.g. IST), mislabeling every column. */
function toLocalIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function buildHeatmapGrid(
  legs: ResolvedLeg[],
  spot: number,
  lotSize: number,
  expiryDate: string,
  rangePct: number,
  ivMultiplier: number,
  strikeStep: number = STRIKE_STEP,
  /** Spot- and date-independent P&L added to every cell (e.g. realised P&L of legs already closed). */
  fixedPnl: number = 0,
): HeatmapGrid {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const totalDays = daysToExpiryFrom(expiryDate);

  // Time convention. Leg IVs are solved against the REAL time left to the 15:40 IST expiry, so the
  // grid must price with that same clock or "today" will not reproduce the live P&L (on expiry day it
  // would wipe out all remaining time value). Column 0 is "now"; each later column is the same clock
  // time on a later date; the expiry date settles intrinsically. Mirrors calculateTimeToExpiryYears.
  const [ey, em, ed] = expiryDate.split('-').map(Number);
  const expiryMs = Date.UTC(ey, em - 1, ed, 10, 10, 0);
  const liveDays = Math.max(0.25, (expiryMs - Date.now()) / 86_400_000);
  const expiryDay = totalDays === 0;

  const dates: string[] = [];
  for (let d = 0; d <= totalDays; d++) {
    dates.push(toLocalIsoDate(new Date(today.getTime() + d * 86_400_000)));
  }
  // On expiry day there is only one date but two meaningful moments: now, and settlement.
  let labels: string[] | undefined;
  if (expiryDay) {
    dates.push(dates[0]);
    labels = ['Now', 'Expiry'];
  }
  const lastIdx = dates.length - 1;

  const span = spot * rangePct;
  const lo = Math.floor((spot - span) / strikeStep) * strikeStep;
  const hi = Math.ceil((spot + span) / strikeStep) * strikeStep;
  const rows: number[] = [];
  for (let s = hi; s >= lo; s -= strikeStep) rows.push(s);

  // The P&L itself is the central payoff library's (lib/optionsPayoff.ts payoffGrid): each leg at its own expiry and IV (scaled by the
  // grid's IV control), column c = c days from now, the last column settling every leg at intrinsic value. A leg that expires before a
  // column is already settled there, so a book with several expiries needs no special case.
  // The last column is settlement: push it a hair past expiry so floating-point noise between two clock reads can never leave a sliver of
  // time value on an at-the-money leg.
  const days = dates.map((_, colIdx) => (colIdx === lastIdx ? Math.max(liveDays, 0) + 1e-6 : colIdx));
  const grid = payoffGrid(
    {
      spot,
      legs: legs
        .filter((l) => l.price > 0)
        .map((l) => ({
          type: l.type, strike: l.strike, expiry: l.expiry || expiryDate,
          qty: (l.side === 'SELL' ? -1 : 1) * l.qtyLots * lotSize,
          entryPrice: l.price,
          iv: l.iv !== null && l.iv > 0 ? l.iv : undefined,
        })),
      fallbackIv: 0, // a leg with no IV is priced at intrinsic value, never on a guessed volatility
      ivScale: ivMultiplier,
    },
    rows,
    days,
  );
  const cells = grid.map((row) => row.map((v) => v + fixedPnl));

  return { dates, labels, rows, cells };
}
