// One chart panel's data: P&F columns, signals, exit cues and the overlay line, from CLOSED 1-min bars only
// (a bar still forming must never feed a signal, or the marker would repaint). The 1-min bars are grouped into the chosen
// interval first; the box size is a percentage of the first price.
import { buildPnf, detectSignals, exitTags, extendPnf, sessionOf, vwap, type Bar, type PnfColumn, type PnfResume, type PnfSignal } from './straddlePnf.ts';
import { resample } from './straddlePnfInterval.ts';
import { buildRenko, extendRenko, renkoSignals, renkoSma, renkoSmaByBar, type RenkoResume } from './renko.ts';
import { MIN_BOX_PTS_PCT, type BoxMode } from './straddlePnfSettings.ts';

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
  columns: PnfColumn[];
  signals: PnfSignal[];
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
export function unconfirmedBoxes(confirmed: PnfColumn[], live: PnfColumn[], box: number): { col: number; ks: number[] }[] {
  const out: { col: number; ks: number[] }[] = [];
  // Only the last confirmed column can grow and new ones follow it, so the scan starts there (a chart can hold 100k columns and
  // this runs on every live tick and every crosshair move).
  for (let col = Math.max(0, confirmed.length - 1); col < live.length; col++) {
    const lc = live[col];
    const c = confirmed[col];
    const ks = Array.from({ length: lc.boxes }, (_, k) => k).filter(k => {
      if (!c || c.dir !== lc.dir) return true;
      const p = lc.low + (k + 0.5) * box;
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
  /** Boxes against the column needed to reverse it (default 3). */
  reversal?: number;
  /** Boxes in the SMA overlay (default SMA_PERIOD): it averages P&F box values, not bar closes. */
  smaPeriod?: number;
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
    /** The closed bars' sessions, their last session's open and the close before it, computed once (not per tick). */
    closedSessions: string[]; closedOpen: number | null; closedPrev: number | null;
  };
};

/** Sessions (oldest first), the last session's first usable close, and the last usable close of the session before it (its official close `dc` when known). */
function sessionFacts(bars: Bar[]): { sessions: string[]; open: number | null; prev: number | null } {
  const sessions: string[] = [];
  let lastDay = NaN;
  for (const b of bars) {
    const day = Math.floor((b.t + 19_800) / 86_400);                // one sessionOf (a Date + string) per day, not per bar
    if (day !== lastDay) { sessions.push(sessionOf(b.t)); lastDay = day; }
  }
  if (!bars.length) return { sessions, open: null, prev: null };
  const lastSession = sessions[sessions.length - 1];
  let open: number | null = null, prev: number | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const b = bars[i];
    if (!(b.straddle > 0)) continue;
    if (sessionOf(b.t) === lastSession) open = b.straddle;
    else { prev = b.dc ?? b.straddle; break; }
  }
  return { sessions, open, prev };
}

export function buildConfirmedModel(closedBars: Bar[], overlay: Overlay, opts: PanelOptions = {}): ConfirmedModel {
  const interval = opts.interval ?? 1;
  const boxPct = (opts.boxPct ?? 0.5) / 100;
  const reversal = opts.reversal ?? 3;
  const chart: ChartType = opts.chart ?? 'pnf';
  const renko = chart === 'renko';
  // VWAP is computed on the 1-minute bars (signals' belowVwap and the exit cue need it whichever line is drawn) and read at each
  // chart bar's last minute, so it does not drift with the interval. Without traded volume the box SMA stands in for it (below).
  const vw1 = vwap(closedBars);
  const { bars, endIdx } = resample(closedBars, interval, opts.sessionCloseMin);
  const vw = endIdx.map(i => vw1[i]);
  const firstPrice = (closedBars.find(b => b.straddle > 0 && (opts.anchorT === undefined || b.t >= opts.anchorT)) ?? closedBars.find(b => b.straddle > 0))?.straddle; // the grid is anchored on the first 1-minute price whatever the interval
  // Box in points: never below MIN_BOX_PTS_PCT of the price (a safety floor: 0.001 points on NIFTY would be millions of boxes),
  // and the grid is anchored on a whole multiple of the box so the rows land on round prices (a 50-point box: ... 22,950, 23,000 ...).
  const ptsAsked = opts.boxMode === 'pts' && (opts.boxPts ?? 0) > 0 ? (opts.boxPts as number) : null;
  const minBox = firstPrice ? (firstPrice * MIN_BOX_PTS_PCT) / 100 : 0;
  const boxSize = ptsAsked !== null && firstPrice ? Math.max(ptsAsked, minBox) : undefined;
  const boxClamped = ptsAsked !== null && !!firstPrice && ptsAsked < minBox;
  const anchorPrice = boxSize && firstPrice ? Math.round(firstPrice / boxSize) * boxSize || firstPrice : firstPrice;
  const { anchor, box, columns, resume } = renko ? buildRenko(bars, boxSize ?? (firstPrice ?? 0) * boxPct, anchorPrice) : buildPnf(bars, boxPct, reversal, anchorPrice, boxSize);
  const facts = sessionFacts(closedBars);
  const smaPeriod = opts.smaPeriod ?? SMA_PERIOD;
  // Renko's average is TradingView's: an SMA of brick closes. P&F's averages box values.
  const boxSma = renko ? renkoSma(columns, smaPeriod) : boxSmaOf(columns, box, smaPeriod);
  const vwapAvailable = opts.volume !== false && closedBars.some(b => b.vol > 0);
  const overlayKind: Overlay = vwapAvailable ? overlay : 'sma';
  // The reference the short-entry zone (below it) and the cover cue (above it) are measured against: VWAP when the instrument
  // trades volume, else the box SMA as it stood at each bar.
  const reference = vwapAvailable ? vw : renko ? renkoSmaByBar(columns, smaPeriod, bars.length) : boxSmaByBar(columns, box, smaPeriod, bars.length);
  // VWAP moves every minute, so the header reads the 1-minute series. The SMA is a P&F average: it only moves when a box is drawn.
  const overlayLine = overlayKind === 'vwap' ? columns.map(c => vw[c.endBar]) : boxSma;
  const overlayNow = overlayKind === 'vwap' ? (vw1.length ? vw1[vw1.length - 1] : null) : (boxSma.length ? boxSma[boxSma.length - 1] : null);
  return {
    chart,
    box,
    anchor,
    boxMode: ptsAsked !== null ? 'pts' : 'pct',
    boxClamped,
    columns,
    // Renko: N-brick confirmation (`reversal` holds N); no COVER cue and no session marks (they are P&F devices).
    signals: renko ? renkoSignals(columns, bars, reference, reversal) : detectSignals(columns, bars, reference),
    exits: renko ? [] : exitTags(columns, bars, reference),
    overlay: overlayLine,
    overlayNow,
    vwapAvailable,
    overlayKind,
    smaPeriod,
    lastBarT: bars.length ? bars[bars.length - 1].t : null,
    sessionMarks: renko ? [] : sessionMarksOf(columns, bars),
    columnTimes: columns.map(c => ({ start: bars[c.startBar].t, end: bars[c.endBar].t })),
    build: {
      chart, closedBars, interval, boxPct, reversal, anchorPrice, boxSize, sessionCloseMin: opts.sessionCloseMin,
      resume, lastEnd: endIdx.length ? endIdx[endIdx.length - 1] : -1,
      closedSessions: facts.sessions, closedOpen: facts.open, closedPrev: facts.prev,
    },
  };
}

/**
 * The confirmed model plus what the forming 1-min bar adds: unconfirmed boxes (built on the same grid), today's open / previous
 * close and the session list. A forming price that would add more than MAX_UNCONFIRMED_BOXES is a bad tick: it is rejected from
 * its distance to the last close BEFORE anything is built, so one wild print costs nothing and draws nothing.
 */
export function withLive(c: ConfirmedModel, forming?: Bar): PanelModel {
  const { chart, closedBars, interval, boxPct, reversal, anchorPrice, boxSize, sessionCloseMin, resume, lastEnd } = c.build;
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
    else {                                                         // no usable bar yet: the history is tiny, build it whole
      const liveBars = resample(forming ? [...closedBars, forming] : closedBars, interval, sessionCloseMin, true).bars;
      live = (chart === 'renko' ? buildRenko(liveBars, c.box, anchorPrice) : buildPnf(liveBars, boxPct, reversal, anchorPrice, boxSize)).columns;
    }
    const extra = unconfirmedBoxes(c.columns, live, c.box).reduce((n, u) => n + u.ks.length, 0);
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
