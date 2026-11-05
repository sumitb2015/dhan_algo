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
  /** The summed cumulative volume at the last emitted bar, the base of the next bar's volume. */
  lastCum: number | null;
  /** The ms of the last row folded in (rows at or before it are ignored, so a re-read never doubles a bar). */
  lastMs: number;
  bars: Bar[];
};

export const newTickBuild = (legs: number): TickBuild => ({ px: new Array(legs).fill(null), cum: new Array(legs).fill(null), lastCum: null, lastMs: 0, bars: [] });

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

/**
 * Folds each leg's new rows into the build. A bar is emitted for every distinct ms at which the price is known on every leg and the
 * time is inside the trading session; `straddle` = the legs' latest prices summed (a single instrument is carried as ce with pe 0,
 * the shape the history bars have). A price 10x away from the last bar is a bad print and is dropped (lib/straddlePnfLive.ts
 * isWildTick); `refClose` (the history's last close) is the reference before the first bar.
 */
export function foldTickRows(b: TickBuild, legs: TickRow[][], market: Market, refClose?: number): TickBuild {
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
  let lastCum = b.lastCum, lastMs = b.lastMs;
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
    const gap = prevMs > 0 && ms - prevMs > TICK_GAP_MS;
    prevMs = ms;
    // The first bar (and the first after a gap, or a counter that went backwards) only sets the base: the volume before it is in
    // the history's minute bars.
    const vol = lastCum === null || gap || sumCum < lastCum ? 0 : sumCum - lastCum;
    lastCum = sumCum;
    const t = ms / 1000;
    if (!inSession(t, market)) continue;
    out.push({ t, ce, pe, straddle, vol });
    last = straddle;
  }
  return { px, cum, lastCum, lastMs, bars: out.length ? b.bars.concat(out) : b.bars };
}

const minuteOf = (t: number) => Math.floor(t / 60) * 60;

/**
 * The history's 1-minute bars with the tick bars laid in: for each minute the ticks win when there are any, else the minute bar
 * stays (a stretch before the tick log started, or a bridge outage, is drawn from minute closes). Time-ordered. The history bars
 * before the first tick's minute are the same objects, so the chart build carries on instead of rebuilding.
 * `nowS`: a minute bar of the minute still running is left out (every Tick-mode bar is closed, and a forming minute's close would
 * print a brick the next tick could take back).
 */
export function spliceTicks(hist: Bar[], ticks: Bar[], nowS = Infinity): Bar[] {
  const open = Number.isFinite(nowS) ? minuteOf(nowS) : Infinity;
  if (!ticks.length) {
    let k = hist.length;
    while (k > 0 && hist[k - 1].t >= open) k--;
    return k === hist.length ? hist : hist.slice(0, k);
  }
  const first = minuteOf(ticks[0].t);
  let lo = 0, hi = hist.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (hist[mid].t < first) lo = mid + 1; else hi = mid; }
  const covered = new Set<number>();
  for (const b of ticks) covered.add(minuteOf(b.t));
  const out = hist.slice(0, lo);
  let j = 0;
  for (let i = lo; i < hist.length; i++) {
    const h = hist[i];
    if (covered.has(minuteOf(h.t)) || h.t >= open) continue;
    while (j < ticks.length && ticks[j].t < h.t) out.push(ticks[j++]);
    out.push(h);
  }
  while (j < ticks.length) out.push(ticks[j++]);
  return out;
}

/**
 * Renko "10 sec": the tick bars grouped into N-second bars (start-stamped, last price, summed volume), built step by step so the bars
 * already emitted are the same objects on the next call (the chart build then carries on instead of rebuilding). A bucket is emitted
 * once it is over: a tick of a later bucket exists, or the clock is `graceS` past its end (the tick log is served up to ~1.5 s late).
 */
export type SecBuild = { sec: number; used: number; bars: Bar[] };

export function bucketTickBars(prev: SecBuild | null, ticks: Bar[], sec: number, nowS: number, graceS = 2): SecBuild {
  // a different series (new instrument, a new day's log) or bucket size: start again
  let b: SecBuild = prev && prev.sec === sec && prev.used <= ticks.length && (prev.used === 0 || ticks.length > 0) ? prev : { sec, used: 0, bars: [] };
  const startOf = (t: number) => Math.floor(t / sec) * sec;
  let i = b.used;
  const out: Bar[] = [];
  while (i < ticks.length) {
    const start = startOf(ticks[i].t);
    let j = i;
    let vol = 0;
    while (j < ticks.length && startOf(ticks[j].t) === start) vol += ticks[j++].vol;
    const over = j < ticks.length || nowS >= start + sec + graceS;
    if (!over) break;                       // still filling: next call
    const last = ticks[j - 1];
    out.push({ t: start, ce: last.ce, pe: last.pe, straddle: last.straddle, vol });
    i = j;
  }
  if (!out.length && i === b.used) return b;
  b = { sec, used: i, bars: b.bars.concat(out) };
  return b;
}
