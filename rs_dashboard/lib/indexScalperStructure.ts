// Market structure for /index-scalper: swing highs / lows (HH, LH, HL, LL) and breaks of structure (BOS / CHoCH).
// Pure: no React. Tested in indexScalperStructure.test.ts. Used by the chart's "Market structure" indicator
// (lib/indexScalperIndicators.ts) and the trend strip's Structure light (lib/indexScalperTrend.ts).
//
// Swing = the repo's pivot definition (docs/PIVOT_DETECTION.md, lib/pivots.py): bar i is a swing high when its high is
// STRICTLY above the highs of the `len` bars before AND after it (a swing low: low strictly below); ties are not swings.
// A swing is therefore only KNOWN `len` bars later (confirmation lag): it is labelled at its own bar, but nothing here
// uses it before bar i + len. Labels compare with the previous swing of the same kind: HH / LH for highs, HL / LL for
// lows (equal counts as the lower / higher one: LH, HL).
//
// Break: a bar CLOSES beyond the most recent known swing high (up) / swing low (down) that has not been broken yet. In
// the direction of the current structure it is a BOS (break of structure, continuation); against it a CHoCH (change of
// character, the structure turns). The first break of a series has no prior direction: a BOS. The structure direction
// is that of the last break.

export type SwingLabel = 'HH' | 'LH' | 'HL' | 'LL';

export interface Swing {
  /** Index of the swing bar, its price (the high or the low) and the bar at which it became known (i + len). */
  i: number; price: number; kind: 'H' | 'L'; label: SwingLabel | null; knownAt: number;
}

export interface StructureBreak {
  /** Bar whose close broke the level; up = above a swing high. */
  i: number; up: boolean; kind: 'BOS' | 'CHoCH';
  /** The swing broken. */
  level: number; swingI: number;
}

export interface Structure {
  swings: Swing[];
  breaks: StructureBreak[];
  /** Direction of the last break (1 up, -1 down), null before any. */
  dir: 1 | -1 | null;
}

export const STRUCTURE_LEN = 3;

/** Swings and breaks over `bars` (pass CLOSED bars: a forming bar's high / close can still move). */
export function marketStructure(bars: { h: number; l: number; c: number }[], len = STRUCTURE_LEN): Structure {
  const n = bars.length;
  const swings: Swing[] = [];
  const breaks: StructureBreak[] = [];
  if (len < 1 || n === 0) return { swings, breaks, dir: null };
  let lastH: Swing | null = null, lastL: Swing | null = null;
  // The newest known swing of each kind that no close has broken yet.
  let openH: Swing | null = null, openL: Swing | null = null;
  let dir: 1 | -1 | null = null;
  for (let k = 0; k < n; k++) {
    // 1. The swing confirmed at bar k (if any): the pivot at i = k - len, now that its `len` right-hand bars exist.
    const i = k - len;
    if (i >= len) {
      let hi = true, lo = true;
      for (let j = 1; j <= len && (hi || lo); j++) {
        if (!(bars[i].h > bars[i - j].h && bars[i].h > bars[i + j].h)) hi = false;
        if (!(bars[i].l < bars[i - j].l && bars[i].l < bars[i + j].l)) lo = false;
      }
      if (hi) {
        const s: Swing = { i, price: bars[i].h, kind: 'H', label: lastH ? (bars[i].h > lastH.price ? 'HH' : 'LH') : null, knownAt: k };
        swings.push(s); lastH = s; openH = s;
      }
      if (lo) {
        const s: Swing = { i, price: bars[i].l, kind: 'L', label: lastL ? (bars[i].l < lastL.price ? 'LL' : 'HL') : null, knownAt: k };
        swings.push(s); lastL = s; openL = s;
      }
    }
    // 2. A close beyond a known, unbroken swing.
    const c = bars[k].c;
    if (openH && c > openH.price) {
      breaks.push({ i: k, up: true, kind: dir === -1 ? 'CHoCH' : 'BOS', level: openH.price, swingI: openH.i });
      dir = 1; openH = null;
    }
    if (openL && c < openL.price) {
      breaks.push({ i: k, up: false, kind: dir === 1 ? 'CHoCH' : 'BOS', level: openL.price, swingI: openL.i });
      dir = -1; openL = null;
    }
  }
  return { swings, breaks, dir };
}
