// AUTO trading rules for one Point & Figure chart. Pure: no clock, no fetch, no React — the time is passed in.
//
//   SELL on a double-bottom SELL, BUY on a double-top BUY; exit on the first column reversal after the entry (an X column
//   for a short, an O column for a long); flat at the end-of-day cutoff. One position per chart.
//
// Everything is read from the CLOSED-bar model (the page builds it without the forming minute), so a signal or a reversal
// can never repaint. Shared by the live engine (components/straddlePnf/usePnfAuto.ts); spec in strategies/pnf_auto/strategy.md.
import { istMinuteOfDay, sessionWindow, type Market } from './straddlePnfLive.ts';
import { isSellSignal, type PnfColumn, type PnfSignal } from './straddlePnf.ts';
import { isNseSessionDay, istDateIso } from './nseHolidays.ts';
import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';
import type { Target } from './pnfTarget.ts';
import { autoProductOf, type AutoProduct } from './pnfOrderLogic.ts';
import { gridMove, gridSteps, type LogGrid } from './renko.ts';

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
/** NSE: no separate entry cutoff - entries run until the end-of-day exit minute itself (was 10 minutes before it, removed 2026-11-08). */
export const ENTRY_CUTOFF_BEFORE_EOD = 0;
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
  /** Box size in price (the grid: box k is centred on anchor + k * box). On a Renko Log % chart: the brick size at the latest close. */
  box: number;
  /** Renko Log %: the log grid; bricks are then counted in log steps (renko.ts gridSteps / gridMove), not in `box`. */
  log?: LogGrid | null;
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
  /**
   * Renko pyramid trailing SL (the row's `trailBoxes`, active once a lot was added): exit on the first closed brick after the first add's bar
   * (`fromBarT`) that closes `boxes` boxes back from the best brick close since entry (`start` = the entry brick). Checked before the
   * two-back stop and the reversal / Supertrend exit, so a big pyramided position does not wait for the Supertrend to turn.
   */
  trail?: { boxes: number; fromBarT: number; start: number };
}

export type AutoDecision =
  /** `boxPrice`: the confirmed box the signal bar reached (where the trade is booked on paper and drawn on the chart). */
  | { action: 'enter'; side: AutoSide; signal: PnfSignal; boxPrice: number | null }
  /** Reversal: `boxPrice` is the confirmed box the reversal column reached on its first bar. EOD has none (no box event). */
  | { action: 'exit'; reason: 'reversal' | 'eod' | 'stop' | 'trail'; col?: number; boxPrice?: number | null }
  | { action: 'none'; why: string };

/**
 * An NRML (carry-forward) position in a NIFTY option is held overnight: AUTO sends no end-of-day exit for it (chosen by the user on
 * 2026-11-09). Its rule exits, stop, trail and the server's MTM guard still run, on the following days too. MIS keeps the 15:15 exit
 * (the broker squares MIS off itself); futures, other underlyings and stocks keep theirs. The contract is the one the row HOLDS: an
 * index chart's row trades an option (`traded`). On the option's expiry day (`nowS`, IST) the NRML 15:35 exit applies again: a contract
 * is never carried past its expiry.
 */
export function carriesOvernight(row: { product?: AutoProduct; target: Target; traded?: { target: Target } }, nowS: number): boolean {
  if (autoProductOf(row.product) !== 'MARGIN') return false;
  const held = row.traded?.target ?? row.target;
  if (held.kind !== 'options' || held.symbol.toUpperCase() !== 'NIFTY') return false;
  return !held.expiry || held.expiry > istDateIso(nowS * 1000);
}

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
  if (market !== 'MCX' && !isNseSessionDay(istDateIso(t * 1000))) return null;
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

/** The best favourable brick close since entry (the trailing SL's reference), or null. Saved on the row at a trail exit. */
export function trailBest(model: AutoModel, pos: AutoPosition): number | null {
  if (!pos.trail || model.chart !== 'renko' || !(model.box > 0)) return null;
  return walkTrail(model, pos).best;
}

/**
 * Trailing SL limits (boxes back from the best brick). The minimum is 2: the first opposite brick already closes 2 boxes below the best
 * close (a Renko reversal needs a 2-box move), so 1 box was the same as 2. A row saved with 1 still reads (it behaves as 2).
 */
export const TRAIL_BOXES_MIN = 2;
export const TRAIL_BOXES_MAX = 20;

/** The trailing SL of a pyramided row: set once it has `trailBoxes` and at least one add, else undefined. */
export function trailOf(row: { trailBoxes?: number; adds?: { barT: number }[]; entryBox?: number; base?: { price: number }; entryPrice: number }): AutoPosition['trail'] {
  const b = row.trailBoxes;
  if (!(Number.isInteger(b) && b! >= 1 && b! <= TRAIL_BOXES_MAX) || !row.adds?.length) return undefined;
  return { boxes: b!, fromBarT: Math.min(...row.adds.map(a => a.barT)), start: row.entryBox ?? row.base?.price ?? row.entryPrice };
}

/** Walk a Renko position's bricks: the best favourable close so far, and the first trailing-SL brick (-1 = none). */
function walkTrail(model: AutoModel, pos: AutoPosition): { best: number; col: number } {
  const t = pos.trail!;
  const sell = pos.side === 'SELL';
  const want = sell ? 'O' : 'X';
  let best = t.start;
  for (let i = 0; i < model.columns.length; i++) {
    const start = model.columnTimes[i]?.start;
    const c = model.columns[i];
    // the entry bar counts too: a bar prints bricks one way only, so its bricks before the signal never beat the entry brick, and the ones
    // after it (a mid-bar Two-back signal) are the trade's own progress
    if (start === undefined || start < pos.entryBarT) continue;
    const close = c.dir === 'X' ? c.high : c.low;                       // a brick's close edge
    if (c.dir === want) { if (sell ? close < best : close > best) best = close; continue; }
    const back = sell ? gridSteps(model, best, close) : gridSteps(model, close, best);
    if (start > t.fromBarT && back >= t.boxes - 1e-6) return { best, col: i };
  }
  return { best, col: -1 };
}

/** The first closed brick that hits the trailing SL, or -1 (none, no trail, or not a Renko model). */
export function trailExitColumn(model: AutoModel, pos: AutoPosition): number {
  if (!pos.trail || model.chart !== 'renko' || !(model.box > 0)) return -1;
  return walkTrail(model, pos).col;
}

/** The trailing SL level now (best brick close since entry, `boxes` boxes back), or null. For the status line. */
export function trailLevel(model: AutoModel, pos: AutoPosition): number | null {
  if (!pos.trail || model.chart !== 'renko' || !(model.box > 0)) return null;
  const { best } = walkTrail(model, pos);
  return gridMove(model, best, pos.side === 'SELL' ? pos.trail.boxes : -pos.trail.boxes);
}

/**
 * After a trailing-SL exit, no new entry on the SAME side until the trend resumes: a brick in that direction closes beyond the best brick
 * close the trailed trade reached (the Supertrend rule signals on every brick while the line points one way, so without this AUTO bought
 * the very pullback the trail had just exited, 2026-11-05). The opposite side enters as usual.
 */
export type ReentryBlock = { side: AutoSide; beyond: number; afterBarT: number };

/** The block a closed row leaves behind: only a `trail` exit with its exit bar, else undefined. */
export function reentryBlockOf(row: { side: AutoSide; state: string; reason?: string; entryBarT: number; exitBarT?: number; trailBest?: number; entryBox?: number; base?: { price: number }; entryPrice: number },
  model: Pick<AutoModel, 'columns' | 'columnTimes' | 'signals'>): ReentryBlock | undefined {
  if (row.state !== 'closed' || row.reason !== 'trail' || row.exitBarT === undefined) return undefined;
  const sell = row.side === 'SELL';
  // An opposite-side signal since the exit (the trend turned): a later same-side signal starts a NEW trend, not the trailed one's
  // pullback. `model` must carry the rule's signals of BOTH sides (before the Buy only / Sell only filter), or this is never seen.
  const exitBarT = row.exitBarT;
  if (model.signals.some(s => s.t > exitBarT && isSellSignal(s.kind) !== sell)) return undefined;
  if (row.trailBest !== undefined && Number.isFinite(row.trailBest)) return { side: row.side, beyond: row.trailBest, afterBarT: exitBarT };
  const want = sell ? 'O' : 'X';
  let best = row.entryBox ?? row.base?.price ?? row.entryPrice;
  for (let i = 0; i < model.columns.length; i++) {
    const start = model.columnTimes[i]?.start;
    const c = model.columns[i];
    if (start === undefined || start < row.entryBarT || start > exitBarT || c.dir !== want) continue;
    const close = c.dir === 'X' ? c.high : c.low;
    if (sell ? close < best : close > best) best = close;
  }
  return { side: row.side, beyond: best, afterBarT: exitBarT };
}

/** The trend has resumed past the block: a brick after the exit bar, in the blocked direction, closed beyond its best. */
export function reentryLifted(model: Pick<AutoModel, 'columns' | 'columnTimes'>, b: ReentryBlock): boolean {
  const want = b.side === 'SELL' ? 'O' : 'X';
  return model.columns.some((c, i) => {
    const start = model.columnTimes[i]?.start;
    if (start === undefined || !(start > b.afterBarT) || c.dir !== want) return false;
    const close = c.dir === 'X' ? c.high : c.low;
    return b.side === 'SELL' ? close < b.beyond - 1e-9 : close > b.beyond + 1e-9;
  });
}

/**
 * Renko: the first closed brick after the entry bar that closes at or beyond the stop, or -1. The stop is checked against the live price
 * first; this is the backstop for a missing or stale price (a brick only prints from real prices, so it never fires early).
 */
export function stopBrickColumn(model: AutoModel, pos: AutoPosition): number {
  if (pos.stop === undefined || model.chart !== 'renko') return -1;
  for (let i = 0; i < model.columns.length; i++) {
    const start = model.columnTimes[i]?.start;
    const c = model.columns[i];
    if (start === undefined || !(start > pos.entryBarT)) continue;
    const close = c.dir === 'X' ? c.high : c.low;
    if (pos.side === 'BUY' ? c.dir === 'O' && close <= pos.stop + 1e-9 : c.dir === 'X' && close >= pos.stop - 1e-9) return i;
  }
  return -1;
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
export function decideAuto({ model, position, watermarkT, nowS, market, price = null, product = 'INTRADAY', reentryBlock, carry = false }: {
  model: AutoModel; position: AutoPosition | null; watermarkT: number; nowS: number; market: Market;
  /** The open position is carried overnight (carriesOvernight): no end-of-day exit. */
  carry?: boolean;
  /** Left by the chart's last trade if it was exited by the trailing SL (reentryBlockOf): same-side entries wait for a new best brick. */
  reentryBlock?: ReentryBlock;
  /** The open position's product (its end-of-day time), else the product a new entry would be sent with (its entry cutoff). */
  product?: AutoProduct;
  /** The chart's live price, for a stop (a position without a stop never reads it). Pass null when the feed is stale: a Renko stop then
   *  falls back to closed bricks. */
  price?: number | null;
}): AutoDecision {
  const win = autoWindow(market, nowS, product);
  const minute = istMinuteOfDay(nowS);
  if (position) {
    if (win && !carry && minute >= win.eodExit) return { action: 'exit', reason: 'eod' };
    const tc = trailExitColumn(model, position);
    if (tc >= 0) { const c = model.columns[tc]; return { action: 'exit', reason: 'trail', col: tc, boxPrice: c.dir === 'X' ? c.high : c.low }; }
    if (position.stop !== undefined) {
      const hit = price !== null && (position.side === 'BUY' ? price <= position.stop : price >= position.stop);
      // A gap through the stop fills at the price, not the stop (PAPER books boxPrice, so it must not flatter the loss).
      if (hit) return { action: 'exit', reason: 'stop', boxPrice: position.side === 'BUY' ? Math.min(price!, position.stop) : Math.max(price!, position.stop) };
      // No usable live price: a closed brick beyond the stop still exits, booked at that brick's close (never better than the stop).
      const sc = price === null ? stopBrickColumn(model, position) : -1;
      if (sc >= 0) { const c = model.columns[sc]; const close = c.dir === 'X' ? c.high : c.low; return { action: 'exit', reason: 'stop', col: sc, boxPrice: position.side === 'BUY' ? Math.min(close, position.stop) : Math.max(close, position.stop) }; }
      return { action: 'none', why: 'holding' };
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
  if (reentryBlock && (isSellSignal(sig.kind) ? 'SELL' : 'BUY') === reentryBlock.side && !reentryLifted(model, reentryBlock)) {
    return { action: 'none', why: `trail exit: ${reentryBlock.side} waits for a brick beyond ${reentryBlock.beyond.toFixed(2)}` };
  }
  return { action: 'enter', side: isSellSignal(sig.kind) ? 'SELL' : 'BUY', signal: sig, boxPrice: boxPriceAt(model, sig.col, sig.bar) };
}

/**
 * Pyramid (Renko only, opt-in per chart): while a position is open and AUTO armed, add ONE lot when the newest closed bar printed a brick in
 * the position's direction that closes beyond the best brick close reached since the entry (the entry brick's close to start with). A
 * pullback that only re-covers ground never adds; at most one lot per bar however many bricks it printed; a bar older than the newest
 * closed one is never chased (a tab that slept skips those bricks). Capped by `maxLots` (the row's own cap, saved at entry).
 * `row.pyramidEvery` (N, default 1, saved at entry): the new best close must also be at least N boxes beyond the last add's brick (the entry
 * brick before the first add), so a lot is added every N bricks of progress. N = 1 is the original one-lot-per-new-best-brick rule.
 */
/** Pyramid "every N bricks" limits (N = 1: a lot on every new best brick). */
export const PYRAMID_EVERY_MAX = 50;
export const pyramidEveryOf = (n: unknown): number => (Number.isInteger(n) && (n as number) >= 1 && (n as number) <= PYRAMID_EVERY_MAX ? (n as number) : 1);

export type AddDecision = { add: true; barT: number; box: number } | { add: false; why: string };

export function decideAdd({ model, row, nowS, market, maxLots }: {
  model: AutoModel;
  row: { side: AutoSide; entryBarT: number; entryPrice: number; entryBox?: number; lots: number; adds?: { barT: number; box?: number }[]; base?: { price: number }; product?: AutoProduct; pyramidEvery?: number };
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
    if (start === undefined || start < row.entryBarT || c.dir !== want) continue;
    const close = c.dir === 'X' ? c.high : c.low;                 // a brick's close edge
    // the entry bar's bricks after the signal (a mid-bar entry) set the best; no add on the entry bar itself
    if (start === last && start > row.entryBarT) { if (better(close, reach ?? best)) reach = close; }
    else if (start < last || start === row.entryBarT) { if (better(close, best)) best = close; }
  }
  if (reach === null || !better(reach, best)) return { add: false, why: 'no new best brick on the newest bar' };
  const every = pyramidEveryOf(row.pyramidEvery);
  if (every > 1) {
    const lastAddBox = [...(row.adds ?? [])].reverse().find(a => Number.isFinite(a.box))?.box;
    const from = lastAddBox ?? row.entryBox ?? row.base?.price ?? row.entryPrice;
    const moved = row.side === 'SELL' ? gridSteps(model, reach, from) : gridSteps(model, from, reach);
    if (!(model.box > 0) || moved < every - 1e-6) return { add: false, why: `waiting for ${every} bricks past the last add` };
  }
  return { add: true, barT: last, box: reach };
}
