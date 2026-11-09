// Renko "Tick" mode: the WebSocket bridge's recorded prices (scripts/tools/pnf_ws.py -> debug/pnf_ticks/, served by
// /api/straddle-pnf/ticks) turned into chart bars. Pure: no I/O, no clocks.
//
// Every recorded price change is its own bar, stamped to the millisecond (t = ms / 1000), and every bar is CLOSED the moment it
// exists: a brick prints when a price crosses the box, and alerts / AUTO (which act on the newest closed bar) act on it at once.
// Bars are never rewritten once emitted, so the chart build (buildConfirmedModel's prefix reuse) carries on over the new ones.
//
// The route only serves ticks stamped a little in the past (`upTo`), so the two legs of a straddle written in one bridge pass
// always arrive together: a group of rows with one ms is one bar.
import { inSession, isWildTick, type Market } from './straddlePnfLive.ts';
import type { Bar } from './straddlePnf.ts';

/** One recorded price: [epoch ms, LTP, cumulative day volume (0 when the instrument has none)]. */
export type TickRow = [number, number, number];

/** A tick gap this long (bridge down, nothing asked for) restarts the volume count, so the gap's volume is not lumped into one bar. */
export const TICK_GAP_MS = 90_000;

export type TickBuild = {
  /** Each leg's latest price and cumulative volume (null until it has one). */
  px: (number | null)[];
  cum: (number | null)[];
  /** The summed cumulative volume at the last emitted bar, the base of the next bar's volume, and how many legs it summed. */
  lastCum: number | null;
  cumLegs: number;
  /** The ms of the last row folded in (rows at or before it are ignored, so a re-read never doubles a bar). */
  lastMs: number;
  bars: Bar[];
};

export const newTickBuild = (legs: number): TickBuild => ({ px: new Array(legs).fill(null), cum: new Array(legs).fill(null), lastCum: null, cumLegs: 0, lastMs: 0, bars: [] });

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Folds each leg's new rows into the build. A bar is emitted for every distinct ms at which the price is known on every leg and the
 * time is inside the trading session; `straddle` = the legs' latest prices summed (a single instrument is carried as ce with pe 0,
 * the shape the history bars have). A price 10x away from the last bar is a bad print and is dropped (lib/straddlePnfLive.ts
 * isWildTick); `refClose` (the history's last close) is the reference before the first bar.
 *
 * `seed`: each leg's last known price from the history. The log only holds prices that CHANGED while the bridge was asking, so a
 * straddle leg that has not moved since then has no row; its seed stands in until its first row (else no bar could be emitted).
 */
export function foldTickRows(b: TickBuild, legs: TickRow[][], market: Market, refClose?: number, seed?: (number | null | undefined)[]): TickBuild {
  const n = b.px.length;
  type Ev = { ms: number; leg: number; ltp: number; vol: number };
  const evs: Ev[] = [];
  legs.slice(0, n).forEach((rows, leg) => {
    for (const r of rows) {
      if (!Array.isArray(r) || !finite(r[0]) || !finite(r[1]) || !(r[1] > 0) || r[0] <= b.lastMs) continue;
      evs.push({ ms: r[0], leg, ltp: r[1], vol: finite(r[2]) && r[2] >= 0 ? r[2] : 0 });
    }
  });
  if (!evs.length) return b;
  evs.sort((x, y) => x.ms - y.ms || x.leg - y.leg);
  const px = b.px.slice(), cum = b.cum.slice();
  for (let k = 0; k < n; k++) if (px[k] === null && finite(seed?.[k]) && (seed![k] as number) > 0) px[k] = seed![k] as number;
  let lastCum = b.lastCum, cumLegs = b.cumLegs, lastMs = b.lastMs;
  const out: Bar[] = [];
  let prevMs = b.lastMs;
  let last = b.bars[b.bars.length - 1]?.straddle ?? refClose;
  for (let i = 0; i < evs.length;) {
    const ms = evs[i].ms;
    const was = px.slice();
    for (; i < evs.length && evs[i].ms === ms; i++) { px[evs[i].leg] = evs[i].ltp; cum[evs[i].leg] = evs[i].vol; }
    lastMs = ms;
    if (px.some(p => p === null)) { prevMs = ms; continue; }
    const ce = px[0] as number, pe = n > 1 ? (px[1] as number) : 0;
    const straddle = ce + pe;
    if (isWildTick(last, straddle)) { for (let k = 0; k < n; k++) px[k] = was[k]; continue; }   // a bad print: as if it never came
    const sumCum = cum.reduce<number>((a, c) => a + (c ?? 0), 0);
    const legsNow = cum.filter(c => c !== null).length;
    const gap = prevMs > 0 && ms - prevMs > TICK_GAP_MS;
    prevMs = ms;
    // The first bar (and the first after a gap, a counter that went backwards, or a leg's first volume figure joining the sum) only
    // sets the base: the volume before it is in the history's minute bars.
    const vol = lastCum === null || gap || sumCum < lastCum || legsNow !== cumLegs ? 0 : sumCum - lastCum;
    lastCum = sumCum; cumLegs = legsNow;
    const t = ms / 1000;
    if (!inSession(t, market)) continue;
    out.push({ t, ce, pe, straddle, vol });
    last = straddle;
  }
  return { px, cum, lastCum, cumLegs, lastMs, bars: out.length ? b.bars.concat(out) : b.bars };
}

const minuteOf = (t: number) => Math.floor(t / 60) * 60;

/**
 * The history's 1-minute bars up to the tick log, then the tick bars: history is used only BEFORE the first tick's minute (the
 * stretch before the bridge started logging). From the first tick on the ticks own the chart, and a history bar is never laid in
 * between them: its close can differ from the last logged price, so inserting one later would change bricks that alerts / AUTO
 * already acted on. A bridge outage therefore shows as a jump, and the bricks catch up on the next logged price.
 * The history bars kept are the same objects, so the chart build carries on instead of rebuilding.
 * `nowS`: with no ticks yet, a minute bar of the minute still running is left out (every bar here is closed, and a forming
 * minute's close would print a brick the next price could take back).
 *
 * `fillUpTo` (seconds): the cut-off of the chart's FIRST read of the day's tick log. A gap in the log (> TICK_GAP_MS: nothing was
 * recorded because no chart or server feed asked for the instrument) that had already ended by then is history, exactly like the
 * stretch before the first tick: the 1-minute bars lying wholly inside it are laid in. A gap ending after it opened while this chart
 * was running and stays a jump (filling it later would change bricks alerts / AUTO already acted on).
 */
/**
 * The `fillUpTo` for spliceTicks, taken once at the chart's first read of the day's log: that read's cut-off (`upToS`), but no later
 * than the end of the history the chart held then. Every minute inside a gap that ended by it was already in that history, so a
 * later history refresh (Dhan's minute bars arrive 1-2 min late) can never lay a new bar into a gap that is already drawn.
 * No history yet: nothing is filled.
 */
export const fillCutoff = (upToS: number, histLast: Bar | undefined): number => (histLast ? Math.min(upToS, histLast.t + 60) : -Infinity);

export function spliceTicks(hist: Bar[], ticks: Bar[], nowS = Infinity, fillUpTo = -Infinity): Bar[] {
  const cut = ticks.length ? minuteOf(ticks[0].t) : Number.isFinite(nowS) ? minuteOf(nowS) : Infinity;
  let k = hist.length;
  while (k > 0 && hist[k - 1].t >= cut) k--;
  if (!ticks.length) return k === hist.length ? hist : hist.slice(0, k);
  if (ticks.length < 2 || fillUpTo < ticks[1].t) return hist.slice(0, k).concat(ticks);   // no gap can have ended by then
  const gapS = TICK_GAP_MS / 1000;
  const out = hist.slice(0, k);
  out.push(ticks[0]);
  let j = k;                                     // history cursor: gaps are visited in time order
  for (let i = 1; i < ticks.length; i++) {
    const a = ticks[i - 1].t, b = ticks[i].t;
    if (b <= fillUpTo && b - a > gapS) {
      let lo = j, hi = hist.length;              // first minute starting after `a`
      while (lo < hi) { const mid = (lo + hi) >> 1; if (hist[mid].t <= a) lo = mid + 1; else hi = mid; }
      for (j = lo; j < hist.length && hist[j].t + 60 <= b; j++) out.push(hist[j]);
    }
    out.push(ticks[i]);
  }
  return out;
}

/**
 * Renko "10 sec": the tick bars grouped into N-second bars (start-stamped, last price, summed volume), built step by step so the bars
 * already emitted are the same objects on the next call (the chart build then carries on instead of rebuilding). A bucket is emitted
 * once it is over: a tick of a later bucket exists, or `upToS` (the ticks route's `upTo`: every row up to it has been served) has
 * reached its end. Judged on the server's cut-off, not the browser's clock, so a skewed clock cannot close a bucket early. A tick
 * that still lands in a bucket already emitted is folded into the next one, so no two bars share a time.
 */
export type SecBuild = { sec: number; used: number; bars: Bar[] };

export function bucketTickBars(prev: SecBuild | null, ticks: Bar[], sec: number, upToS: number): SecBuild {
  // a different series (new instrument, a new day's log) or bucket size: start again
  let b: SecBuild = prev && prev.sec === sec && prev.used <= ticks.length && (prev.used === 0 || ticks.length > 0) ? prev : { sec, used: 0, bars: [] };
  const emitted = b.bars.length ? b.bars[b.bars.length - 1].t : -Infinity;
  const startOf = (t: number) => Math.max(Math.floor(t / sec) * sec, emitted + sec);   // never back into an emitted bucket
  let i = b.used;
  const out: Bar[] = [];
  while (i < ticks.length) {
    const start = startOf(ticks[i].t);
    let j = i;
    let vol = 0;
    while (j < ticks.length && startOf(ticks[j].t) === start) vol += ticks[j++].vol;
    const over = j < ticks.length || upToS >= start + sec;
    if (!over) break;                       // still filling: next call
    const last = ticks[j - 1];
    out.push({ t: start, ce: last.ce, pe: last.pe, straddle: last.straddle, vol });
    i = j;
  }
  if (!out.length && i === b.used) return b;
  b = { sec, used: i, bars: b.bars.concat(out) };
  return b;
}
