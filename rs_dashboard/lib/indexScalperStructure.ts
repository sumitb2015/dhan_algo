// Market structure for /index-scalper: swing highs / lows labelled HH, LH, HL, LL. Pure: no React. Tested in
// indexScalperStructure.test.ts. Used by the chart's "Market structure" indicator (lib/indexScalperIndicators.ts) and
// the trend strip's Structure light (lib/indexScalperTrend.ts).
//
// Swing = the repo's pivot definition (docs/PIVOT_DETECTION.md, lib/pivots.py): bar i is a swing high when its high is
// STRICTLY above the highs of the `len` bars before AND after it (a swing low: low strictly below); ties are not swings.
// A swing is therefore only KNOWN `len` bars later (confirmation lag): it is labelled at its own bar, but nothing here
// uses it before bar i + len. Labels compare with the previous swing of the same kind: HH / LH for highs, HL / LL for
// lows (equal counts as the lower / higher one: LH, HL).
//
// Direction (the strip's light): up when the latest swing high is a HH AND the latest swing low a HL; down when they
// are a LH and a LL; mixed (0) otherwise; null until both kinds have a labelled swing.
//
// BOS / CHoCH (break-of-structure) markers were removed on 2026-11-27 at the user's request: their logic and display
// were judged not correct. Do not bring them back without a new spec.

export type SwingLabel = 'HH' | 'LH' | 'HL' | 'LL';

export interface Swing {
  /** Index of the swing bar, its price (the high or the low) and the bar at which it became known (i + len). */
  i: number; price: number; kind: 'H' | 'L'; label: SwingLabel | null; knownAt: number;
}

export interface Structure {
  swings: Swing[];
  /** 1 = HH + HL, -1 = LH + LL, 0 = mixed, null = not both labelled yet. */
  dir: 1 | -1 | 0 | null;
  /** The latest labelled swing high and swing low (null when none yet). */
  lastHigh: Swing | null;
  lastLow: Swing | null;
}

export const STRUCTURE_LEN = 3;

/** Swings over `bars` (pass CLOSED bars: a forming bar's high / low can still move). */
export function marketStructure(bars: { h: number; l: number }[], len = STRUCTURE_LEN): Structure {
  const n = bars.length;
  const swings: Swing[] = [];
  if (len < 1 || n === 0) return { swings, dir: null, lastHigh: null, lastLow: null };
  let lastH: Swing | null = null, lastL: Swing | null = null;
  // The swing confirmed at bar k (if any) is the pivot at i = k - len, once its `len` right-hand bars exist.
  for (let k = 2 * len; k < n; k++) {
    const i = k - len;
    let hi = true, lo = true;
    for (let j = 1; j <= len && (hi || lo); j++) {
      if (!(bars[i].h > bars[i - j].h && bars[i].h > bars[i + j].h)) hi = false;
      if (!(bars[i].l < bars[i - j].l && bars[i].l < bars[i + j].l)) lo = false;
    }
    if (hi) {
      const s: Swing = { i, price: bars[i].h, kind: 'H', label: lastH ? (bars[i].h > lastH.price ? 'HH' : 'LH') : null, knownAt: k };
      swings.push(s); lastH = s;
    }
    if (lo) {
      const s: Swing = { i, price: bars[i].l, kind: 'L', label: lastL ? (bars[i].l < lastL.price ? 'LL' : 'HL') : null, knownAt: k };
      swings.push(s); lastL = s;
    }
  }
  const lastHigh = lastH?.label ? lastH : null;
  const lastLow = lastL?.label ? lastL : null;
  const dir = !lastHigh || !lastLow ? null
    : lastHigh.label === 'HH' && lastLow.label === 'HL' ? 1
    : lastHigh.label === 'LH' && lastLow.label === 'LL' ? -1 : 0;
  return { swings, dir, lastHigh, lastLow };
}
