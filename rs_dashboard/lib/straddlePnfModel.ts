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
  /** Time of the last closed bar the model was built from; the page's alert watermark follows it. */
  lastBarT: number | null;
  /** First usable close of the most recent session in the bars: the "open" the header's change is measured against. */
  sessionOpen: number | null;
};

export const SMA_PERIOD = 10;

function sessionOpenOf(bars: Bar[]): number | null {
  if (!bars.length) return null;
  const session = sessionOf(bars[bars.length - 1].t);
  const first = bars.find(b => b.straddle > 0 && sessionOf(b.t) === session);
  return first ? first.straddle : null;
}

export type PanelOptions = {
  /** Minutes per chart bar (default 1). */
  interval?: number;
  /** Box size as a percentage of the first price (default 0.5). */
  boxPct?: number;
};

export function buildPanelModel(closedBars: Bar[], overlay: Overlay, opts: PanelOptions = {}): PanelModel {
  const interval = opts.interval ?? 1;
  const boxPct = (opts.boxPct ?? 0.5) / 100;
  // VWAP is always computed on the 1-minute bars (signals' belowVwap and the exit cue need it whichever line is drawn) and read
  // at each chart bar's last minute, so it does not drift with the interval.
  const vw1 = vwap(closedBars);
  const { bars, endIdx } = resample(closedBars, interval);
  const vw = endIdx.map(i => vw1[i]);
  const firstPrice = closedBars.find(b => b.straddle > 0)?.straddle; // the grid is anchored on the first 1-minute price whatever the interval
  const { anchor, box, columns } = buildPnf(bars, boxPct, 3, firstPrice);
  const line = overlay === 'vwap' ? vw : sma(bars.map(b => b.straddle), SMA_PERIOD);
  return {
    box,
    anchor,
    columns,
    signals: detectSignals(columns, bars, vw),
    exits: exitTags(columns, bars, vw),
    overlay: columns.map(c => line[c.endBar]),
    lastBarT: bars.length ? bars[bars.length - 1].t : null,
    sessionOpen: sessionOpenOf(bars),
  };
}
