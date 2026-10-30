// One chart panel's data: P&F columns, signals, exit cues and the overlay line, from CLOSED 1-min bars only
// (a bar still forming must never feed a signal, or the marker would repaint). The 1-min bars are grouped into the chosen
// interval first; the box size is a percentage of the first price.
import { buildPnf, detectSignals, exitTags, sessionOf, sma, vwap, type Bar, type PnfColumn, type PnfSignal } from './straddlePnf.ts';
import { resample } from './straddlePnfInterval.ts';

export type Overlay = 'vwap' | 'sma';

export type PanelModel = {
  box: number;
  /** The price the box percentage was taken from (first usable close of the loaded history). */
  anchor: number;
  columns: PnfColumn[];
  signals: PnfSignal[];
  exits: { col: number; bar: number }[];
  /** Overlay value (VWAP or SMA10) at each column's last bar; null while the SMA has fewer than 10 bars. */
  overlay: (number | null)[];
  /** The overlay's value at the last closed bar (the header's figure); the per-column series lags it while price goes sideways. */
  overlayNow: number | null;
  /** No bar carried volume (an index): the "VWAP" is then a plain cumulative average and is labelled so. */
  vwapIsAverage: boolean;
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
};

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

export const SMA_PERIOD = 10;

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
  /** Boxes against the column needed to reverse it (default 3). */
  reversal?: number;
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
  // VWAP is always computed on the 1-minute bars (signals' belowVwap and the exit cue need it whichever line is drawn) and read
  // at each chart bar's last minute, so it does not drift with the interval.
  const vw1 = vwap(closedBars);
  const { bars, endIdx } = resample(closedBars, interval, opts.sessionCloseMin);
  const vw = endIdx.map(i => vw1[i]);
  const firstPrice = closedBars.find(b => b.straddle > 0)?.straddle; // the grid is anchored on the first 1-minute price whatever the interval
  const { anchor, box, columns } = buildPnf(bars, boxPct, opts.reversal ?? 3, firstPrice);
  const line = overlay === 'vwap' ? vw : sma(bars.map(b => b.straddle), SMA_PERIOD);
  // VWAP moves every minute, so the header reads the 1-minute series; the SMA is a per-chart-bar series.
  const nowSeries = overlay === 'vwap' ? vw1 : line;
  const withForming = opts.forming ? [...closedBars, opts.forming] : closedBars;
  return {
    box,
    anchor,
    columns,
    signals: detectSignals(columns, bars, vw),
    exits: exitTags(columns, bars, vw),
    overlay: columns.map(c => line[c.endBar]),
    overlayNow: nowSeries.length ? nowSeries[nowSeries.length - 1] : null,
    vwapIsAverage: !closedBars.some(b => b.vol > 0),
    lastBarT: bars.length ? bars[bars.length - 1].t : null,
    sessionOpen: sessionOpenOf(withForming),
    prevClose: prevCloseOf(withForming),
    sessionMarks: sessionMarksOf(columns, bars),
    columnTimes: columns.map(c => ({ start: bars[c.startBar].t, end: bars[c.endBar].t })),
    sessions: [...new Set(withForming.map(b => sessionOf(b.t)))],
  };
}
