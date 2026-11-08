// One chart panel's data: P&F columns, signals, exit cues and the overlay line, from CLOSED 1-min bars only
// (a bar still forming must never feed a signal, or the marker would repaint). The 1-min bars are grouped into the chosen
// interval first; the box size is a percentage of the first price.
import { VWAP_START, buildPnf, continuePnf, detectSignals, exitTags, extendPnf, sessionOf, vwapFrom, type VwapState, type Bar, type PnfColumn, type PnfResume, type PnfSignal } from './straddlePnf.ts';
import { resample } from './straddlePnfInterval.ts';
import { buildRenko, buildLogRenko, logBrickBox, continueRenko, extendRenko, renkoSignals, trendSignals, supertrendSignals, twoBackSignals, oneBackSignals, renkoSmaResume, renkoSmaByBarFrom, renkoSupertrendResume, runStartOf, type RenkoResume, type RenkoSupertrendPoint, type LogGrid } from './renko.ts';
import type { SupertrendState } from './indicators.ts';
import { DEFAULT_BOX_LOG, MIN_BOX_PTS_PCT, type BoxMode } from './straddlePnfSettings.ts';

export type Overlay = 'vwap' | 'sma';
/** Point & Figure, or Renko (lib/renko.ts: one brick per column, the box always in points). */
export type ChartType = 'pnf' | 'renko';

export type PanelModel = {
  chart: ChartType;
  box: number;
  /** The price the grid is anchored on: the first usable close (box in %), or that price rounded to a whole box (box in points). */
  anchor: number;
  /** How the box was set, and for points whether it was raised to the MIN_BOX_PTS_PCT safety floor (a tinier box would draw a vast chart). */
  boxMode: BoxMode;
  boxClamped: boolean;
  /** A % box: the price it is that % of and that price's bar time (see PanelOptions.boxBaseT); null for a box in points. */
  boxBase: number | null;
  boxBaseT: number | null;
  /**
   * Renko Log % (boxMode 'log'): the fixed log grid the bricks sit on, and `box` is then the brick size at the latest close (bricks
   * grow and shrink with price). Count or step bricks with renko.ts gridSteps / gridMove, never with `box`. Null / absent otherwise.
   */
  log?: LogGrid | null;
  columns: PnfColumn[];
  signals: PnfSignal[];
  /** Renko only (empty on P&F): state-based N-brick (every brick completing N same-colour bricks); AUTO's 'N-brick (trend)' rule. */
  trend: PnfSignal[];
  /** Renko only (empty on P&F): BUY on every brick above the Supertrend line, SELL on every brick below it; AUTO's 'Supertrend' rule. */
  stSignals: PnfSignal[];
  /** Renko only (empty on P&F): the two-back pattern signals (lib/renko.ts), which AUTO trades when its rule is 'Two-back'. */
  twoBack: PnfSignal[];
  /** Renko only (empty on P&F): the one-back pattern signals, which AUTO trades when its rule is 'One-back'. */
  oneBack: PnfSignal[];
  exits: { col: number; bar: number }[];
  /** Overlay value at each column: VWAP at its last bar, or the box SMA at its last box (null until `smaPeriod` boxes exist). */
  overlay: (number | null)[];
  /** The overlay's value at the last closed bar (the header's figure); the per-column series lags it while price goes sideways. */
  overlayNow: number | null;
  /**
   * False for an instrument without traded volume (an index; or no bar carried any volume): there is no VWAP, the overlay is the
   * box SMA whatever was asked, and the SMA is also the reference for the short-entry zone and the cover cue.
   */
  vwapAvailable: boolean;
  /** The line actually drawn: 'sma' whenever VWAP is not available. */
  overlayKind: Overlay;
  /** The SMA period the overlay was built with, for its label. */
  smaPeriod: number;
  /**
   * Renko only (empty on P&F): Supertrend(stPeriod, stMult) at each confirmed brick — the line and its direction (1 = up, the line
   * below the bricks; -1 = down, above). Drawn only; no signal or AUTO rule reads it. Null until the ATR has stPeriod + 1 bricks.
   */
  supertrend: RenkoSupertrendPoint[];
  stPeriod: number;
  stMult: number;
  /** Time of the last closed bar the model was built from; the page's alert watermark follows it. */
  lastBarT: number | null;
  /** First usable close of the most recent session in the bars: the "open" the header's change is measured against. */
  sessionOpen: number | null;
  /** Last close of the session before the most recent one in the bars: what the header's % change is measured against. */
  prevClose: number | null;
  /**
   * The first box each session drew, in plotting order (X boxes bottom-up, O boxes top-down): the chart writes the date there
   * instead of an X / O (the classic P&F month marker, by day), so every session that moved the chart is visible even when it
   * opened no column of its own. `k` is the glyph index, bottom to top.
   */
  sessionMarks: { col: number; k: number; session: string }[];
  /** Time of each column's first and last chart bar (epoch seconds), for the crosshair readout. */
  columnTimes: { start: number; end: number }[];
  /** IST dates of every session in the loaded bars, oldest first. */
  sessions: string[];
  /**
   * The chart as it would stand if the bar still forming closed now: `columns` plus the boxes only that bar draws (the last column
   * extended, or new columns after it). The page draws those extra boxes dimmed as unconfirmed; nothing else reads them, so a
   * signal, the SMA or a session mark never comes from a box that can still disappear.
   */
  liveColumns: PnfColumn[];
};

/**
 * The unconfirmed boxes: for each column of `live`, the glyph indexes (bottom to top) the confirmed chart does not have. P&F only
 * ever extends its last column or adds columns, so earlier columns match and give nothing.
 */
export function unconfirmedBoxes(confirmed: PnfColumn[], live: PnfColumn[], box: number, brickMid = false): { col: number; ks: number[] }[] {
  const out: { col: number; ks: number[] }[] = [];
  // Only the last confirmed column can grow and new ones follow it, so the scan starts there (a chart can hold 100k columns and
  // this runs on every live tick and every crosshair move).
  for (let col = Math.max(0, confirmed.length - 1); col < live.length; col++) {
    const lc = live[col];
    const c = confirmed[col];
    const ks = Array.from({ length: lc.boxes }, (_, k) => k).filter(k => {
      if (!c || c.dir !== lc.dir) return true;
      // a Renko brick is one box: test its middle (on a Log % chart its size is not `box`)
      const p = brickMid ? (lc.low + lc.high) / 2 : lc.low + (k + 0.5) * box;
      return p < c.low || p > c.high;
    });
    if (ks.length) out.push({ col, ks });
  }
  return out;
}

/**
 * The P&F moving average: an SMA of the BOX values, not of the bars' closing prices. Every X / O box is one data point (its box
 * price), taken in the order the chart drew them (X columns bottom-up, O columns top-down), so time plays no part: a quiet hour
 * adds nothing and a fast move adds one point per box. Each column reads the average at its last box; null until `period` boxes
 * exist. It can look very different from a candle chart's SMA of the same period.
 */
export function boxSmaOf(columns: PnfColumn[], box: number, period: number): (number | null)[] {
  const values: number[] = [];
  return columns.map(c => {
    const prices = Array.from({ length: c.boxes }, (_, k) => c.low + (k + 0.5) * box);   // bottom to top
    values.push(...(c.dir === 'X' ? prices : prices.reverse()));
    return values.length >= period ? values.slice(-period).reduce((s, v) => s + v, 0) / period : null;
  });
}

/**
 * The box SMA as it stood at each chart bar: every box counts from the bar that drew it, so a signal is compared with the average
 * of the boxes drawn up to and including its own break, never with boxes drawn later. Boxes are taken in drawing order, which is
 * also bar order. Null until `period` boxes exist.
 */
export function boxSmaByBar(columns: PnfColumn[], box: number, period: number, nBars: number): (number | null)[] {
  const drawn: { bar: number; price: number }[] = [];
  for (const c of columns) {
    const order = c.boxBars.map((bar, k) => ({ bar, price: c.low + (k + 0.5) * box }));
    drawn.push(...(c.dir === 'X' ? order : order.reverse()));
  }
  const out: (number | null)[] = new Array(nBars).fill(null);
  let next = 0, sum = 0;
  const window: number[] = [];
  for (let i = 0; i < nBars; i++) {
    while (next < drawn.length && drawn[next].bar <= i) {
      window.push(drawn[next].price); sum += drawn[next].price; next++;
      if (window.length > period) sum -= window.shift() as number;
    }
    out[i] = window.length >= period ? sum / period : null;
  }
  return out;
}

function sessionMarksOf(columns: PnfColumn[], bars: Bar[]): PanelModel['sessionMarks'] {
  const marks: PanelModel['sessionMarks'] = [];
  let last: string | null = null;
  columns.forEach((c, col) => {
    const order = c.boxBars.map((bar, k) => ({ bar, k }));
    if (c.dir === 'O') order.reverse();                       // O boxes are drawn top-down
    for (const { bar, k } of order) {
      const session = sessionOf(bars[bar].t);
      if (session !== last) { marks.push({ col, k, session }); last = session; }
    }
  });
  return marks;
}

/** Default SMA period, in P&F boxes (the user can change it: PnfSettings.smaPeriod). */
export const SMA_PERIOD = 50;
/** Default Renko Supertrend (TradingView's default is 10, 3). */
export const ST_PERIOD = 10;
export const ST_MULT = 3;
/** More unconfirmed boxes than this from one forming bar is a bad tick, not a move: none are drawn. */
export const MAX_UNCONFIRMED_BOXES = 200;

export type PanelOptions = {
  /** Minutes per chart bar (default 1). */
  interval?: number;
  /** Box size as a percentage of the first price (default 0.5). */
  boxPct?: number;
  /** 'pts' sizes the box in price points (`boxPts`) instead of `boxPct`. */
  boxMode?: BoxMode;
  boxPts?: number;
  /** Renko with boxMode 'log': the Log % brick (default DEFAULT_BOX_LOG). A P&F chart treats 'log' as 'pct'. */
  boxLog?: number;
  /** Boxes against the column needed to reverse it (default 3). */
  reversal?: number;
  /** Boxes in the SMA overlay (default SMA_PERIOD): it averages P&F box values, not bar closes. */
  smaPeriod?: number;
  /** Renko's Supertrend: ATR period in bricks and band multiplier (defaults ST_PERIOD / ST_MULT). */
  stPeriod?: number;
  stMult?: number;
  /**
   * False for an instrument whose feed volume is not traded volume (an index: Dhan reports its constituents' turnover). Then there
   * is no VWAP, and the box SMA takes its place as the line and as the signals' reference. Default true.
   */
  volume?: boolean;
  /** IST minute of the day the session closes (MCX 23:55 does not divide into 3 / 15-minute buckets): see resample. */
  sessionCloseMin?: number;
  /**
   * Epoch of the first bar the box size is measured on. A stock's history starts years back with daily closes at a fraction of today's
   * price; its box is a percentage of the first 1-minute price instead. Default: the first bar.
   */
  anchorT?: number;
  /**
   * A % box is measured on the first usable price of the IST session holding the last bar at or before `boxBaseT` (epoch s), not
   * on the first price of the whole history. That history can start years back (0.1% of NIFTY's first loaded price was a box of a
   * few points with NIFTY near 26,000) or, on an option, at several times today's price (a 24000 CE listed at 999, now 284). The
   * page pins `boxBaseT` per load (its last bar then) and per replay (its start), so the box does not change while a chart runs
   * past midnight or a replay crosses a session. Not set: the first price of the history (anchorT).
   */
  boxBaseT?: number;
  /**
   * The 1-min bar still forming, left out of the chart. It still decides which session is "today" for the header's open and
   * previous close: without it the first minute of a session would measure the change against the close two sessions back.
   */
  forming?: Bar;
  /**
   * 'renko': bricks instead of P&F columns; `reversal` is then the N-brick confirmation. The box is in points or a % of the first
   * 1-minute price like P&F's, and the bricks sit on multiples of it either way.
   */
  chart?: ChartType;
};

/** Everything that depends only on the CLOSED bars: rebuilt when a bar closes (or history reloads), not on every live tick. */
export type ConfirmedModel = Omit<PanelModel, 'liveColumns' | 'sessionOpen' | 'prevClose' | 'sessions'> & {
  /** What withLive needs to build the forming bar's boxes on the same grid. */
  build: {
    chart: ChartType; closedBars: Bar[]; interval: number; boxPct: number; reversal: number; anchorPrice?: number; boxSize?: number; sessionCloseMin?: number;
    /** Where the chart build stopped, and the index in closedBars of the last 1-min bar it read: a tick only feeds what follows. */
    resume: PnfResume | RenkoResume | null; lastEnd: number;
    /** The box asked for in points (null: a % box), for a chart whose box cannot be known before a first bar (withLive). */
    ptsAsked: number | null;
    /** Renko Log %: the brick % (null: not a Log % chart). */
    logAsked: number | null;
    /** The chart bars built from closedBars and, for each, the index of its last 1-min bar (a later build appends to them). */
    chartBars: Bar[]; chartEndIdx: number[];
    /** VWAP of every 1-min bar and its running sums, and VWAP at each chart bar: carried on by a longer history of the same bars. */
    vw1: (number | null)[]; vwapState: VwapState; chartVw: (number | null)[];
    /** The closed bars' sessions, their last session's open and the close before it, computed once (not per tick). */
    closedSessions: string[]; closedOpen: number | null; closedPrev: number | null;
    /** Whether any closed bar traded volume (no VWAP without it). */
    hasVol: boolean;
    /** Renko: what a build that only appended bricks carries on instead of re-reading every brick (null on P&F). */
    renko: RenkoCarry | null;
  };
};

/** The Renko averages' running state and the settings they were built with (any change rebuilds them). */
type RenkoCarry = {
  smaPeriod: number; stPeriod: number; stMult: number; vwapAvailable: boolean; overlayKind: Overlay;
  sma: (number | null)[]; smaSum: number; stState: SupertrendState | null; reference: (number | null)[];
};

/** Signals at or after column `from` replaced by `tail` (each list is in column order). */
function spliceSignals(prev: PnfSignal[], from: number, tail: PnfSignal[]): PnfSignal[] {
  let k = prev.length;
  while (k > 0 && prev[k - 1].col >= from) k--;
  return k === prev.length && !tail.length ? prev : prev.slice(0, k).concat(tail);
}

/** Sessions (oldest first), the last session's first usable close, and the last usable close of the session before it (its official close `dc` when known). */
const dayOf = (t: number) => Math.floor((t + 19_800) / 86_400);     // IST calendar day number

/**
 * Sessions (oldest first), the last session's first usable close, and the last usable close of the session before it (its official
 * close `dc` when known). `prevSessions` = the sessions of bars[0..from) (a shorter history of the same bars): only the rest is read.
 */
function sessionFacts(bars: Bar[], prevSessions: string[] | null = null, from = 0): { sessions: string[]; open: number | null; prev: number | null } {
  const sessions = prevSessions && from > 0 ? prevSessions.slice() : [];
  const start = prevSessions && from > 0 ? from : 0;
  let lastDay = start > 0 ? dayOf(bars[start - 1].t) : NaN;
  for (let i = start; i < bars.length; i++) {
    const day = dayOf(bars[i].t);                                    // one sessionOf (a Date + string) per day, not per bar
    if (day !== lastDay) { sessions.push(sessionOf(bars[i].t)); lastDay = day; }
  }
  if (!bars.length) return { sessions, open: null, prev: null };
  const last = dayOf(bars[bars.length - 1].t);
  let open: number | null = null, prev: number | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (!(b.straddle > 0)) continue;
    if (dayOf(b.t) === last) open = b.straddle;
    else { prev = b.dc ?? b.straddle; break; }
  }
  return { sessions, open, prev };
}

/**
 * `prev`: a model built with the same chart settings on a prefix of `closedBars` (the same bars, then some more: a bar closed, or a
 * replay stepped forward). The chart bars and columns are then carried on over the new bars only, instead of rebuilding years of
 * history (80-150 ms on two years of NIFTY minutes); anything else rebuilds from scratch. The result is identical either way.
 */
/**
 * The first usable bar of the IST session holding the last bar at or before `t`; undefined when no bar is that early or the session
 * has no usable price. A binary search plus that session's bars, not a scan of the whole history (it runs on every build).
 */
function sessionFirstBar(bars: Bar[], t: number): Bar | undefined {
  let lo = 0, hi = bars.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (bars[mid].t <= t) lo = mid + 1; else hi = mid; }
  if (lo === 0) return undefined;
  const day = dayOf(bars[lo - 1].t);
  let i = lo - 1;
  while (i > 0 && dayOf(bars[i - 1].t) === day) i--;
  for (; i < lo; i++) if (bars[i].straddle > 0) return bars[i];
  return undefined;
}

/**
 * The box and the price the grid is anchored on, from the first usable price. Box in points: never below MIN_BOX_PTS_PCT of the
 * price (a safety floor: 0.001 points on NIFTY would be millions of boxes), and the grid sits on a whole multiple of the box so the
 * rows land on round prices (a 50-point box: ... 22,950, 23,000 ...). Box in %: that share of the first price.
 */
function gridFor(firstPrice: number | undefined, ptsAsked: number | null, boxPct: number) {
  const minBox = firstPrice ? (firstPrice * MIN_BOX_PTS_PCT) / 100 : 0;
  const boxSize = ptsAsked !== null && firstPrice ? Math.max(ptsAsked, minBox) : undefined;
  const boxClamped = ptsAsked !== null && !!firstPrice && ptsAsked < minBox;
  const anchorPrice = boxSize && firstPrice ? Math.round(firstPrice / boxSize) * boxSize || firstPrice : firstPrice;
  return { boxSize, boxClamped, anchorPrice, box: boxSize ?? (firstPrice ?? 0) * boxPct };
}

export function buildConfirmedModel(closedBars: Bar[], overlay: Overlay, opts: PanelOptions = {}, prev?: ConfirmedModel | null): ConfirmedModel {
  const interval = opts.interval ?? 1;
  const boxPct = (opts.boxPct ?? 0.5) / 100;
  const reversal = opts.reversal ?? 3;
  const chart: ChartType = opts.chart ?? 'pnf';
  const renko = chart === 'renko';
  // VWAP is computed on the 1-minute bars (signals' belowVwap and the exit cue need it whichever line is drawn) and read at each
  // chart bar's last minute, so it does not drift with the interval. Without traded volume the box SMA stands in for it (below).
  const p = prev?.build;
  const pb = p?.closedBars;
  // `prev` was built on the first pb.length of these very bars: VWAP and the session list carry on from it whatever the settings
  const prefix = !!p && !!pb && pb.length > 0 && pb.length <= closedBars.length && pb[0] === closedBars[0] && pb[pb.length - 1] === closedBars[pb.length - 1];
  let vw1: (number | null)[], vwapState: VwapState;
  if (prefix) {
    const more = vwapFrom(closedBars, pb!.length, p!.vwapState);
    vw1 = more.series.length ? p!.vw1.concat(more.series) : p!.vw1; vwapState = more.state;
  } else ({ series: vw1, state: vwapState } = vwapFrom(closedBars, 0, VWAP_START));
  const firstBar = closedBars.find(b => b.straddle > 0 && (opts.anchorT === undefined || b.t >= opts.anchorT)) ?? closedBars.find(b => b.straddle > 0);
  const firstPrice = firstBar?.straddle; // the grid is anchored on the first 1-minute price whatever the interval
  const ptsAsked = opts.boxMode === 'pts' && (opts.boxPts ?? 0) > 0 ? (opts.boxPts as number) : null;
  // Log % is a Renko brick only; its grid is fixed (base 1), so boxBaseT / anchorT never move it (a Log chart does not repaint)
  const logAsked = renko && opts.boxMode === 'log' ? (opts.boxLog !== undefined && opts.boxLog > 0 ? opts.boxLog : DEFAULT_BOX_LOG) : null;
  const log: LogGrid | null = logAsked !== null ? { base: 1, r: 1 + logAsked / 100 } : null;
  const grid = gridFor(firstPrice, ptsAsked, boxPct);
  const { boxClamped, anchorPrice } = grid;
  let boxSize = grid.boxSize;
  let boxBase: number | null = null, boxBaseT: number | null = null;
  if (ptsAsked === null && logAsked === null && firstPrice) {
    const b = opts.boxBaseT !== undefined ? sessionFirstBar(closedBars, opts.boxBaseT) : undefined;
    if (b) { boxSize = b.straddle * boxPct; boxBase = b.straddle; boxBaseT = b.t; }
    else { boxBase = firstPrice; boxBaseT = firstBar!.t; }
  }
  const reuse = prefix && p!.resume !== null && p!.chart === chart && p!.interval === interval && p!.boxPct === boxPct && p!.reversal === reversal
    && p!.anchorPrice === anchorPrice && p!.boxSize === boxSize && p!.sessionCloseMin === opts.sessionCloseMin && p!.logAsked === logAsked;
  let bars: Bar[], endIdx: number[], anchor: number, box: number, columns: PnfColumn[], resume: PnfResume | RenkoResume | null, vw: (number | null)[];
  if (reuse) {
    // The chart bars after prev's last one start at a bucket boundary (buckets are on the clock), so only they are resampled.
    const from = p!.lastEnd + 1;
    const tail = resample(closedBars.slice(from), interval, opts.sessionCloseMin);
    bars = p!.chartBars.concat(tail.bars);
    endIdx = p!.chartEndIdx.concat(tail.endIdx.map(i => i + from));
    vw = p!.chartVw.concat(tail.endIdx.map(i => vw1[i + from]));
    anchor = prev!.anchor; box = prev!.box;
    const next = renko ? continueRenko(prev!.columns, p!.resume as RenkoResume, tail.bars) : continuePnf(prev!.columns, p!.resume as PnfResume, tail.bars);
    columns = next.columns; resume = next.resume;
    if (log) box = logBrickBox(columns, resume as RenkoResume);
  } else if (log) {
    ({ bars, endIdx } = resample(closedBars, interval, opts.sessionCloseMin));
    ({ anchor, box, columns, resume } = buildLogRenko(bars, logAsked!, log.base));
    vw = endIdx.map(i => vw1[i]);
  } else {
    ({ bars, endIdx } = resample(closedBars, interval, opts.sessionCloseMin));
    ({ anchor, box, columns, resume } = renko ? buildRenko(bars, boxSize ?? (firstPrice ?? 0) * boxPct, anchorPrice) : buildPnf(bars, boxPct, reversal, anchorPrice, boxSize));
    vw = endIdx.map(i => vw1[i]);
  }
  const facts = sessionFacts(closedBars, prefix ? p!.closedSessions : null, prefix ? pb!.length : 0);
  // Column times: the engine only ever changes the last few columns, so the earlier ones keep their times
  let keep = 0;
  if (reuse) {
    const pc = prev!.columns;
    keep = Math.max(0, Math.min(pc.length, columns.length) - 4);
    while (keep < pc.length && keep < columns.length && columns[keep] === pc[keep]) keep++;
  }
  const columnTimes = (keep ? prev!.columnTimes.slice(0, keep) : []).concat(columns.slice(keep).map(c => ({ start: bars[c.startBar].t, end: bars[c.endBar].t })));
  const smaPeriod = opts.smaPeriod ?? SMA_PERIOD;
  const stPeriod = opts.stPeriod ?? ST_PERIOD;
  const stMult = opts.stMult ?? ST_MULT;
  // whether any closed bar traded volume: a prefix build already knows it for its bars, so only the new ones are read
  let hasVol = prefix && p!.hasVol;
  for (let i = prefix ? pb!.length : 0; !hasVol && i < closedBars.length; i++) hasVol = closedBars[i].vol > 0;
  const vwapAvailable = opts.volume !== false && hasVol;
  const overlayKind: Overlay = vwapAvailable ? overlay : 'sma';
  const vwapNow = vw1.length ? vw1[vw1.length - 1] : null;
  if (renko) return renkoModel();
  const boxSma = boxSmaOf(columns, box, smaPeriod);
  // The reference the short-entry zone (below it) and the cover cue (above it) are measured against: VWAP when the instrument
  // trades volume, else the box SMA as it stood at each bar.
  const reference = vwapAvailable ? vw : boxSmaByBar(columns, box, smaPeriod, bars.length);
  // VWAP moves every minute, so the header reads the 1-minute series. The SMA is a P&F average: it only moves when a box is drawn.
  const overlayLine = overlayKind === 'vwap' ? columns.map(c => vw[c.endBar]) : boxSma;
  const overlayNow = overlayKind === 'vwap' ? vwapNow : (boxSma.length ? boxSma[boxSma.length - 1] : null);
  return {
    chart,
    box,
    anchor,
    boxMode: ptsAsked !== null ? 'pts' : 'pct',
    boxClamped,
    boxBase,
    boxBaseT,
    log: null,
    columns,
    // Renko: N-brick confirmation (`reversal` holds N); no COVER cue and no session marks (they are P&F devices).
    signals: detectSignals(columns, bars, reference),
    trend: [],
    stSignals: [],
    twoBack: [],
    oneBack: [],
    exits: exitTags(columns, bars, reference),
    overlay: overlayLine,
    overlayNow,
    vwapAvailable,
    overlayKind,
    smaPeriod,
    supertrend: [],
    stPeriod,
    stMult,
    lastBarT: bars.length ? bars[bars.length - 1].t : null,
    sessionMarks: sessionMarksOf(columns, bars),
    columnTimes,
    build: buildState(null),
  };

  function buildState(renkoCarry: RenkoCarry | null): ConfirmedModel['build'] {
    return {
      chart, closedBars, interval, boxPct, reversal, anchorPrice, boxSize, sessionCloseMin: opts.sessionCloseMin,
      resume, lastEnd: endIdx.length ? endIdx[endIdx.length - 1] : -1, chartBars: bars, chartEndIdx: endIdx, ptsAsked, logAsked, vw1, vwapState, chartVw: vw,
      closedSessions: facts.sessions, closedOpen: facts.open, closedPrev: facts.prev, hasVol, renko: renkoCarry,
    };
  }

  /**
   * Renko only ever appends bricks, so after a build that carried prev's bricks on, every brick before prev's last run is final, and
   * so is everything read from it: the SMA and Supertrend (carried on from their running state), the reference by bar, and every
   * signal before that run. Only that run and the new bricks are read again (a bar close on years of bricks: ~1 ms, not 100-250).
   */
  function renkoModel(): ConfirmedModel {
    const pr = reuse ? p!.renko : null;
    const carry = pr !== null && pr.smaPeriod === smaPeriod && pr.stPeriod === stPeriod && pr.stMult === stMult && pr.vwapAvailable === vwapAvailable
      && keep === prev!.columns.length;
    const pm = carry ? prev! : null;
    // Renko's average is TradingView's: an SMA of brick closes.
    const smaCarry = renkoSmaResume(columns, smaPeriod, pm ? { sma: pr!.sma, sum: pr!.smaSum } : null);
    const st = renkoSupertrendResume(columns, stPeriod, stMult, pm ? { out: pm.supertrend, state: pr!.stState } : null);
    const reference = vwapAvailable ? vw : renkoSmaByBarFrom(columns, smaCarry.sma, bars.length, pm && !vwapAvailable ? pr!.reference : null);
    const overlayLine = overlayKind === 'vwap'
      ? (pm && pr!.overlayKind === 'vwap' ? pm.overlay.concat(columns.slice(pm.overlay.length).map(c => vw[c.endBar])) : columns.map(c => vw[c.endBar]))
      : smaCarry.sma;
    const overlayNow = overlayKind === 'vwap' ? vwapNow : (smaCarry.sma.length ? smaCarry.sma[smaCarry.sma.length - 1] : null);
    // re-read from the first brick of prev's last (still open) run: a signal can only appear there or later
    const from = pm && pm.columns.length ? runStartOf(columns, pm.columns.length - 1) : 0;
    const sig = (old: PnfSignal[] | undefined, read: (from: number) => PnfSignal[]) => (pm && old ? spliceSignals(old, from, read(from)) : read(0));
    return {
      chart,
      box,
      anchor,
      boxMode: log ? 'log' : ptsAsked !== null ? 'pts' : 'pct',
      boxClamped,
      boxBase,
      boxBaseT,
      log,
      columns,
      // N-brick confirmation (`reversal` holds N); no COVER cue and no session marks (they are P&F devices).
      signals: sig(pm?.signals, f => renkoSignals(columns, bars, reference, reversal, f)),
      trend: sig(pm?.trend, f => trendSignals(columns, bars, reference, reversal, f)),
      stSignals: sig(pm?.stSignals, f => supertrendSignals(columns, bars, reference, st.out, f)),
      twoBack: sig(pm?.twoBack, f => twoBackSignals(columns, bars, reference, box, 3, f, log)),
      oneBack: sig(pm?.oneBack, f => oneBackSignals(columns, bars, reference, box, f, log)),
      exits: [],
      overlay: overlayLine,
      overlayNow,
      vwapAvailable,
      overlayKind,
      smaPeriod,
      supertrend: st.out,
      stPeriod,
      stMult,
      lastBarT: bars.length ? bars[bars.length - 1].t : null,
      sessionMarks: [],
      columnTimes,
      build: buildState({ smaPeriod, stPeriod, stMult, vwapAvailable, overlayKind, sma: smaCarry.sma, smaSum: smaCarry.sum, stState: st.state, reference: vwapAvailable ? [] : reference }),
    };
  }
}

/**
 * The confirmed model plus what the forming 1-min bar adds: unconfirmed boxes (built on the same grid), today's open / previous
 * close and the session list. A forming price that would add more than MAX_UNCONFIRMED_BOXES is a bad tick: it is rejected from
 * its distance to the last close BEFORE anything is built, so one wild print costs nothing and draws nothing.
 */
export function withLive(c: ConfirmedModel, forming?: Bar): PanelModel {
  const { chart, closedBars, interval, boxPct, reversal, sessionCloseMin, resume, lastEnd } = c.build;
  const lastClose = closedBars.length ? closedBars[closedBars.length - 1].straddle : null;
  const wild = !!forming && lastClose !== null && c.box > 0 && Math.abs(forming.straddle - lastClose) / c.box > MAX_UNCONFIRMED_BOXES;
  let liveColumns = c.columns;
  // Nothing can be unconfirmed on a 1-minute chart with no forming bar (on a longer interval the unfinished chart bar can be).
  if (!wild && (forming || interval > 1)) {
    // Only the 1-min bars after the confirmed build's last chart bar (a still-open bucket) and the forming bar are new: carry the
    // build on over them instead of rebuilding the whole history on every tick. Buckets are on the clock, so a bucket boundary
    // falls exactly after `lastEnd`.
    const tail = closedBars.slice(lastEnd + 1);
    if (forming) tail.push(forming);
    const more = resample(tail, interval, sessionCloseMin, true).bars;
    let live: PnfColumn[];
    if (resume && chart === 'renko') live = extendRenko(c.columns, resume as RenkoResume, more);
    else if (resume) live = extendPnf(c.columns, resume as PnfResume, more);
    else {
      // No usable closed bar yet (the history is tiny): build it whole, on the grid the first usable price gives (the confirmed
      // build had no price to size the box from, so its box is 0 and its points box unknown).
      const all = forming ? [...closedBars, forming] : closedBars;
      const liveBars = resample(all, interval, sessionCloseMin, true).bars;
      const g = gridFor(all.find(b => b.straddle > 0)?.straddle, c.build.ptsAsked, boxPct);
      const { logAsked } = c.build;
      live = (chart === 'renko' ? (logAsked !== null ? buildLogRenko(liveBars, logAsked) : buildRenko(liveBars, g.box, g.anchorPrice)) : buildPnf(liveBars, boxPct, reversal, g.anchorPrice, g.boxSize)).columns;
    }
    const extra = unconfirmedBoxes(c.columns, live, c.box, chart === 'renko').reduce((n, u) => n + u.ks.length, 0);
    if (extra <= MAX_UNCONFIRMED_BOXES) liveColumns = live;
  }
  // Today's open / previous close / sessions: the closed bars' (computed once) unless the forming bar opens a new session.
  const { closedSessions, closedOpen, closedPrev } = c.build;
  const formingSession = forming ? sessionOf(forming.t) : null;
  const newSession = formingSession !== null && formingSession !== closedSessions[closedSessions.length - 1];
  let lastPositive: Bar | undefined;
  if (newSession) for (let i = closedBars.length - 1; i >= 0 && !lastPositive; i--) if (closedBars[i].straddle > 0) lastPositive = closedBars[i];
  const { build: _build, ...confirmed } = c;
  void _build;
  return {
    ...confirmed,
    sessionOpen: newSession ? (forming!.straddle > 0 ? forming!.straddle : null) : closedOpen ?? (forming && forming.straddle > 0 ? forming.straddle : null),
    prevClose: newSession ? (lastPositive ? lastPositive.dc ?? lastPositive.straddle : null) : closedPrev,
    sessions: newSession ? [...closedSessions, formingSession!] : closedSessions,
    liveColumns,
  };
}

export function buildPanelModel(closedBars: Bar[], overlay: Overlay, opts: PanelOptions = {}): PanelModel {
  return withLive(buildConfirmedModel(closedBars, overlay, opts), opts.forming);
}
