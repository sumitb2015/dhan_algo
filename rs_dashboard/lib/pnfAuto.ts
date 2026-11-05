// AUTO trading rules for one Point & Figure chart. Pure: no clock, no fetch, no React — the time is passed in.
//
//   SELL on a double-bottom SELL, BUY on a double-top BUY; exit on the first column reversal after the entry (an X column
//   for a short, an O column for a long); flat at the end-of-day cutoff. One position per chart.
//
// Everything is read from the CLOSED-bar model (the page builds it without the forming minute), so a signal or a reversal
// can never repaint. Shared by the live engine (components/straddlePnf/usePnfAuto.ts); spec in strategies/pnf_auto/strategy.md.
import { istMinuteOfDay, sessionWindow, type Market } from './straddlePnfLive.ts';
import { isSellSignal, type PnfColumn, type PnfSignal } from './straddlePnf.ts';
import { isNseTradingDay, istDateIso } from './nseHolidays.ts';
import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';
import type { Target } from './pnfTarget.ts';
import { autoProductOf, type AutoProduct } from './pnfOrderLogic.ts';

export type AutoSide = 'BUY' | 'SELL';

/** NSE: an MIS (intraday) position is flat at 15:15. MCX: measured back from that day's close. */
export const NSE_EOD_EXIT_MIN = 15 * 60 + 15;
/**
 * NSE: an NRML (carry-forward) position squares off at 15:35 (chosen by the user on 2026-11-05). F&O trades to 15:40, so this is inside the
 * session; on a market that closes earlier it is pulled back to NRML_EOD_EXIT_BEFORE_CLOSE minutes before that close, so the exit is
 * never sent into a shut market.
 */
export const NSE_NRML_EOD_EXIT_MIN = 15 * 60 + 35;
export const NRML_EOD_EXIT_BEFORE_CLOSE = 5;
export { autoProductOf, type AutoProduct };
export const AUTO_PRODUCT_LABEL: Record<AutoProduct, string> = { INTRADAY: 'MIS', MARGIN: 'NRML' };
/** NSE: no new entry in the last 10 minutes before the end-of-day exit (15:05). */
export const ENTRY_CUTOFF_BEFORE_EOD = 10;
/** MCX: no new entry in the last 10 minutes before the market's CLOSE (23:45 on a 23:55 close) - the same minute as the end-of-day exit, so a
 *  trade taken in the last minute is squared off at once. Chosen by the user on 2026-11-03 (the exit is 10 minutes before the close). */
export const MCX_ENTRY_CUTOFF_BEFORE_CLOSE = 10;
/**
 * A stock with derivatives in NSE's Closing Auction Session (market 'NSE_CAS', from CAS_START): continuous trading stops at 15:15,
 * so the 15:15 exit would land in the auction (filled at the auction price around 15:35, or refused). It squares off 5 minutes
 * before the continuous session ends instead; entries stop 10 minutes before that exit.
 */
export const CAS_EOD_EXIT_BEFORE_CLOSE = 5;
export const MCX_EOD_EXIT_BEFORE_CLOSE = 10;
/** A signal older than this many seconds at decision time is stale (a reload or a late model): never entered. */
export const MAX_SIGNAL_AGE_S = 180;

export interface AutoModel {
  /** 'renko': each column is one brick, and a brick's price is its close edge (not its centre). Default P&F. */
  chart?: 'pnf' | 'renko';
  /** Box size in price (the grid: box k is centred on anchor + k * box). */
  box: number;
  signals: PnfSignal[];
  columns: PnfColumn[];
  /** Start / end time (epoch s) of each column, by index. */
  columnTimes: { start: number; end: number }[];
  /** Time of the last closed bar the model was built from. */
  lastBarT: number | null;
  /** Renko: the Supertrend at each column (dir 1 = up, -1 = down, null = not readable yet). Read only by a position with `exitBy: 'supertrend'`. */
  supertrend?: { dir: 1 | -1 | null }[];
}

export interface AutoPosition {
  side: AutoSide;
  /** Time of the bar whose signal opened it. */
  entryBarT: number;
  /** Two-back positions: the protective stop. It replaces the first-opposite-brick exit (a two-brick pullback is part of the pattern). */
  stop?: number;
  /**
   * Supertrend-rule positions (saved on the ledger row, so it survives a reload whatever rule the page shows): the exit is the first column
   * after the entry bar whose Supertrend direction is against the position, not the first opposite-colour brick.
   */
  exitBy?: 'supertrend';
}

export type AutoDecision =
  /** `boxPrice`: the confirmed box the signal bar reached (where the trade is booked on paper and drawn on the chart). */
  | { action: 'enter'; side: AutoSide; signal: PnfSignal; boxPrice: number | null }
  /** Reversal: `boxPrice` is the confirmed box the reversal column reached on its first bar. EOD has none (no box event). */
  | { action: 'exit'; reason: 'reversal' | 'eod' | 'stop'; col?: number; boxPrice?: number | null }
  | { action: 'none'; why: string };

/**
 * The market a row's contract trades in. Saved on the row when it opens; an older row without it is read off its contract (the MCX
 * underlyings), never off the chart that happens to be on screen: the end-of-day time of a CRUDEOILM position is MCX's, whatever
 * instrument the user has switched the chart to.
 */
export function rowMarket(row: { market?: Market; target: Pick<Target, 'symbol'> }): Market {
  return row.market ?? (row.target.symbol.toUpperCase() in MCX_LOT_MULTIPLIER ? 'MCX' : 'NSE');
}

/**
 * [open, entry cutoff, EOD exit] in IST minutes of the day for `market` at `t` (null when the market is shut that day). `product`: an NSE
 * NRML position squares off later than an MIS one (NSE_NRML_EOD_EXIT_MIN); MCX is the same for both.
 */
export function autoWindow(market: Market, t: number, product: AutoProduct = 'INTRADAY'): { open: number; entryCutoff: number; eodExit: number } | null {
  // NSE's session window is a clock window: weekends and holidays come from the shared calendar (MCX's own is in sessionWindow).
  if (market !== 'MCX' && !isNseTradingDay(istDateIso(t * 1000))) return null;
  const [open, close] = sessionWindow(market, t);
  if (open >= close) return null;
  if (market !== 'MCX' && product === 'MARGIN') {
    const eodExit = Math.min(NSE_NRML_EOD_EXIT_MIN, close - NRML_EOD_EXIT_BEFORE_CLOSE);
    return { open, entryCutoff: eodExit - ENTRY_CUTOFF_BEFORE_EOD, eodExit };
  }
  if (market !== 'MCX') {
    // CAS stock: its session ends at 15:15 from CAS_START (15:30 before it, when the usual 15:15 exit still applies)
    const eodExit = market === 'NSE_CAS' && close <= NSE_EOD_EXIT_MIN ? close - CAS_EOD_EXIT_BEFORE_CLOSE : NSE_EOD_EXIT_MIN;
    return { open, entryCutoff: eodExit - ENTRY_CUTOFF_BEFORE_EOD, eodExit };
  }
  return { open, entryCutoff: close - MCX_ENTRY_CUTOFF_BEFORE_CLOSE, eodExit: close - MCX_EOD_EXIT_BEFORE_CLOSE };
}

/**
 * The price of the confirmed box column `col` had reached by bar `bar` (an index into the bars the chart was built from): the
 * highest box drawn by then for an X column, the lowest for an O column. Every box records the bar that drew it (`boxBars`),
 * so a box the column only reached later is never used. Null when the column drew nothing by then.
 */
export function boxPriceAt(model: Pick<AutoModel, 'columns' | 'box' | 'chart'>, col: number, bar: number): number | null {
  const c = model.columns[col];
  if (!c || !(model.box > 0)) return null;
  const drawn = c.boxBars.map((b, k) => (b <= bar ? k : -1)).filter(k => k >= 0);
  if (!drawn.length) return null;
  if (model.chart === 'renko') return c.dir === 'X' ? c.high : c.low;     // a brick prints whole, at its close edge
  const k = c.dir === 'X' ? Math.max(...drawn) : Math.min(...drawn);
  return c.low + (k + 0.5) * model.box;                     // glyph k is centred half a box above the column's lower edge
}

/** The first column opposite to `side` that started after the entry bar (the reversal), or -1. */
export function reversalColumn(model: AutoModel, pos: AutoPosition): number {
  const want = pos.side === 'SELL' ? 'X' : 'O';
  const against = pos.side === 'SELL' ? 1 : -1;                  // Supertrend rule: a short exits when the line turns up, a long when it turns down
  for (let i = 0; i < model.columns.length; i++) {
    const start = model.columnTimes[i]?.start;
    if (start === undefined || !(start > pos.entryBarT)) continue;
    if (pos.exitBy === 'supertrend' ? model.supertrend?.[i]?.dir === against : model.columns[i].dir === want) return i;
  }
  return -1;
}

/**
 * What the chart should do now. `watermarkT`: signals at or before it are never entered (it is set to the last closed bar when
 * AUTO is switched on, and to each handled signal's time). `nowS`: the decision time, epoch seconds.
 */
export function decideAuto({ model, position, watermarkT, nowS, market, price = null, product = 'INTRADAY' }: {
  model: AutoModel; position: AutoPosition | null; watermarkT: number; nowS: number; market: Market;
  /** The open position's product (its end-of-day time), else the product a new entry would be sent with (its entry cutoff). */
  product?: AutoProduct;
  /** The chart's live price, for a stop (a position without a stop never reads it). */
  price?: number | null;
}): AutoDecision {
  const win = autoWindow(market, nowS, product);
  const minute = istMinuteOfDay(nowS);
  if (position) {
    if (win && minute >= win.eodExit) return { action: 'exit', reason: 'eod' };
    if (position.stop !== undefined) {
      const hit = price !== null && (position.side === 'BUY' ? price <= position.stop : price >= position.stop);
      // A gap through the stop fills at the price, not the stop (PAPER books boxPrice, so it must not flatter the loss).
      return hit ? { action: 'exit', reason: 'stop', boxPrice: position.side === 'BUY' ? Math.min(price!, position.stop) : Math.max(price!, position.stop) } : { action: 'none', why: 'holding' };
    }
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
  return { action: 'enter', side: isSellSignal(sig.kind) ? 'SELL' : 'BUY', signal: sig, boxPrice: boxPriceAt(model, sig.col, sig.bar) };
}

/**
 * Pyramid (Renko only, opt-in per chart): while a position is open and AUTO armed, add ONE lot when the newest closed bar printed a brick in
 * the position's direction that closes beyond the best brick close reached since the entry (the entry brick's close to start with). A
 * pullback that only re-covers ground never adds; at most one lot per bar however many bricks it printed; a bar older than the newest
 * closed one is never chased (a tab that slept skips those bricks). Capped by `maxLots` (the row's own cap, saved at entry).
 */
export type AddDecision = { add: true; barT: number; box: number } | { add: false; why: string };

export function decideAdd({ model, row, nowS, market, maxLots }: {
  model: AutoModel;
  row: { side: AutoSide; entryBarT: number; entryPrice: number; entryBox?: number; lots: number; adds?: { barT: number }[]; base?: { price: number }; product?: AutoProduct };
  nowS: number; market: Market; maxLots: number;
}): AddDecision {
  if (model.chart !== 'renko') return { add: false, why: 'not a Renko chart' };
  if (!(row.lots < maxLots)) return { add: false, why: 'at max lots' };
  const win = autoWindow(market, nowS, autoProductOf(row.product));
  const minute = istMinuteOfDay(nowS);
  if (!win || minute < win.open || minute >= win.entryCutoff) return { add: false, why: 'outside the entry window' };
  const last = model.lastBarT;
  if (last === null) return { add: false, why: 'no closed bars' };
  if (nowS - last > MAX_SIGNAL_AGE_S) return { add: false, why: 'newest bar too old' };
  if (row.adds?.some(a => a.barT === last)) return { add: false, why: 'already added on this bar' };
  const want = row.side === 'SELL' ? 'O' : 'X';
  const better = (a: number, b: number) => (row.side === 'SELL' ? a < b : a > b);
  // the entry brick; without one, the FIRST tranche's price (entryPrice is the average once lots were added)
  let best = row.entryBox ?? row.base?.price ?? row.entryPrice;
  let reach: number | null = null;                              // the furthest new-best close the newest bar printed
  for (let i = 0; i < model.columns.length; i++) {
    const start = model.columnTimes[i]?.start;
    const c = model.columns[i];
    if (start === undefined || !(start > row.entryBarT) || c.dir !== want) continue;
    const close = c.dir === 'X' ? c.high : c.low;                 // a brick's close edge
    if (start === last) { if (better(close, reach ?? best)) reach = close; }
    else if (start < last && better(close, best)) best = close;
  }
  if (reach === null || !better(reach, best)) return { add: false, why: 'no new best brick on the newest bar' };
  return { add: true, barT: last, box: reach };
}
