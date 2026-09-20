/**
 * Pure maths behind the Option Cube page (3D scatter of price change %,
 * OI change % and IV for one expiry). No React, no fetching — unit-tested.
 *
 * Why these choices (see the page's "How to read" panel for the user-facing
 * version):
 *  - Price change and OI change are day-over-day, against `previous_close_price`
 *    and `previous_oi` (Dhan's field is spelled `_price` on the close only).
 *  - Percentage changes explode on tiny bases (a ₹0.5 premium doubling, an OI
 *    of 300 -> 900), so illiquid strikes are filtered and the plot clamps
 *    outliers to the 2nd/98th percentile instead of letting one point squash
 *    the other 100 into a line.
 *  - Raw IV is dominated by the smile (wings are always "high IV"), so IV is
 *    also expressed as a residual against the neighbouring strikes on the same
 *    side. Rich residual = expensive vs its neighbours (sell-favourable),
 *    cheap residual = buy-favourable.
 *  - Scores use percentile ranks within the filtered set, so they are
 *    comparable across underlyings and immune to a single extreme value.
 */

export interface OcSide {
  last_price?: number;
  previous_close_price?: number;
  oi?: number;
  previous_oi?: number;
  volume?: number;
  implied_volatility?: number;
  greeks?: { iv?: number; delta?: number };
}

export interface OcEntry { ce?: OcSide; pe?: OcSide }

export type Side = 'CE' | 'PE';
export type Signal = 'Long buildup' | 'Short buildup' | 'Short covering' | 'Long unwinding';
export type Goal = 'buy' | 'sell';

export interface ScatterPoint {
  key: string;            // "24500CE"
  strike: number;
  side: Side;
  ltp: number;
  priceChg: number;       // % vs previous close
  oi: number;
  oiChg: number;          // % vs previous OI
  volume: number;
  iv: number;             // %
  ivResidual: number;     // iv - mean(iv of neighbouring strikes, same side)
  delta: number | null;   // signed, as reported
  distPct: number;        // (strike - spot) / spot * 100
  signal: Signal;
  buyScore: number | null;   // 0-100, null = fails the delta gate for buying
  sellScore: number | null;  // 0-100, null = fails the delta gate for selling
}

export interface BuildOptions {
  spot: number;
  /** Keep strikes within this many strikes of ATM each way. 0 = all. */
  strikeWindow: number;
  /** Drop points whose OI is below this % of the chain's largest OI. */
  minOiPct: number;
  /** Drop points whose premium is below this many rupees. */
  minLtp: number;
}

const NEIGHBOURS = 2; // strikes each side used for the IV residual

export function classify(priceChg: number, oiChg: number): Signal {
  if (priceChg >= 0) return oiChg >= 0 ? 'Long buildup' : 'Short covering';
  return oiChg >= 0 ? 'Short buildup' : 'Long unwinding';
}

/** Percentile rank in [0,1] of each value within `values` (ties share the mean rank). */
export function percentileRanks(values: number[]): number[] {
  const n = values.length;
  if (n <= 1) return values.map(() => 0.5);
  const order = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && order[j + 1].v === order[i].v) j++;
    const rank = (i + j) / 2 / (n - 1);
    for (let k = i; k <= j; k++) out[order[k].i] = rank;
    i = j + 1;
  }
  return out;
}

/** Linear-interpolated quantile, q in [0,1]. */
export function quantile(values: number[], q: number): number {
  if (!values.length) return 0;
  const s = [...values].sort((a, b) => a - b);
  const pos = (s.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return s[lo] + (s[hi] - s[lo]) * (pos - lo);
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function ivOf(s: OcSide | undefined): number {
  const v = s?.implied_volatility ?? s?.greeks?.iv ?? 0;
  return Number.isFinite(v) ? v : 0;
}

// Delta gates: buying wants real sensitivity but not deep-ITM capital lock-up;
// selling wants OTM/near-ATM premium with room for the underlying to be wrong.
const BUY_DELTA = [0.2, 0.7] as const;
const SELL_DELTA = [0.05, 0.4] as const;

export function buildPoints(oc: Record<string, OcEntry>, opts: BuildOptions): ScatterPoint[] {
  const { spot } = opts;
  if (!(spot > 0)) return [];

  const strikes = Object.keys(oc).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!strikes.length) return [];

  let atmIdx = 0;
  for (let i = 1; i < strikes.length; i++) {
    if (Math.abs(strikes[i] - spot) < Math.abs(strikes[atmIdx] - spot)) atmIdx = i;
  }
  const lo = opts.strikeWindow > 0 ? Math.max(0, atmIdx - opts.strikeWindow) : 0;
  const hi = opts.strikeWindow > 0 ? Math.min(strikes.length - 1, atmIdx + opts.strikeWindow) : strikes.length - 1;

  // IV residual is computed on the full chain so window edges still have neighbours.
  const ivBySide: Record<Side, Map<number, number>> = { CE: new Map(), PE: new Map() };
  let maxOi = 0;
  for (const k of strikes) {
    const e = oc[String(k)] ?? oc[k.toFixed(6)];
    for (const side of ['CE', 'PE'] as const) {
      const s = side === 'CE' ? e?.ce : e?.pe;
      const iv = ivOf(s);
      if (iv > 0) ivBySide[side].set(k, iv);
      if ((s?.oi ?? 0) > maxOi) maxOi = s?.oi ?? 0;
    }
  }
  const idxOf = new Map(strikes.map((k, i) => [k, i] as const));
  const residual = (side: Side, k: number, iv: number): number => {
    const i = idxOf.get(k)!;
    const ns: number[] = [];
    for (let d = -NEIGHBOURS; d <= NEIGHBOURS; d++) {
      if (d === 0) continue;
      const nk = strikes[i + d];
      const v = nk === undefined ? undefined : ivBySide[side].get(nk);
      if (v !== undefined) ns.push(v);
    }
    return ns.length >= 2 ? iv - ns.reduce((a, b) => a + b, 0) / ns.length : 0;
  };

  const pts: ScatterPoint[] = [];
  for (let i = lo; i <= hi; i++) {
    const k = strikes[i];
    const e = oc[String(k)] ?? oc[k.toFixed(6)];
    for (const side of ['CE', 'PE'] as const) {
      const s = side === 'CE' ? e?.ce : e?.pe;
      if (!s) continue;
      const ltp = s.last_price ?? 0;
      const prevClose = s.previous_close_price ?? 0;
      const oi = s.oi ?? 0;
      const prevOi = s.previous_oi ?? 0;
      const iv = ivOf(s);
      // Percent change is undefined without a base; these can't be plotted honestly.
      if (ltp <= 0 || prevClose <= 0 || prevOi <= 0 || oi <= 0 || iv <= 0) continue;
      if (ltp < opts.minLtp) continue;
      if (maxOi > 0 && (oi / maxOi) * 100 < opts.minOiPct) continue;

      const priceChg = ((ltp - prevClose) / prevClose) * 100;
      const oiChg = ((oi - prevOi) / prevOi) * 100;
      pts.push({
        key: `${k}${side}`,
        strike: k,
        side,
        ltp,
        priceChg,
        oi,
        oiChg,
        volume: s.volume ?? 0,
        iv,
        ivResidual: residual(side, k, iv),
        delta: typeof s.greeks?.delta === 'number' ? s.greeks.delta : null,
        distPct: ((k - spot) / spot) * 100,
        signal: classify(priceChg, oiChg),
        buyScore: null,
        sellScore: null,
      });
    }
  }

  scorePoints(pts);
  return pts;
}

/** Fills buyScore / sellScore in place. */
export function scorePoints(pts: ScatterPoint[]): void {
  if (!pts.length) return;
  const rPrice = percentileRanks(pts.map(p => p.priceChg));
  const rOi = percentileRanks(pts.map(p => p.oiChg));
  const rIv = percentileRanks(pts.map(p => p.ivResidual));
  const inBand = (d: number | null, [a, b]: readonly [number, number]) =>
    d === null || (Math.abs(d) >= a && Math.abs(d) <= b);

  pts.forEach((p, i) => {
    // Buy: momentum in premium, fresh longs, and not paying up for IV vs neighbours.
    p.buyScore = inBand(p.delta, BUY_DELTA)
      ? Math.round(100 * (0.4 * rPrice[i] + 0.35 * rOi[i] + 0.25 * (1 - rIv[i])))
      : null;
    // Sell: premium bleeding while OI builds (writers), and rich IV to harvest.
    p.sellScore = inBand(p.delta, SELL_DELTA)
      ? Math.round(100 * (0.35 * (1 - rPrice[i]) + 0.35 * rOi[i] + 0.3 * rIv[i]))
      : null;
  });
}

export interface AxisClip { lo: number; hi: number; clipped: number }

/** 2nd–98th percentile envelope (padded) so a few outliers don't flatten the cloud. */
export function clipRange(values: number[], enabled: boolean): AxisClip {
  if (!values.length) return { lo: -1, hi: 1, clipped: 0 };
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (!enabled) return { lo: min, hi: max, clipped: 0 };
  const lo = quantile(values, 0.02);
  const hi = quantile(values, 0.98);
  const clipped = values.filter(v => v < lo || v > hi).length;
  return { lo, hi, clipped };
}

export function topByGoal(pts: ScatterPoint[], goal: Goal, n: number): ScatterPoint[] {
  const score = (p: ScatterPoint) => (goal === 'buy' ? p.buyScore : p.sellScore);
  return pts
    .filter(p => score(p) !== null)
    .sort((a, b) => (score(b) as number) - (score(a) as number))
    .slice(0, n);
}
