// One chart panel's data: P&F columns, signals, exit cues and the overlay line, from CLOSED 1-min bars only
// (a bar still forming must never feed a signal, or the marker would repaint). The 1-min bars are grouped into the chosen
// interval first; the box size is a percentage of the first price.
import { buildPnf, detectSignals, exitTags, sessionOf, vwap, type Bar, type PnfColumn, type PnfSignal } from './straddlePnf.ts';
import { resample } from './straddlePnfInterval.ts';
import { MIN_BOX_PCT, type BoxMode } from './straddlePnfSettings.ts';

export type Overlay = 'vwap' | 'sma';

export type PanelModel = {
  box: number;
  /** The price the grid is anchored on: the first usable close (box in %), or that price rounded to a whole box (box in points). */
  anchor: number;
  /** How the box was set, and for points whether it was raised to the MIN_BOX_PCT floor (a smaller box would draw a vast chart). */
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
  live.forEach((lc, col) => {
    const c = confirmed[col];
    const ks = Array.from({ length: lc.boxes }, (_, k) => k).filter(k => {
      if (!c || c.dir !== lc.dir) return true;
      const p = lc.low + (k + 0.5) * box;
      return p < c.low || p > c.high;
    });
    if (ks.length) out.push({ col, ks });
  });
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

function sessionOpenOf(bars: Bar[]): number | null {
  if (!bars.length) return null;
  const session = sessionOf(bars[bars.length - 1].t);
  const first = bars.find(b => b.straddle > 0 && sessionOf(b.t) === session);
  return first ? first.straddle : null;
}

function prevCloseOf(bars: Bar[]): number | null {
  if (!bars.length) return null;
  const session = sessionOf(bars[bars.length - 1].t);
  for (let i = bars.length - 1; i >= 0; i--) {
    if (bars[i].straddle > 0 && sessionOf(bars[i].t) !== session) return bars[i].straddle;
  }
  return null;
}

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
   * The 1-min bar still forming, left out of the chart. It still decides which session is "today" for the header's open and
   * previous close: without it the first minute of a session would measure the change against the close two sessions back.
   */
  forming?: Bar;
};

export function buildPanelModel(closedBars: Bar[], overlay: Overlay, opts: PanelOptions = {}): PanelModel {
  const interval = opts.interval ?? 1;
  const boxPct = (opts.boxPct ?? 0.5) / 100;
  // VWAP is computed on the 1-minute bars (signals' belowVwap and the exit cue need it whichever line is drawn) and read at each
  // chart bar's last minute, so it does not drift with the interval. Without traded volume the box SMA stands in for it (below).
  const vw1 = vwap(closedBars);
  const { bars, endIdx } = resample(closedBars, interval, opts.sessionCloseMin);
  const vw = endIdx.map(i => vw1[i]);
  const firstPrice = closedBars.find(b => b.straddle > 0)?.straddle; // the grid is anchored on the first 1-minute price whatever the interval
  // Box in points: never below MIN_BOX_PCT of the price (0.05 points on NIFTY would be ~460 boxes per 1% move), and the grid is
  // anchored on a whole multiple of the box so the rows land on round prices (a 50-point box: ... 22,950, 23,000 ...).
  const ptsAsked = opts.boxMode === 'pts' && (opts.boxPts ?? 0) > 0 ? (opts.boxPts as number) : null;
  const minBox = firstPrice ? (firstPrice * MIN_BOX_PCT) / 100 : 0;
  const boxSize = ptsAsked !== null && firstPrice ? Math.max(ptsAsked, minBox) : undefined;
  const boxClamped = ptsAsked !== null && !!firstPrice && ptsAsked < minBox;
  const anchorPrice = boxSize && firstPrice ? Math.round(firstPrice / boxSize) * boxSize || firstPrice : firstPrice;
  const { anchor, box, columns } = buildPnf(bars, boxPct, opts.reversal ?? 3, anchorPrice, boxSize);
  const smaPeriod = opts.smaPeriod ?? SMA_PERIOD;
  const boxSma = boxSmaOf(columns, box, smaPeriod);
  const vwapAvailable = opts.volume !== false && closedBars.some(b => b.vol > 0);
  const overlayKind: Overlay = vwapAvailable ? overlay : 'sma';
  // The reference the short-entry zone (below it) and the cover cue (above it) are measured against: VWAP when the instrument
  // trades volume, else the box SMA as it stood at each bar.
  const reference = vwapAvailable ? vw : boxSmaByBar(columns, box, smaPeriod, bars.length);
  // VWAP moves every minute, so the header reads the 1-minute series. The SMA is a P&F average: it only moves when a box is drawn.
  const overlayLine = overlayKind === 'vwap' ? columns.map(c => vw[c.endBar]) : boxSma;
  const overlayNow = overlayKind === 'vwap' ? (vw1.length ? vw1[vw1.length - 1] : null) : (boxSma.length ? boxSma[boxSma.length - 1] : null);
  const withForming = opts.forming ? [...closedBars, opts.forming] : closedBars;
  // Same grid and box, with the forming 1-min bar and the unfinished chart bar included. A forming price that would add more
  // than MAX_UNCONFIRMED_BOXES is treated as a bad tick and shows nothing unconfirmed: one wild print must not draw (and lay
  // out) hundreds of thousands of glyphs.
  const live = buildPnf(resample(withForming, interval, opts.sessionCloseMin, true).bars, boxPct, opts.reversal ?? 3, anchorPrice, boxSize).columns;
  const extra = unconfirmedBoxes(columns, live, box).reduce((n, u) => n + u.ks.length, 0);
  const liveColumns = extra > MAX_UNCONFIRMED_BOXES ? columns : live;
  return {
    box,
    anchor,
    boxMode: ptsAsked !== null ? 'pts' : 'pct',
    boxClamped,
    columns,
    signals: detectSignals(columns, bars, reference),
    exits: exitTags(columns, bars, reference),
    overlay: overlayLine,
    overlayNow,
    vwapAvailable,
    overlayKind,
    smaPeriod,
    lastBarT: bars.length ? bars[bars.length - 1].t : null,
    sessionOpen: sessionOpenOf(withForming),
    prevClose: prevCloseOf(withForming),
    sessionMarks: sessionMarksOf(columns, bars),
    columnTimes: columns.map(c => ({ start: bars[c.startBar].t, end: bars[c.endBar].t })),
    sessions: [...new Set(withForming.map(b => sessionOf(b.t)))],
    liveColumns,
  };
}
