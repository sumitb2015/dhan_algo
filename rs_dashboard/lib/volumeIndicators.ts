// Volume indicators for the shared chart indicator engine (lib/indexScalperIndicators.ts): VWAP std-dev bands, OBV,
// MFI, CMF, VWMA and relative volume. Pure functions over bars; each follows the Pine built-in it is named after
// (TradingView's definition) so a chart can be compared against TradingView's. One entry per input bar; null = no value
// (warm-up, or no volume to work from).
//
// Volume exists only where Dhan sends it: futures, options and stocks. The NSE / BSE index has none, so every
// volume-based value is null there (`hasVolume`), except the VWAP bands, which are equal-weighted like the session VWAP.

import type { Bar } from './indexScalperIndicators.ts';

/** A bar's volume, 0 when missing or not a positive finite number (the forming bar before its first volume tick). */
const vol = (b: Bar): number => (b.v !== undefined && Number.isFinite(b.v) && b.v > 0 ? b.v : 0);

/** Any bar in the list carries volume. */
export function hasVolume(bars: Bar[]): boolean {
  return bars.some(b => vol(b) > 0);
}

/** IST calendar day of a bar (same as indexScalperIndicators' istDay; kept local to avoid an import cycle). */
const istDay = (t: number) => Math.floor((t + 19800) / 86400);

/**
 * Session VWAP (hlc3, reset at the IST day change) and its standard deviation, TradingView's VWAP "Bands" as
 * `ta.vwap(src, anchor, mult)` computes them: stdev = sqrt(max(Σ(v·src²)/Σv − vwap², 0)). The centre is exactly
 * sessionVwap(): volume-weighted once the session has volume, equal-weighted before that (and on the index, which has
 * none), so the bands of the index are the spread of the session's typical prices.
 */
export function vwapWithStdev(bars: Bar[]): { vwap: (number | null)[]; sd: (number | null)[] } {
  const vwap: (number | null)[] = [];
  const sd: (number | null)[] = [];
  let day = -1;
  let n = 0, sum = 0, sum2 = 0, v = 0, pv = 0, pv2 = 0;
  for (const b of bars) {
    const d = istDay(b.t);
    if (d !== day) { day = d; n = 0; sum = 0; sum2 = 0; v = 0; pv = 0; pv2 = 0; }
    const tp = (b.h + b.l + b.c) / 3;
    const w = vol(b);
    n += 1; sum += tp; sum2 += tp * tp;
    v += w; pv += tp * w; pv2 += tp * tp * w;
    const mean = v > 0 ? pv / v : sum / n;
    const meanSq = v > 0 ? pv2 / v : sum2 / n;
    vwap.push(mean);
    sd.push(Math.sqrt(Math.max(meanSq - mean * mean, 0)));
  }
  return { vwap, sd };
}

/** Pine `ta.obv`: cumulative sum of sign(change(close)) × volume, starting at 0 (the first bar has no change). All null
 *  without volume. */
export function obv(bars: Bar[]): (number | null)[] {
  if (!hasVolume(bars)) return bars.map(() => null);
  const out: (number | null)[] = [];
  let acc = 0;
  for (let i = 0; i < bars.length; i++) {
    if (i > 0) acc += Math.sign(bars[i].c - bars[i - 1].c) * vol(bars[i]);
    out.push(acc);
  }
  return out;
}

/** Rolling sum over `len` values; null until `len` values exist. */
function rollingSum(xs: number[], len: number): (number | null)[] {
  const out: (number | null)[] = [];
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    s += xs[i];
    if (i >= len) s -= xs[i - len];
    out.push(i >= len - 1 ? s : null);
  }
  return out;
}

/**
 * Pine `ta.mfi(hlc3, len)` (TradingView "Money Flow Index", 14): upper = Σ volume·tp over bars whose tp rose, lower = Σ
 * over bars whose tp fell (an unchanged tp counts in neither), MFI = 100 − 100 / (1 + upper / lower). Pine compares a
 * missing change as false, so the very first bar counts in both sums; we do the same, but print nothing until bar
 * `len` (the terminal's first value; Pine's comes one bar earlier). No falling flow in the window
 * (lower 0) reads 100, no flow at all null. All null without volume.
 */
export function mfi(bars: Bar[], len: number): (number | null)[] {
  if (!hasVolume(bars) || !(len >= 1)) return bars.map(() => null);
  const L = Math.floor(len);
  const tp = bars.map(b => (b.h + b.l + b.c) / 3);
  const up: number[] = [], dn: number[] = [];
  for (let i = 0; i < bars.length; i++) {
    const ch = i > 0 ? tp[i] - tp[i - 1] : NaN;
    const mf = vol(bars[i]) * tp[i];
    up.push(ch <= 0 ? 0 : mf);   // NaN <= 0 is false: the first bar counts, as in Pine
    dn.push(ch >= 0 ? 0 : mf);
  }
  const su = rollingSum(up, L), sd = rollingSum(dn, L);
  return su.map((u, i) => {
    const d = sd[i];
    // First value at bar `len` (len changes in the window), as the tradingcharts.co terminal; Pine starts one bar earlier.
    if (u === null || d === null || i < L) return null;
    if (d === 0) return u > 0 ? 100 : null;
    return 100 - 100 / (1 + u / d);
  });
}

/**
 * TradingView "Chaikin Money Flow" (20): money-flow volume = ((close − low) − (high − close)) / (high − low) × volume, 0
 * on a bar with no range; CMF = Σ mfv / Σ volume over `len` bars. Null where the window has no volume. All null without
 * volume.
 */
export function cmf(bars: Bar[], len: number): (number | null)[] {
  if (!hasVolume(bars) || !(len >= 1)) return bars.map(() => null);
  const L = Math.floor(len);
  const mfv = bars.map(b => {
    const r = b.h - b.l;
    return r > 0 ? ((2 * b.c - b.l - b.h) / r) * vol(b) : 0;
  });
  const sm = rollingSum(mfv, L), sv = rollingSum(bars.map(vol), L);
  return sm.map((m, i) => (m === null || !sv[i] ? null : m / (sv[i] as number)));
}

/** Pine `ta.vwma(close, len)`: Σ(close·volume) / Σ volume over `len` bars. Null where the window has no volume; all null
 *  without volume. */
export function vwma(bars: Bar[], len: number): (number | null)[] {
  if (!hasVolume(bars) || !(len >= 1)) return bars.map(() => null);
  const L = Math.floor(len);
  const spv = rollingSum(bars.map(b => b.c * vol(b)), L), sv = rollingSum(bars.map(vol), L);
  return spv.map((s, i) => (s === null || !sv[i] ? null : s / (sv[i] as number)));
}

/**
 * Relative volume at time of day: a bar's volume ÷ the average volume of the bars at the SAME time of day (IST) in the
 * previous `days` sessions that have one. Volume always spikes at the open and the close, so this, not volume ÷ a moving
 * average, shows what is unusual for that moment. On daily / weekly / monthly bars every bar has the same time of day,
 * so it becomes volume ÷ the average of the previous `days` bars. Null with no earlier bar at that time, or a zero
 * average; all null without volume.
 */
export function relativeVolume(bars: Bar[], days: number): (number | null)[] {
  if (!hasVolume(bars) || !(days >= 1)) return bars.map(() => null);
  const N = Math.floor(days);
  const seen = new Map<number, number[]>();   // time-of-day slot -> volumes of earlier bars at that slot, oldest first
  const out: (number | null)[] = [];
  for (const b of bars) {
    const slot = ((b.t + 19800) % 86400 + 86400) % 86400;
    const prev = seen.get(slot) ?? [];
    const look = prev.slice(-N);
    const avg = look.length ? look.reduce((a, x) => a + x, 0) / look.length : 0;
    out.push(avg > 0 ? vol(b) / avg : null);
    prev.push(vol(b));
    seen.set(slot, prev);
  }
  return out;
}
