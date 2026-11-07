// Point & Figure engine for straddle charts. Pure: no I/O, no clocks (time arrives in the bars).
//
// Construction is close-based on 1-min straddle closes (CE + PE), the usual close-only P&F rules. The box is a fixed % of the
// first usable price and the grid is anchored on it: box k is the price label anchor + k*box, and glyph cells are centred on
// their label. An X is plotted for every label the close has reached from below (k = floor(x)), an O for every label it has
// reached from above (k = ceil(x)), with x = (close - anchor) / box. A column reverses only when the close is `reversal` full
// boxes from the column's last label (3 boxes = 1.5% at the default 0.5% box), measured with the rounding of the new
// direction, so a 2.1-box move never reverses. The first column starts once the close is a full box from the anchor
// (X: labels 1..k, O: labels -1..k).

export type Bar = {
  t: number; ce: number; pe: number; straddle: number; vol: number;
  /** Live bars only: the feed's cumulative day volume (CE + PE) at the latest tick, and its value when this bar's volume started counting. */
  cum?: number; cumBase?: number;
  /**
   * A stock session's official close, on that session's last 1-min bar only (the route's `dc`). It is NOT the bar's close: NSE's
   * official close is a 30-minute average, not a trade. Day / week / month buckets close on it (resampleCalendar), and it is the
   * previous close; 1-minute and intraday charts never see it.
   */
  dc?: number;
};

export type PnfColumn = {
  dir: 'X' | 'O';
  /** Bottom and top edge of the column's glyph cells in price (cells are centred on their box label). */
  low: number;
  high: number;
  boxes: number;
  /** Indexes into the `bars` array handed to buildPnf. */
  startBar: number;
  endBar: number;
  /** IST YYYY-MM-DD of the bar that opened the column. */
  session: string;
  /** First bar where this column passed the previous same-direction column's extreme (X above its top, O below its bottom); null if it never did. */
  breakBar: number | null;
  /** For each glyph, bottom to top (k = 0 is the lowest box): the index of the bar that drew it. */
  boxBars: number[];
};

export type PnfSignal = {
  id: string;
  /** DOUBLE_* on a P&F chart, RENKO_* (N-brick confirmation, lib/renko.ts) on a Renko chart. */
  kind: 'DOUBLE_TOP_BUY' | 'DOUBLE_BOTTOM_SELL' | 'RENKO_BUY' | 'RENKO_SELL' | 'TWOBACK_BUY' | 'TWOBACK_SELL' | 'ONEBACK_BUY' | 'ONEBACK_SELL';
  col: number;
  bar: number;
  t: number;
  price: number;
  belowVwap: boolean;
  /** Two-back / one-back signals only: the protective stop, one brick beyond the pullback. */
  stop?: number;
  /** Supertrend-rule signals only: the position that signal opens exits when the Supertrend line flips, not on an opposite brick. */
  exitBy?: 'supertrend';
};

export type PnfExecutionMarker = {
  id: string;
  t: number;
  action: 'BUY' | 'SELL';
  price: number;
  col?: number;
  lots: number;
  mode: 'PAPER' | 'REAL';
  /** REAL: the live price at the click, until the broker reports the traded price. */
  estimate?: boolean;
  /**
   * Drawn on the chart only, never a trade of this instrument: a Renko INDEX chart's arrow for the option trade it sent (at the index price,
   * in the chart's own direction). The option's own marker (at its fill) is what the paper trade book counts.
   */
  axis?: boolean;
};

/** True for a short-entry signal (P&F double bottom or Renko SELL); every consumer maps kinds to a side through this. */
export const isSellSignal = (kind: string) => kind === 'DOUBLE_BOTTOM_SELL' || kind === 'RENKO_SELL' || kind === 'TWOBACK_SELL' || kind === 'ONEBACK_SELL';

const IST_OFFSET_S = 5.5 * 3600;
const EPS = 1e-9;

export function sessionOf(t: number): string {
  return new Date((t + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
}

/** `drawn` maps each box label to the bar that first plotted it. */
type Work = { dir: 'X' | 'O'; lo: number; hi: number; startBar: number; endBar: number; breakBar: number | null; drawn: Map<number, number> };

const drawnRange = (from: number, to: number, bar: number, into = new Map<number, number>()) => {
  for (let k = from; k <= to; k++) if (!into.has(k)) into.set(k, bar);
  return into;
};

/**
 * Where a P&F build stopped, so the chart can be carried on over a few more bars (the bar still forming) without re-reading the
 * whole history: the grid, the first column's starting label and the last three columns (the last is the one that can grow, and a
 * break is measured against the same-direction column two back). `bars` = how many chart bars the build read.
 */
export type PnfResume = { anchor: number; box: number; reversal: number; r0: number; tail: Work[]; bars: number };

const cloneWork = (w: Work): Work => ({ ...w, drawn: new Map(w.drawn) });

/** Feeds bars[i] for i in [from, to) into `work` (P&F close rules; see the file header). `at(i)` returns bar i. */
function runPnf(work: Work[], at: (i: number) => Bar, from: number, to: number, anchor: number, box: number, reversal: number, r0: number) {
  const markBreak = (c: Work, i: number) => {
    if (c.breakBar !== null || work.length < 3) return;
    const prev = work[work.length - 3]; // same direction, two columns back (the last element is `c`)
    if (c.dir === 'X' ? c.hi > prev.hi : c.lo < prev.lo) c.breakBar = i;
  };
  for (let i = from; i < to; i++) {
    const b = at(i);
    if (!(b.straddle > 0)) continue;
    const x = (b.straddle - anchor) / box;
    const up = Math.floor(x + EPS);   // highest label the close has reached from below
    const down = Math.ceil(x - EPS);  // lowest label the close has reached from above
    const cur = work[work.length - 1];
    if (!cur) {
      if (up >= r0 + 1) work.push({ dir: 'X', lo: r0 + 1, hi: up, startBar: i, endBar: i, breakBar: null, drawn: drawnRange(r0 + 1, up, i) });
      else if (down <= r0 - 1) work.push({ dir: 'O', lo: down, hi: r0 - 1, startBar: i, endBar: i, breakBar: null, drawn: drawnRange(down, r0 - 1, i) });
      continue;
    }
    if (cur.dir === 'X') {
      if (up > cur.hi) { drawnRange(cur.hi + 1, up, i, cur.drawn); cur.hi = up; cur.endBar = i; markBreak(cur, i); }
      else if (down <= cur.hi - reversal) {
        work.push({ dir: 'O', lo: down, hi: cur.hi - 1, startBar: i, endBar: i, breakBar: null, drawn: drawnRange(down, cur.hi - 1, i) });
        markBreak(work[work.length - 1], i);
      }
    } else if (down < cur.lo) { drawnRange(down, cur.lo - 1, i, cur.drawn); cur.lo = down; cur.endBar = i; markBreak(cur, i); }
    else if (up >= cur.lo + reversal) {
      work.push({ dir: 'X', lo: cur.lo + 1, hi: up, startBar: i, endBar: i, breakBar: null, drawn: drawnRange(cur.lo + 1, up, i) });
      markBreak(work[work.length - 1], i);
    }
  }
}

const toColumn = (c: Work, anchor: number, box: number, timeOf: (i: number) => number): PnfColumn => ({
  dir: c.dir,
  low: anchor + (c.lo - 0.5) * box,
  high: anchor + (c.hi + 0.5) * box,
  boxes: c.hi - c.lo + 1,
  startBar: c.startBar,
  endBar: c.endBar,
  session: sessionOf(timeOf(c.startBar)),
  breakBar: c.breakBar,
  boxBars: Array.from({ length: c.hi - c.lo + 1 }, (_, k) => c.drawn.get(c.lo + k) as number),
});

/**
 * `anchorPrice` overrides the price the grid and the box are anchored on (default: the first usable close). The page passes the
 * first 1-minute price so that changing the chart interval regroups the bars without moving the grid or resizing the box.
 * `boxSize`, when set, is the box in price points and replaces `boxPct` (the grid is still anchored on `anchorPrice`).
 */
export function buildPnf(bars: Bar[], boxPct = 0.005, reversal = 3, anchorPrice?: number, boxSize?: number): { anchor: number; box: number; columns: PnfColumn[]; resume: PnfResume | null } {
  const first = bars.find(b => b.straddle > 0);
  if (!first) return { anchor: 0, box: 0, columns: [], resume: null };
  const anchor = anchorPrice !== undefined && anchorPrice > 0 ? anchorPrice : first.straddle;
  const box = boxSize !== undefined && boxSize > 0 ? boxSize : anchor * boxPct;
  // The grid is anchored on `anchor`, but the first column starts from the FIRST bar's own label: with a long history the anchor
  // can be a recent price far from the first bar, and a column must not be drawn across that gap (it is 0 when they coincide).
  const r0 = Math.round((first.straddle - anchor) / box);
  const work: Work[] = [];
  runPnf(work, i => bars[i], 0, bars.length, anchor, box, reversal, r0);
  const columns = work.map(c => toColumn(c, anchor, box, i => bars[i].t));
  return { anchor, box, columns, resume: { anchor, box, reversal, r0, tail: work.slice(-3).map(cloneWork), bars: bars.length } };
}

/**
 * The chart `buildPnf` would draw over `bars` + `more`, from the columns and resume state of `buildPnf(bars)`, reading only `more`
 * (bar indexes continue after `bars`). Only the last column can grow and new ones follow it, so the earlier columns are reused as is.
 * The live chart calls this on every tick; rebuilding from the whole history took ~0.4 s on two years of NIFTY minutes.
 */
export function extendPnf(columns: PnfColumn[], resume: PnfResume, more: Bar[]): PnfColumn[] {
  return continuePnf(columns, resume, more).columns;
}

/** extendPnf plus the resume state after `more`, so a build can be carried on step after step (bar replay, closed bars). */
export function continuePnf(columns: PnfColumn[], resume: PnfResume, more: Bar[]): { columns: PnfColumn[]; resume: PnfResume } {
  if (!more.length) return { columns, resume };
  const { anchor, box, reversal, r0, bars: n } = resume;
  const work = resume.tail.map(cloneWork);
  const kept = columns.length - work.length;
  runPnf(work, i => more[i - n], n, n + more.length, anchor, box, reversal, r0);
  const timeOf = (i: number) => (i >= n ? more[i - n].t : NaN);
  // The resumed columns that started inside `bars` keep their own session (their start time is not in `more`).
  const fresh = work.map((c, k) => (c.startBar < n && k < resume.tail.length ? { ...toColumn(c, anchor, box, () => 0), session: columns[kept + k].session } : toColumn(c, anchor, box, timeOf)));
  return { columns: [...columns.slice(0, kept), ...fresh], resume: { anchor, box, reversal, r0, tail: work.slice(-3).map(cloneWork), bars: n + more.length } };
}

export function detectSignals(columns: PnfColumn[], bars: Bar[], vwapSeries: (number | null)[]): PnfSignal[] {
  const out: PnfSignal[] = [];
  columns.forEach((c, col) => {
    if (c.breakBar === null) return;
    const kind = c.dir === 'X' ? 'DOUBLE_TOP_BUY' : 'DOUBLE_BOTTOM_SELL';
    const price = bars[c.breakBar].straddle;
    const v = vwapSeries[c.breakBar];
    out.push({ id: `${kind}:${col}`, kind, col, bar: c.breakBar, t: bars[c.breakBar].t, price, belowVwap: v != null && price < v });
  });
  return out.sort((a, b) => a.bar - b.bar || a.col - b.col);
}

/**
 * Cumulative VWAP of the straddle over the whole loaded range (it does not reset each morning: a point & figure chart has no time
 * axis, and the previous days keep weighting it); cumulative mean while no volume has traded.
 */
export function vwap(bars: Bar[]): (number | null)[] {
  return vwapFrom(bars, 0, VWAP_START).series;
}

/** The running sums behind vwap(), so a longer history can carry the series on instead of re-reading every bar. */
export type VwapState = { sumPV: number; sumV: number; sumP: number; n: number; last: number | null };
export const VWAP_START: VwapState = { sumPV: 0, sumV: 0, sumP: 0, n: 0, last: null };

/** vwap() of bars[from..] continuing from `state` (the sums after bars[0..from)); returns that part of the series and the new sums. */
export function vwapFrom(bars: Bar[], from: number, state: VwapState): { series: (number | null)[]; state: VwapState } {
  let { sumPV, sumV, sumP, n, last } = state;
  const series = new Array<number | null>(Math.max(0, bars.length - from));
  for (let i = from; i < bars.length; i++) {
    const b = bars[i];
    if (b.straddle > 0) {
      sumPV += b.straddle * b.vol; sumV += b.vol; sumP += b.straddle; n += 1;
      last = sumV > 0 ? sumPV / sumV : sumP / n;
    }
    series[i - from] = last;
  }
  return { series, state: { sumPV, sumV, sumP, n, last } };
}

/** For each green X column: the first bar inside it that trades above VWAP (the video's exit cue). */
export function exitTags(columns: PnfColumn[], bars: Bar[], vwapSeries: (number | null)[]): { col: number; bar: number }[] {
  const tags: { col: number; bar: number }[] = [];
  columns.forEach((c, col) => {
    if (c.dir !== 'X') return;
    for (let i = c.startBar; i <= c.endBar; i++) {
      const v = vwapSeries[i];
      if (v != null && bars[i].straddle > v) { tags.push({ col, bar: i }); break; }
    }
  });
  return tags;
}

/**
 * The column a time with no column of its own belongs to: the latest column that had started by `t` (0 before the first). A Renko bar
 * that printed no brick has no column, and a trade marker (a manual / guard exit books the bar before the decision) must sit on the
 * brick it followed, not at column 0 at the far left. Pure.
 */
export function columnAtOrBefore(columnTimes: { start: number; end: number }[], t: number): number {
  let k = 0;
  for (let j = 0; j < columnTimes.length && columnTimes[j].start <= t; j++) k = j;
  return k;
}
