// Renko engine (TradingView "Traditional" box, close as the source). Pure: no I/O, no clocks (time arrives in the bars).
//
// The grid is every multiple of the box (a 10-point box on NIFTY: ... 22,650, 22,660 ...). Starting from the first close rounded
// to the grid, an up brick prints each time the close reaches the last brick's top + 1 box, a down brick each time it reaches the
// last brick's bottom - 1 box; a reversal therefore needs a 2-box move, and one bar can print several bricks.
//
// Each brick is handed back as a one-box PnfColumn (dir X = up, O = down; low / high = the brick's real edges), so the P&F panel,
// its layout, crosshair, time axis, rail and AUTO's "first opposite column" reversal all work on bricks unchanged.
import { supertrendSeries } from './indicators.ts';
import { sessionOf, type Bar, type PnfColumn, type PnfSignal } from './straddlePnf.ts';

const EPS = 1e-9;

/** Where a Renko build stopped (the last brick's top and bottom, in boxes), so it can carry on over more bars. `bars` = bars read. */
export type RenkoResume = { box: number; hi: number; lo: number; bars: number };

/** Feeds bars [from, to) through the Traditional rules, appending bricks to `columns`; returns the new hi / lo. */
function runRenko(columns: PnfColumn[], at: (i: number) => Bar, from: number, to: number, box: number, hi0: number, lo0: number) {
  let hi = hi0, lo = lo0;
  const brick = (dir: 'X' | 'O', k: number, i: number) => {
    columns.push({ dir, low: k * box, high: (k + 1) * box, boxes: 1, startBar: i, endBar: i, session: sessionOf(at(i).t), breakBar: null, boxBars: [i] });
  };
  for (let i = from; i < to; i++) {
    const b = at(i);
    if (!(b.straddle > 0)) continue;
    const x = b.straddle / box;
    if (x >= hi + 1 - EPS) {
      while (x >= hi + 1 - EPS) { brick('X', hi, i); lo = hi; hi += 1; }
    } else if (x <= lo - 1 + EPS) {
      while (x <= lo - 1 + EPS) { brick('O', lo - 1, i); hi = lo; lo -= 1; }
    }
  }
  return { hi, lo };
}

export function buildRenko(bars: Bar[], box: number, anchorPrice?: number): { anchor: number; box: number; columns: PnfColumn[]; resume: RenkoResume | null } {
  const first = bars.find(b => b.straddle > 0);
  if (!first || !(box > 0)) return { anchor: 0, box: 0, columns: [], resume: null };
  const anchor = Math.round((anchorPrice !== undefined && anchorPrice > 0 ? anchorPrice : first.straddle) / box) * box;
  // The bricks start from the FIRST bar's own grid level (with a long history the anchor can be a recent price far away).
  const start = Math.round(first.straddle / box);   // in boxes
  const columns: PnfColumn[] = [];
  const { hi, lo } = runRenko(columns, i => bars[i], 0, bars.length, box, start, start);
  return { anchor, box, columns, resume: { box, hi, lo, bars: bars.length } };
}

/** The bricks `buildRenko` would draw over `bars` + `more`, from `buildRenko(bars)`'s bricks and resume state, reading only `more`. */
export function extendRenko(columns: PnfColumn[], resume: RenkoResume, more: Bar[]): PnfColumn[] {
  return continueRenko(columns, resume, more).columns;
}

/** extendRenko plus the resume state after `more`, so a build can be carried on step after step (bar replay, closed bars). */
export function continueRenko(columns: PnfColumn[], resume: RenkoResume, more: Bar[]): { columns: PnfColumn[]; resume: RenkoResume } {
  if (!more.length) return { columns, resume };
  const out = columns.slice();
  const { hi, lo } = runRenko(out, i => more[i - resume.bars], resume.bars, resume.bars + more.length, resume.box, resume.hi, resume.lo);
  return { columns: out, resume: { box: resume.box, hi, lo, bars: resume.bars + more.length } };
}

/** A brick's close: its top when it is up, its bottom when it is down. */
export const brickClose = (c: PnfColumn) => (c.dir === 'X' ? c.high : c.low);

/**
 * N-brick confirmation: a BUY on the brick that completes a run of `n` up bricks following a down brick, a SELL on the mirror.
 * The very first run of the chart has no opposite brick before it and never signals.
 */
export function renkoSignals(columns: PnfColumn[], bars: Bar[], reference: (number | null)[], n: number): PnfSignal[] {
  const need = Math.max(1, Math.floor(n));
  const out: PnfSignal[] = [];
  let run = 0;
  let sawReversal = false;
  columns.forEach((c, col) => {
    const prev = columns[col - 1];
    if (prev && prev.dir !== c.dir) { run = 1; sawReversal = true; } else run += 1;
    if (!sawReversal || run !== need) return;
    const kind = c.dir === 'X' ? 'RENKO_BUY' : 'RENKO_SELL';
    const price = brickClose(c);
    const v = reference[c.startBar];
    out.push({ id: `${kind}:${col}`, kind, col, bar: c.startBar, t: bars[c.startBar].t, price, belowVwap: v != null && price < v });
  });
  return out;
}

/**
 * The Definedge "back" continuation patterns on bricks (each column is one brick; a run is consecutive columns of one direction).
 * BUY: a trend of at least `trend` up bricks, a pullback of exactly `pull` down bricks, then the up run resumes and the brick that
 * makes it at least `resume` bricks long AND closes above the trend's swing high (its last brick's top) signals; the stop is one
 * brick below the pullback's low. SELL is the mirror (stop one brick above the pullback's high). Fires once per pattern.
 */
function backSignals(columns: PnfColumn[], bars: Bar[], reference: (number | null)[], box: number,
  p: { trend: number; pull: number; resume: number; buy: PnfSignal['kind']; sell: PnfSignal['kind'] }): PnfSignal[] {
  const out: PnfSignal[] = [];
  const runs: { dir: 'X' | 'O'; first: number; last: number }[] = [];
  columns.forEach((c, i) => {
    const r = runs[runs.length - 1];
    if (r && r.dir === c.dir) r.last = i; else runs.push({ dir: c.dir, first: i, last: i });
  });
  for (let k = 2; k < runs.length; k++) {
    const resume = runs[k], pull = runs[k - 1], trendRun = runs[k - 2];
    if (resume.dir !== trendRun.dir || pull.dir === resume.dir) continue;
    if (pull.last - pull.first + 1 !== p.pull) continue;
    if (trendRun.last - trendRun.first + 1 < p.trend) continue;
    const up = resume.dir === 'X';
    const swing = up ? columns[trendRun.last].high : columns[trendRun.last].low;
    for (let i = resume.first + p.resume - 1; i <= resume.last; i++) {
      const c = columns[i];
      if (up ? c.high <= swing : c.low >= swing) continue;
      const pullEdge = up ? Math.min(...columns.slice(pull.first, pull.last + 1).map(x => x.low)) : Math.max(...columns.slice(pull.first, pull.last + 1).map(x => x.high));
      const kind = up ? p.buy : p.sell;
      const price = brickClose(c);
      const v = reference[c.startBar];
      out.push({ id: `${kind}:${i}`, kind, col: i, bar: c.startBar, t: bars[c.startBar].t, price, belowVwap: v != null && price < v, stop: up ? pullEdge - box : pullEdge + box });
      break;
    }
  }
  return out;
}

/** Two-back: >=`trend` (3) bricks, a two-brick pullback, >=3 resuming bricks past the swing. */
export function twoBackSignals(columns: PnfColumn[], bars: Bar[], reference: (number | null)[], box: number, trend = 3): PnfSignal[] {
  const need = Math.max(1, Math.floor(trend));
  return backSignals(columns, bars, reference, box, { trend: need, pull: 2, resume: need, buy: 'TWOBACK_BUY', sell: 'TWOBACK_SELL' });
}

/** One-back: >=2 bricks, a ONE-brick pullback, then 2 resuming bricks that break the swing (a swing breakout). */
export function oneBackSignals(columns: PnfColumn[], bars: Bar[], reference: (number | null)[], box: number): PnfSignal[] {
  return backSignals(columns, bars, reference, box, { trend: 2, pull: 1, resume: 2, buy: 'ONEBACK_BUY', sell: 'ONEBACK_SELL' });
}

/**
 * Trend (state-based N-brick): a signal on EVERY brick that is the latest of `n` consecutive same-colour bricks, with no reversal
 * needed first. With the chart already in a run, the next brick of that run signals; a reversal brick signals too (n = 1), which is
 * the flip after an exit. AUTO still enters only on a brick that formed on the newest closed bar. Not drawn as chart markers.
 */
export function trendSignals(columns: PnfColumn[], bars: Bar[], reference: (number | null)[], n: number): PnfSignal[] {
  const need = Math.max(1, Math.floor(n));
  const out: PnfSignal[] = [];
  let run = 0;
  columns.forEach((c, col) => {
    run = columns[col - 1] && columns[col - 1].dir === c.dir ? run + 1 : 1;
    if (run < need) return;
    const kind = c.dir === 'X' ? 'RENKO_BUY' : 'RENKO_SELL';
    const price = brickClose(c);
    const v = reference[c.startBar];
    out.push({ id: `TREND_${kind}:${col}`, kind, col, bar: c.startBar, t: bars[c.startBar].t, price, belowVwap: v != null && price < v });
  });
  return out;
}

/** SMA of brick closes, read at each brick (null until `period` bricks exist) — TradingView's moving average on a Renko chart. */
export function renkoSma(columns: PnfColumn[], period: number): (number | null)[] {
  let sum = 0;
  return columns.map((c, j) => {
    sum += brickClose(c);
    if (j >= period) sum -= brickClose(columns[j - period]);
    return j + 1 >= period ? sum / period : null;
  });
}

export type RenkoSupertrendPoint = { line: number | null; dir: 1 | -1 | null };

/**
 * Supertrend(period, mult) on the bricks, as TradingView draws it on a Renko chart: each brick is a bar (high / low = its edges,
 * close = brickClose), so the ATR is one box on a run and two at a reversal. Read at each brick; null until `period` + 1 bricks exist.
 */
export function renkoSupertrend(columns: PnfColumn[], period: number, mult: number): RenkoSupertrendPoint[] {
  return supertrendSeries(columns.map(c => ({ high: c.high, low: c.low, close: brickClose(c) })), period, mult);
}

/** The SMA of brick closes as it stood at each chart bar (a signal is compared with bricks printed up to its own bar only). */
export function renkoSmaByBar(columns: PnfColumn[], period: number, nBars: number): (number | null)[] {
  const sma = renkoSma(columns, period);
  const out: (number | null)[] = new Array(nBars).fill(null);
  let j = 0;
  let cur: number | null = null;
  for (let i = 0; i < nBars; i++) {
    while (j < columns.length && columns[j].startBar <= i) { cur = sma[j]; j++; }
    out[i] = cur;
  }
  return out;
}
