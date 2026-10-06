/**
 * Options payoff library — the ONE place payoff curves, break-evens, extremes, SD bands, POP, scenario ladders and net Greeks
 * are computed for the dashboard's payoff diagrams. Built on lib/optionsPricing.ts (the single pricing library); rendered by
 * components/strategy/PayoffDiagram.tsx (the single chart). A page supplies legs and a spot; it must not build curves itself.
 *
 * Conventions (all inherited from optionsPricing.ts):
 *   - qty is SIGNED contract units (negative = short); entryPrice is the per-unit premium the P&L is measured from.
 *   - each leg is priced at its OWN expiry and IV, with a Black-76 forward that moves one-for-one with spot. Today's futures basis
 *     (F − spot) is kept for the T+0 curve and decays to zero at the leg's own expiry, where futures and spot converge — so the
 *     expiry curve measures intrinsic value against the index itself (a basis left in would shift every break-even by ~40 points).
 *     With no futures price the forward is the synthetic spot·e^{rT}, which prices identically to Black-Scholes on spot.
 *   - IV is solved from the leg's live `mark`, so the T+0 curve reproduces the book's actual open P&L at the current spot.
 *     (Solving from the entry price instead would force T+0 to ₹0 at spot, which hides the real mark-to-market.)
 *   - "expiry" means the NEAREST expiry in the book: legs on it settle at intrinsic, later legs keep their residual time value
 *     (floored at 0.25 day). "today" is every leg repriced `daysForward` from now; "target" is the what-if curve (days + IV shift).
 *   - "Unlimited" is a position fact (net signed CE/PE quantity), never inferred from the curve tail.
 *   - break-evens are solved on the model itself (bisection), so they never depend on the sampling grid; single-expiry extremes are
 *     exact (evaluated at every strike, at spot 0 and along the tail).
 */

import {
  type OptType,
  RISK_FREE_RATE,
  calculateTimeToExpiryYears,
  computeBsGreeksExact,
  impliedVol,
  priceOption,
  riskNeutralProbAbove,
} from './optionsPricing.ts';

export interface PayoffPoint { spot: number; pnl: number }

export interface PayoffLegInput {
  type: OptType;
  strike: number;
  expiry: string;               // YYYY-MM-DD
  qty: number;                  // signed units
  entryPrice: number;           // per-unit premium the P&L is measured from
  mark?: number;                // live premium; IV is solved from it
  iv?: number;                  // fraction; overrides solving when given
  chainIv?: number;             // fraction; used only if the mark cannot be inverted
  forward?: number;             // Black-76 forward for this expiry at `spot`; default spot·e^{rT}
  lotSize?: number;             // only to label strike pins in lots
  years?: number;               // explicit time to this leg's expiry (overrides `expiry`); for callers that hold a time, not a date
}

export interface PayoffInput {
  legs: PayoffLegInput[];
  spot: number;
  now?: number;
  r?: number;
  daysForward?: number;         // "today" curve offset in days (default 0)
  sim?: { days: number; ivShift: number };  // what-if curve; ivShift in vol points (+5 = +5 points)
  margin?: number;              // rupees blocked, for return on margin
  atmIv?: number;               // fraction, for the SD band and POP; default the IV of the leg nearest the money
  fallbackIv?: number;          // fraction used (and counted) when a leg has no solvable IV (default 15%)
  strikeStep?: number;          // default 50
  rangePct?: number;            // minimum half-width of the drawn window as a fraction of spot (default 8%)
  steps?: number;               // evenly spaced samples (default: ~8 per strike step across the window, 161..1201)
  samples?: number[];           // evaluate exactly at these index levels instead of building a window (adapters that must keep a legacy grid)
  light?: boolean;              // header numbers only (break-evens, extremes, ROM, R:R, POP, Greeks): no curves. For collapsed rows.
}

export interface StrikePin { strike: number; option: OptType; side: 'B' | 'S'; lots?: number }

export interface PayoffModel {
  points: PayoffPoint[];        // at the nearest expiry (empty in light mode)
  today: PayoffPoint[];         // repriced `daysForward` from now (empty in light mode)
  target: PayoffPoint[] | null; // what-if curve, only when `sim` changes something
  breakevens: number[];         // at the nearest expiry, ascending
  maxProfit: number;            // meaningless when maxProfitUnlimited
  maxLoss: number;              // negative or zero; meaningless when maxLossUnlimited
  maxProfitUnlimited: boolean;
  maxLossUnlimited: boolean;
  extremesExact: boolean;       // true for a single-expiry book (kink-exact); false = best/worst of the drawn window
  rom: number | null;           // max profit as % of margin
  pop: number | null;           // %
  riskReward: string | null;
  expectedMove: { sd1Lo: number; sd1Hi: number; sd2Lo: number; sd2Hi: number; iv: number; days: number } | null;
  netGreeks: { delta: number; gamma: number; theta: number; vega: number };  // units / ₹ per day / ₹ per 1% IV
  strikes: StrikePin[];
  frontExpiry: string;
  laterExpiries: string[];
  frontYears: number;
  ivAssumed: number;            // legs priced on the fallback IV
  ivAssumedIdx: number[];       // which input legs (indices) those are
  nowPnl: number;               // book P&L at the current spot, today (IV solved from the marks)
}

const SAME_EXPIRY_EPS = 1e-9;

interface ResolvedLeg extends PayoffLegInput {
  T: number;                    // years to its own expiry
  F0: number;                   // forward at the current spot
  ivUsed: number;
  assumed: boolean;
}

/**
 * Black-76 forward for a leg when the index sits at `s` and `d` years have passed: the current futures basis (F0 − spot) decays
 * linearly to zero at the leg's own expiry, where futures and spot converge. So d = 0 keeps today's basis (additive, as in the
 * canonical engine) and the expiry curve measures intrinsic value against the index itself.
 */
function forwardAt(l: ResolvedLeg, spot: number, s: number, d: number): number {
  return s + (l.F0 - spot) * (Math.max(l.T - d, 0) / l.T);
}

/** Rupees: (model price − entry) × signed qty summed over the book. */
function bookPnl(
  legs: ResolvedLeg[], spot: number, s: number, front: number, r: number,
  mode: 'expiry' | 'today' | 'target', daysForward: number, sim?: { days: number; ivShift: number }, ivScale = 1,
): number {
  let total = 0;
  for (const l of legs) {
    let d: number;
    let iv = l.ivUsed * ivScale;
    if (mode === 'expiry') d = front;
    else if (mode === 'today') d = daysForward / 365;
    else { d = (sim?.days ?? 0) / 365; iv = Math.max(0.01, iv + (sim?.ivShift ?? 0) / 100); }
    // time left on this leg at the evaluation date; a later leg valued at the front expiry keeps at least a quarter day
    let t = Math.max(l.T - d, 0);
    if (mode === 'expiry' && t > SAME_EXPIRY_EPS) t = Math.max(t, 0.25 / 365);
    // No usable IV (fallbackIv 0): intrinsic value against the index itself, never against a forward and never on a guessed vol.
    const px = iv > 0
      ? priceOption(l.type, forwardAt(l, spot, s, d), l.strike, t, iv, r, true)
      : l.type === 'CE' ? Math.max(s - l.strike, 0) : Math.max(l.strike - s, 0);
    total += (px - l.entryPrice) * l.qty;
  }
  return total;
}

function resolveLegs(input: PayoffInput, r: number, now: number): ResolvedLeg[] {
  const fallback = input.fallbackIv ?? 0.15;
  return input.legs.map(l => {
    const T = l.years !== undefined && l.years > 0 ? l.years : calculateTimeToExpiryYears(l.expiry, now);
    const F0 = l.forward && l.forward > 0 ? l.forward : input.spot * Math.exp(r * T);
    let iv = l.iv && l.iv > 0 ? l.iv : null;
    if (iv === null && l.mark && l.mark > 0) iv = impliedVol(l.type, F0, l.strike, T, l.mark, { r, isFutures: true });
    if (iv === null && l.chainIv && l.chainIv > 0) iv = l.chainIv;
    const assumed = iv === null;
    // A fallback of 0 means "no IV, no guess": the leg is priced at intrinsic value only (and counted as assumed).
    return { ...l, T, F0, ivUsed: iv ?? fallback, assumed };
  });
}

function strikeStepOf(strikes: number[], fallback: number): number {
  const u = [...new Set(strikes)].sort((a, b) => a - b);
  if (u.length < 2) return fallback;
  const diffs = u.slice(1).map((v, i) => v - u[i]).sort((a, b) => a - b);
  return diffs[Math.floor(diffs.length / 2)] || fallback;
}

/** Zero crossings of the model, refined by bisection on the model itself. */
function solveBreakevens(f: (s: number) => number, grid: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < grid.length; i++) {
    const a = f(grid[i - 1]);
    const b = f(grid[i]);
    if ((a < 0 && b > 0) || (a > 0 && b < 0)) {
      let x0 = grid[i - 1], x1 = grid[i], f0 = a;
      for (let k = 0; k < 40; k++) {
        const mid = (x0 + x1) / 2;
        const fm = f(mid);
        if ((fm < 0) === (f0 < 0)) { x0 = mid; f0 = fm; } else x1 = mid;
      }
      out.push(Math.round(((x0 + x1) / 2) * 100) / 100); // index levels to the paisa
    }
  }
  return out;
}

export function buildPayoffModel(input: PayoffInput): PayoffModel | null {
  const { spot } = input;
  const r = input.r ?? RISK_FREE_RATE;
  const now = input.now ?? Date.now();
  if (!(spot > 0) || input.legs.length === 0 || input.legs.some(l => !(l.entryPrice > 0))) return null;

  const legs = resolveLegs(input, r, now);
  const years = legs.map(l => l.T);
  const front = Math.min(...years);
  const frontExpiry = legs.find(l => l.T === front)!.expiry;
  const laterExpiries = [...new Set(legs.filter(l => l.T - front > SAME_EXPIRY_EPS).map(l => l.expiry))].sort();
  const singleExpiry = laterExpiries.length === 0;

  const expiryPnl = (s: number) => bookPnl(legs, spot, s, front, r, 'expiry', 0);
  const todayPnl = (s: number) => bookPnl(legs, spot, s, front, r, 'today', input.daysForward ?? 0);

  // 1. Coarse scan to find every break-even, independent of the window we will draw.
  const strikes = legs.map(l => l.strike);
  const step = input.strikeStep ?? strikeStepOf(strikes, 50);
  const scanLo = Math.max(1, Math.min(spot * 0.6, Math.min(...strikes) - step * 8));
  const scanHi = Math.max(spot * 1.4, Math.max(...strikes) + step * 8);
  const scan: number[] = [];
  const scanN = input.light ? 200 : 400;
  for (let i = 0; i <= scanN; i++) scan.push(scanLo + ((scanHi - scanLo) * i) / scanN);
  for (const k of strikes) scan.push(k);
  scan.sort((a, b) => a - b);
  const breakevens = solveBreakevens(expiryPnl, scan);

  // 2. Draw window: at least ±rangePct of spot, every strike ±4 steps and every break-even ±1 step, symmetric about spot.
  const pct = spot * (input.rangePct ?? 0.08);
  const lo0 = Math.min(spot - pct, Math.min(...strikes) - step * 4, (breakevens[0] ?? Infinity) - step);
  const hi0 = Math.max(spot + pct, Math.max(...strikes) + step * 4, (breakevens[breakevens.length - 1] ?? -Infinity) + step);
  const half = Math.max(spot - lo0, hi0 - spot);
  const lo = Math.max(1, spot - half);
  const hi = spot + half;

  const xs = new Set<number>();
  // Density follows the strike step, not a fixed count: 161 samples over a ~3,800-point window is one sample per ~24 points, so the
  // drawn curve showed visible facets (and a zoomed view only a dozen of them). Aim for ~8 samples per strike step, 161..1201.
  const steps = input.steps ?? Math.min(1201, Math.max(161, Math.ceil((hi - lo) / (step / 8)) + 1));
  const fixedGrid = input.samples && input.samples.length > 1 ? [...input.samples].sort((a, b) => a - b) : null;
  if (fixedGrid) fixedGrid.forEach(x => xs.add(x));
  else {
    for (let i = 0; i < steps; i++) xs.add(lo + ((hi - lo) * i) / (steps - 1));
    xs.add(spot);
    for (const k of strikes) if (k > lo && k < hi) xs.add(k);
    for (const b of breakevens) if (b > lo && b < hi) xs.add(b);
  }
  const grid = [...xs].sort((a, b) => a - b);

  const sim = input.sim && (input.sim.days > 0 || input.sim.ivShift !== 0) ? input.sim : null;
  const points = input.light ? [] : grid.map(s => ({ spot: s, pnl: expiryPnl(s) }));
  const today = input.light ? [] : grid.map(s => ({ spot: s, pnl: todayPnl(s) }));
  const target = sim && !input.light ? grid.map(s => ({ spot: s, pnl: bookPnl(legs, spot, s, front, r, 'target', 0, sim) })) : null;

  // 3. Position facts: unlimited risk/profit from net signed quantity (not from the curve), exact extremes when single-expiry.
  const net = (t: OptType) => legs.filter(l => l.type === t).reduce((s, l) => s + l.qty, 0);
  const netCall = net('CE');
  const netPut = net('PE');
  const maxProfitUnlimited = netCall > 0;
  const maxLossUnlimited = netCall < 0 || netPut < 0;

  let maxProfit: number;
  let maxLoss: number;
  if (singleExpiry) {
    const kinks = [...new Set([0, ...strikes])].sort((a, b) => a - b);
    const vals = kinks.map(k => expiryPnl(k));
    maxProfit = Math.max(...vals);
    maxLoss = Math.min(...vals);
  } else {
    const vals = (input.light ? grid.map(s => expiryPnl(s)) : points.map(p => p.pnl));
    maxProfit = Math.max(...vals);
    maxLoss = Math.min(...vals);
  }

  const margin = input.margin ?? 0;
  const rom = !maxProfitUnlimited && margin > 0 ? (maxProfit / margin) * 100 : null;
  let riskReward: string | null = null;
  if (!maxProfitUnlimited && !maxLossUnlimited && maxLoss < 0 && maxProfit > 0) {
    const ratio = Math.abs(maxProfit / maxLoss);
    riskReward = ratio >= 1 ? `1 : ${ratio.toFixed(1)}` : `${(1 / ratio).toFixed(1)} : 1`;
  }

  // 4. SD band and POP use the ATM IV of the nearest expiry (never VIX).
  const frontLegs = legs.filter(l => l.T === front);
  const atmIv = input.atmIv && input.atmIv > 0
    ? input.atmIv
    : [...frontLegs].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))[0]?.ivUsed ?? null;
  const expectedMove = atmIv && front > 0
    ? (() => {
        const sd = spot * atmIv * Math.sqrt(front);
        return {
          sd1Lo: Math.round((spot - sd) * 10) / 10, sd1Hi: Math.round((spot + sd) * 10) / 10,
          sd2Lo: Math.round((spot - 2 * sd) * 10) / 10, sd2Hi: Math.round((spot + 2 * sd) * 10) / 10,
          iv: atmIv, days: front * 365,
        };
      })()
    : null;

  let pop: number | null = null;
  if (atmIv && breakevens.length > 0 && front > 0) {
    const sorted = [...breakevens].sort((a, b) => a - b);
    const offset = Math.max(step, spot * 0.05);
    let p = 0;
    for (let i = 0; i <= sorted.length; i++) {
      const a = i === 0 ? -Infinity : sorted[i - 1];
      const b = i === sorted.length ? Infinity : sorted[i];
      const probe = a === -Infinity ? b - offset : b === Infinity ? a + offset : (a + b) / 2;
      if (probe <= 0 || expiryPnl(probe) <= 0) continue;
      p += (a === -Infinity ? 1 : riskNeutralProbAbove(spot, a, front, atmIv, r)) - (b === Infinity ? 0 : riskNeutralProbAbove(spot, b, front, atmIv, r));
    }
    pop = Math.round(Math.min(1, Math.max(0, p)) * 100);
  }

  // 5. Net Greeks at the current spot, each leg at its own solved IV (units / ₹ per day / ₹ per 1% IV).
  const netGreeks = bookGreeks({ legs: input.legs, spot, now, r, fallbackIv: input.fallbackIv })!.net;

  const pins: StrikePin[] = legs.map(l => ({
    strike: l.strike, option: l.type, side: l.qty < 0 ? 'S' : 'B',
    lots: l.lotSize && l.lotSize > 0 ? Math.abs(l.qty) / l.lotSize : undefined,
  }));

  return {
    points, today, target, breakevens, maxProfit, maxLoss, maxProfitUnlimited, maxLossUnlimited,
    extremesExact: singleExpiry, rom, pop, riskReward, expectedMove, netGreeks, strikes: pins,
    frontExpiry, laterExpiries, frontYears: front,
    ivAssumed: legs.filter(l => l.assumed).length,
    ivAssumedIdx: legs.map((l, i) => (l.assumed ? i : -1)).filter(i => i >= 0),
    nowPnl: todayPnl(spot),
  };
}

// ── Scenario ladder ──────────────────────────────────────────────────────────

export interface LadderRow {
  movePct: number;
  spot: number;
  pnlToday: number;     // book P&L if the move happens now (IV held flat)
  pnlDelta: number;     // change versus the current P&L
  netLotDelta: number;  // lot-weighted net delta at that level
}

export const LADDER_MOVES = [-4, -2, -1, 0, 1, 2, 4];

export function payoffLadder(input: PayoffInput, moves: number[] = LADDER_MOVES): LadderRow[] {
  const r = input.r ?? RISK_FREE_RATE;
  const now = input.now ?? Date.now();
  if (!(input.spot > 0) || input.legs.length === 0) return [];
  const legs = resolveLegs(input, r, now);
  const front = Math.min(...legs.map(l => l.T));
  const days = input.daysForward ?? 0;
  const base = bookPnl(legs, input.spot, input.spot, front, r, 'today', days);
  return moves.map(movePct => {
    const s = input.spot * (1 + movePct / 100);
    let lotDelta = 0;
    for (const l of legs) {
      const t = Math.max(l.T - days / 365, 0);
      const F = forwardAt(l, input.spot, s, days / 365);
      const d = t > 1e-6
        ? computeBsGreeksExact(l.type, F, l.strike, t, l.ivUsed, r, true).delta
        : (l.type === 'CE' ? (F > l.strike ? 1 : 0) : (F < l.strike ? -1 : 0));
      lotDelta += (l.lotSize && l.lotSize > 0 ? l.qty / l.lotSize : 0) * d;
    }
    const pnl = bookPnl(legs, input.spot, s, front, r, 'today', days);
    return { movePct, spot: s, pnlToday: Math.round(pnl), pnlDelta: Math.round(pnl - base), netLotDelta: lotDelta };
  });
}

// ── Book Greeks (per leg and net) ────────────────────────────────────────────

export interface BookGreekLeg {
  index: number;                // position in the input legs
  iv: number;                   // fraction used
  ivSource: 'mark' | 'chain' | 'assumed';
  /** Per-unit Greeks (delta, gamma, theta ₹/day, vega ₹ per 1% IV). Multiply by the signed qty for the position figure. */
  unit: { delta: number; gamma: number; theta: number; vega: number };
}

/**
 * Greeks for a book from the same legs and the same pricing as the payoff model: each leg at its own expiry, IV solved from its live
 * mark (else chain IV, else an assumed one — said so in `ivSource`). Net values are position-scaled (units / ₹ per day / ₹ per 1% IV).
 */
export function bookGreeks(
  input: Pick<PayoffInput, 'legs' | 'spot' | 'now' | 'r' | 'fallbackIv'>,
): { net: { delta: number; gamma: number; theta: number; vega: number }; legs: BookGreekLeg[] } | null {
  const { spot } = input;
  if (!(spot > 0) || input.legs.length === 0) return null;
  const r = input.r ?? RISK_FREE_RATE;
  const now = input.now ?? Date.now();
  const resolved = resolveLegs({ ...input, spot } as PayoffInput, r, now);
  const net = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const legs = resolved.map((l, index) => {
    const g = computeBsGreeksExact(l.type, l.F0, l.strike, l.T, l.ivUsed, r, true);
    net.delta += g.delta * l.qty;
    net.gamma += g.gamma * l.qty;
    net.theta += g.theta * l.qty;
    net.vega += g.vega * l.qty;
    const ivSource: BookGreekLeg['ivSource'] = l.assumed ? 'assumed' : (l.iv && l.iv > 0) || (l.mark && l.mark > 0) ? 'mark' : 'chain';
    return { index, iv: l.ivUsed, ivSource, unit: { delta: g.delta, gamma: g.gamma, theta: g.theta, vega: g.vega } };
  });
  return { net, legs };
}

// ── Adapter for builder-shaped legs ──────────────────────────────────────────

/** The leg shape the strategy builders and Flyagonal use (optionsStrategy.ResolvedLeg and friends). */
export interface BuilderLegLike {
  strike: number;
  type: OptType;
  side: 'BUY' | 'SELL' | 'B' | 'S';
  qtyLots: number;              // multiples of the lot size
  price: number;                // premium: both the entry basis and, unless `mark` is given, the live price
  iv?: number | null;           // fraction
  expiry?: string | null;
  mark?: number;                // live premium when it differs from `price`
}

/** Builder legs → payoff library input. `defaultExpiry` covers legs that carry none. */
export function builderLegsToPayoffLegs(legs: BuilderLegLike[], lotSize: number, defaultExpiry: string): PayoffLegInput[] {
  return legs
    .filter(l => l.price > 0 && (l.expiry || defaultExpiry))
    .map(l => ({
      type: l.type, strike: l.strike, expiry: l.expiry || defaultExpiry,
      qty: (l.side === 'SELL' || l.side === 'S' ? -1 : 1) * l.qtyLots * lotSize,
      entryPrice: l.price, mark: l.mark ?? l.price, chainIv: l.iv && l.iv > 0 ? l.iv : undefined, lotSize,
    }));
}

/** Unlimited profit / loss as a position fact: net signed CE/PE quantity (positive qty = long). Same rule the model uses. */
export function unlimitedFlags(legs: { type: OptType; qty: number }[]): { maxProfitUnlimited: boolean; maxLossUnlimited: boolean } {
  const net = (t: OptType) => legs.filter(l => l.type === t).reduce((s, l) => s + l.qty, 0);
  return { maxProfitUnlimited: net('CE') > 0, maxLossUnlimited: net('CE') < 0 || net('PE') < 0 };
}

// ── Spot × date grid ─────────────────────────────────────────────────────────

/**
 * Book P&L on a grid: rows are index levels, columns are `daysForward` offsets from now (0 = today). Each leg is priced at its own
 * expiry and solved IV (scaled by `ivScale`); a leg whose expiry falls before a column is settled at intrinsic value there, so a book
 * with several expiries is handled without special cases. Same pricing as the curves.
 */
export function payoffGrid(
  input: Pick<PayoffInput, 'legs' | 'spot' | 'now' | 'r' | 'fallbackIv'> & { ivScale?: number },
  spots: number[],
  daysForward: number[],
): number[][] {
  if (!(input.spot > 0) || input.legs.length === 0) return spots.map(() => daysForward.map(() => 0));
  const r = input.r ?? RISK_FREE_RATE;
  const now = input.now ?? Date.now();
  const legs = resolveLegs({ ...input } as PayoffInput, r, now);
  const front = Math.min(...legs.map(l => l.T));
  const scale = input.ivScale ?? 1;
  return spots.map(s => daysForward.map(d => bookPnl(legs, input.spot, s, front, r, 'today', d, undefined, scale)));
}

/** Book P&L at specific index levels, at the nearest expiry (`expiry`) or `daysForward` from now (`today`). The lightest entry point. */
export function payoffAt(
  input: Pick<PayoffInput, 'legs' | 'spot' | 'now' | 'r' | 'fallbackIv' | 'daysForward'>,
  spots: number[],
  mode: 'expiry' | 'today' = 'expiry',
): number[] {
  if (!(input.spot > 0) || input.legs.length === 0) return spots.map(() => 0);
  const r = input.r ?? RISK_FREE_RATE;
  const now = input.now ?? Date.now();
  const legs = resolveLegs({ ...input } as PayoffInput, r, now);
  const front = Math.min(...legs.map(l => l.T));
  return spots.map(s => bookPnl(legs, input.spot, s, front, r, mode, input.daysForward ?? 0));
}
