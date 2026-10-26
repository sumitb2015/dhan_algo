// Previous-day pivot levels for the Price Ladder's Price column: the CPR (pivot + top / bottom central) and R1-R4 / S1-S4.
// Pure. The CPR is the same under every formula; the formula only changes how far R3/R4 and S3/S4 reach.

export type PivotFormula = 'classic' | 'traditional' | 'camarilla';
export const PIVOT_FORMULAS: readonly PivotFormula[] = ['classic', 'traditional', 'camarilla'];

export interface PivotSet {
  p: number; tc: number; bc: number;
  r1: number; r2: number; r3: number; r4: number;
  s1: number; s2: number; s3: number; s4: number;
}

const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * Levels from the previous session's high / low / close, or null when any is not a positive number (or high < low).
 *  - CPR: P = (H+L+C)/3, BC = (H+L)/2, TC = 2P - BC. TC is the upper edge and BC the lower, whichever way the day closed
 *    (when the close is below the midpoint, 2P - BC falls under BC), so `tc >= bc` always.
 *  - classic (TradingView "Classic"): R1 = 2P-L, R2 = P+range, R3 = P+2*range, R4 = P+3*range; S mirrored.
 *  - traditional (floor trader): R3 = H+2(P-L), R4 = R3+(R2-R1); S3 = L-2(H-P), S4 = S3-(S1-S2).
 *  - camarilla: C +/- range * 1.1/12, 1.1/6, 1.1/4, 1.1/2 (R4 / S4 are the breakout levels).
 */
export function computePivots(high: number, low: number, close: number, formula: PivotFormula = 'classic'): PivotSet | null {
  if (!(high > 0) || !(low > 0) || !(close > 0) || high < low) return null;
  const range = high - low;
  const p = (high + low + close) / 3;
  const mid = (high + low) / 2;
  const other = 2 * p - mid;
  const tc = Math.max(mid, other), bc = Math.min(mid, other);
  let r: [number, number, number, number], s: [number, number, number, number];
  if (formula === 'camarilla') {
    const k = [1.1 / 12, 1.1 / 6, 1.1 / 4, 1.1 / 2];
    r = k.map(x => close + range * x) as [number, number, number, number];
    s = k.map(x => close - range * x) as [number, number, number, number];
  } else {
    const r1 = 2 * p - low, s1 = 2 * p - high;
    const r2v = p + range, s2v = p - range;
    if (formula === 'traditional') {
      const r3 = high + 2 * (p - low), s3 = low - 2 * (high - p);
      r = [r1, r2v, r3, r3 + (r2v - r1)];
      s = [s1, s2v, s3, s3 - (s1 - s2v)];
    } else {
      r = [r1, r2v, p + 2 * range, p + 3 * range];
      s = [s1, s2v, p - 2 * range, p - 3 * range];
    }
  }
  return {
    p: r2(p), tc: r2(tc), bc: r2(bc),
    r1: r2(r[0]), r2: r2(r[1]), r3: r2(r[2]), r4: r2(r[3]),
    s1: r2(s[0]), s2: r2(s[1]), s3: r2(s[2]), s4: r2(s[3]),
  };
}

/** The ladder's chips: `show.cpr` = P / TC / BC, `show.pivots` = R1-R4 / S1-S4. Only positive levels are returned. */
export interface PivotChip { key: string; label: string; price: number; group: 'cpr' | 'r' | 's' }
export function pivotChips(set: PivotSet | null, show: { cpr: boolean; pivots: boolean }): PivotChip[] {
  if (!set) return [];
  const out: PivotChip[] = [];
  if (show.cpr) out.push({ key: 'tc', label: 'TC', price: set.tc, group: 'cpr' }, { key: 'p', label: 'P', price: set.p, group: 'cpr' }, { key: 'bc', label: 'BC', price: set.bc, group: 'cpr' });
  if (show.pivots) {
    for (const n of [1, 2, 3, 4] as const) out.push({ key: `r${n}`, label: `R${n}`, price: set[`r${n}`], group: 'r' }, { key: `s${n}`, label: `S${n}`, price: set[`s${n}`], group: 's' });
  }
  return out.filter(c => c.price > 0);
}
