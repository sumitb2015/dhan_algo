// One chart panel's data: P&F columns, signals, exit cues and the overlay line, from CLOSED 1-min bars only
// (a bar still forming must never feed a signal, or the marker would repaint).
import { buildPnf, detectSignals, exitTags, sessionOf, sma, vwap, type Bar, type PnfColumn, type PnfSignal } from './straddlePnf.ts';

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
  /** IST session of the bar each overlay value is read from (a column's last bar). The line is split on this, not on the session the column opened in. */
  overlaySession: string[];
  /** Time of the last closed bar the model was built from; the page's alert watermark follows it. */
  lastBarT: number | null;
};

export const SMA_PERIOD = 10;

export function buildPanelModel(closedBars: Bar[], overlay: Overlay): PanelModel {
  const { anchor, box, columns } = buildPnf(closedBars);
  const vw = vwap(closedBars); // always computed: signals' belowVwap and the exit cue need it whichever line is drawn
  const line = overlay === 'vwap' ? vw : sma(closedBars.map(b => b.straddle), SMA_PERIOD);
  return {
    box,
    anchor,
    columns,
    signals: detectSignals(columns, closedBars, vw),
    exits: exitTags(columns, closedBars, vw),
    overlay: columns.map(c => line[c.endBar]),
    overlaySession: columns.map(c => sessionOf(closedBars[c.endBar].t)),
    lastBarT: closedBars.length ? closedBars[closedBars.length - 1].t : null,
  };
}
