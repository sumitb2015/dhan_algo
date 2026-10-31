// AUTO trading rules for one Point & Figure chart. Pure: no clock, no fetch, no React — the time is passed in.
//
//   SELL on a double-bottom SELL, BUY on a double-top BUY; exit on the first column reversal after the entry (an X column
//   for a short, an O column for a long); flat at the end-of-day cutoff. One position per chart.
//
// Everything is read from the CLOSED-bar model (the page builds it without the forming minute), so a signal or a reversal
// can never repaint. Shared by the live engine (components/straddlePnf/usePnfAuto.ts); spec in strategies/pnf_auto/strategy.md.
import { istMinuteOfDay, sessionWindow, type Market } from './straddlePnfLive.ts';
import type { PnfColumn, PnfSignal } from './straddlePnf.ts';
import { isNseTradingDay, istDateIso } from './nseHolidays.ts';

export type AutoSide = 'BUY' | 'SELL';

/** NSE: no new entry from 15:00, flat at 15:15. MCX: the same, measured back from that day's close. */
export const NSE_ENTRY_CUTOFF_MIN = 15 * 60;
export const NSE_EOD_EXIT_MIN = 15 * 60 + 15;
export const MCX_ENTRY_CUTOFF_BEFORE_CLOSE = 30;
export const MCX_EOD_EXIT_BEFORE_CLOSE = 10;
/** A signal older than this many seconds at decision time is stale (a reload or a late model): never entered. */
export const MAX_SIGNAL_AGE_S = 180;

export interface AutoModel {
  /** Box size in price (the grid: box k is centred on anchor + k * box). */
  box: number;
  signals: PnfSignal[];
  columns: PnfColumn[];
  /** Start / end time (epoch s) of each column, by index. */
  columnTimes: { start: number; end: number }[];
  /** Time of the last closed bar the model was built from. */
  lastBarT: number | null;
}

export interface AutoPosition { side: AutoSide; /** Time of the bar whose signal opened it. */ entryBarT: number }

export type AutoDecision =
  /** `boxPrice`: the confirmed box the signal bar reached (where the trade is booked on paper and drawn on the chart). */
  | { action: 'enter'; side: AutoSide; signal: PnfSignal; boxPrice: number | null }
  /** Reversal: `boxPrice` is the confirmed box the reversal column reached on its first bar. EOD has none (no box event). */
  | { action: 'exit'; reason: 'reversal' | 'eod'; col?: number; boxPrice?: number | null }
  | { action: 'none'; why: string };

/** [entry cutoff, EOD exit] in IST minutes of the day for `market` at `t` (null when the market is shut that day). */
export function autoWindow(market: Market, t: number): { open: number; entryCutoff: number; eodExit: number } | null {
  // NSE's session window is a clock window: weekends and holidays come from the shared calendar (MCX's own is in sessionWindow).
  if (market !== 'MCX' && !isNseTradingDay(istDateIso(t * 1000))) return null;
  const [open, close] = sessionWindow(market, t);
  if (open >= close) return null;
  if (market !== 'MCX') return { open, entryCutoff: NSE_ENTRY_CUTOFF_MIN, eodExit: NSE_EOD_EXIT_MIN };
  return { open, entryCutoff: close - MCX_ENTRY_CUTOFF_BEFORE_CLOSE, eodExit: close - MCX_EOD_EXIT_BEFORE_CLOSE };
}

/**
 * The price of the confirmed box column `col` had reached by bar `bar` (an index into the bars the chart was built from): the
 * highest box drawn by then for an X column, the lowest for an O column. Every box records the bar that drew it (`boxBars`),
 * so a box the column only reached later is never used. Null when the column drew nothing by then.
 */
export function boxPriceAt(model: Pick<AutoModel, 'columns' | 'box'>, col: number, bar: number): number | null {
  const c = model.columns[col];
  if (!c || !(model.box > 0)) return null;
  const drawn = c.boxBars.map((b, k) => (b <= bar ? k : -1)).filter(k => k >= 0);
  if (!drawn.length) return null;
  const k = c.dir === 'X' ? Math.max(...drawn) : Math.min(...drawn);
  return c.low + (k + 0.5) * model.box;                     // glyph k is centred half a box above the column's lower edge
}

/** The first column opposite to `side` that started after the entry bar (the reversal), or -1. */
export function reversalColumn(model: AutoModel, pos: AutoPosition): number {
  const want = pos.side === 'SELL' ? 'X' : 'O';
  for (let i = 0; i < model.columns.length; i++) {
    const start = model.columnTimes[i]?.start;
    if (start !== undefined && start > pos.entryBarT && model.columns[i].dir === want) return i;
  }
  return -1;
}

/**
 * What the chart should do now. `watermarkT`: signals at or before it are never entered (it is set to the last closed bar when
 * AUTO is switched on, and to each handled signal's time). `nowS`: the decision time, epoch seconds.
 */
export function decideAuto({ model, position, watermarkT, nowS, market }: {
  model: AutoModel; position: AutoPosition | null; watermarkT: number; nowS: number; market: Market;
}): AutoDecision {
  const win = autoWindow(market, nowS);
  const minute = istMinuteOfDay(nowS);
  if (position) {
    if (win && minute >= win.eodExit) return { action: 'exit', reason: 'eod' };
    const col = reversalColumn(model, position);
    return col >= 0 ? { action: 'exit', reason: 'reversal', col, boxPrice: boxPriceAt(model, col, model.columns[col].startBar) } : { action: 'none', why: 'holding' };
  }
  if (!win) return { action: 'none', why: 'market closed today' };
  if (minute < win.open) return { action: 'none', why: 'before the open' };
  if (minute >= win.entryCutoff) return { action: 'none', why: 'past the entry cutoff' };
  const last = model.lastBarT;
  if (last === null) return { action: 'none', why: 'no closed bars' };
  // Only a signal on the newest closed bar: one that fired earlier was either already handled or missed (never chased).
  const sig = [...model.signals].reverse().find(s => s.t > watermarkT);
  if (!sig) return { action: 'none', why: 'waiting for a signal' };
  if (sig.t !== last) return { action: 'none', why: 'signal is not on the last closed bar' };
  if (nowS - sig.t > MAX_SIGNAL_AGE_S) return { action: 'none', why: 'signal too old' };
  return { action: 'enter', side: sig.kind === 'DOUBLE_BOTTOM_SELL' ? 'SELL' : 'BUY', signal: sig, boxPrice: boxPriceAt(model, sig.col, sig.bar) };
}
