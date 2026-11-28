import { sessionOf, type Bar } from './straddlePnf.ts';
import { istMinuteOfDay, sessionWindow, type Market } from './straddlePnfLive.ts';

/**
 * Auto Renko brick size, after Dr. Devendra Pratap Singh's "Why 8.33 ATR?" (Upsurge, YouTube 0sZIYc1I4Eg, ~24:30-31:10):
 * read ATR(5) on a session-long candle (TradingView 6 h on NSE, so one candle ≈ one day and 5 ≈ a trading week), then divide it by
 * the number of target-timeframe slots in that session: NIFTY ATR 100 / (6 h × 2 per hour) = 8.33 for a 30-minute brick.
 *
 * Here the "session candle" is the whole trading session built from the feed's 1-minute bars (TradingView's 6 h bars on NSE would
 * leave a 15:15-15:30 stub candle). The ATR is TradingView's: Wilder's RMA of the True Range, seeded with the SMA of the first
 * `period` ranges; the forming (unfinished) session is left out, so the brick does not depend on what time the page was opened.
 */

/** ATR period, in sessions (the video's "ATR 5": five sessions in a week). */
export const AUTO_ATR_PERIOD = 5;
/** Sessions read back for the RMA to settle: a session 30 back weighs (4/5)^25 ≈ 0.4 % in ATR(5). */
export const AUTO_ATR_LOOKBACK = 30;

/**
 * Fallback brick (pts, 30-minute target) when the feed has too few finished sessions for an ATR. Measured from the feed's 1-minute
 * history on 2026-11-27 (Wilder ATR(5) / blocks); they drift with volatility, so they are only a starting point until the ATR exists.
 * Only an index or a future gets one: an option's premium has no fixed scale, so it keeps its current box.
 */
export const INDEX_BASELINE_BLOCKS: Record<string, number> = {
  NIFTY: 32.05,      // ATR 384.8 / 12
  BANKNIFTY: 104.5,  // ATR 1253.7 / 12
  CRUDEOIL: 11,      // ATR 300.3 / 28, on the 1-point MCX tick
  CRUDEOILM: 11,
};

/** The fallback brick for an index / future symbol (a future's root, e.g. CRUDEOILM26DEC → CRUDEOILM), or null when none is known. */
export function indexBaselineBlock(symbol: string): number | null {
  const s = symbol.toUpperCase().trim();
  if (INDEX_BASELINE_BLOCKS[s] !== undefined) return INDEX_BASELINE_BLOCKS[s];
  // the longest matching root first, so CRUDEOILM is never read as CRUDEOIL
  const roots = Object.keys(INDEX_BASELINE_BLOCKS).sort((a, b) => b.length - a.length);
  const root = roots.find(r => s.startsWith(r));
  return root ? INDEX_BASELINE_BLOCKS[root] : null;
}

/** Trading session length in hours, as the video counts it: NSE 6 (the 6 h 15 m day), MCX 14, crypto 24. */
export function sessionHoursForMarket(market?: string, symbol?: string): number {
  const m = market?.toUpperCase();
  const s = symbol?.toUpperCase();
  if (m === 'MCX' || m === 'MCX_COMM' || s?.includes('CRUDE') || s?.includes('NATURALGAS') || s?.includes('GOLD') || s?.includes('SILVER')) {
    return 14;
  }
  if (m === 'CRYPTO' || s?.includes('BTC') || s?.includes('ETH')) {
    return 24;
  }
  return 6;
}

export type SessionHLC = { id: string; high: number; low: number; close: number };

const MARKETS: readonly Market[] = ['NSE', 'NSE_CAS', 'NSE_FNO', 'MCX'];
const asMarket = (m?: string): Market => (MARKETS as readonly string[]).includes(m ?? '') ? (m as Market) : 'NSE';

/**
 * The last `maxSessions` sessions' high / low / close from 1-minute bars, read from the end of the array only (an index carries two
 * years of minutes). A bar's own high / low is used where the source has it, else its close.
 */
export function sessionsFromBars(bars: Bar[], maxSessions = AUTO_ATR_LOOKBACK + 1): SessionHLC[] {
  // walk back to the first bar of the oldest session wanted
  let start = bars.length;
  let seen = 0;
  let curId: string | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const id = sessionOf(bars[i].t);
    if (id !== curId) {
      if (seen === maxSessions) break;
      seen++;
      curId = id;
    }
    start = i;
  }
  const out: SessionHLC[] = [];
  let cur: SessionHLC | null = null;
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    const price = b.straddle > 0 ? b.straddle : (b.ce + b.pe);
    if (!(price > 0)) continue;
    const high = b.h ?? price;
    const low = b.l ?? price;
    const id = sessionOf(b.t);
    if (!cur || cur.id !== id) {
      if (cur) out.push(cur);
      cur = { id, high, low, close: price };
    } else {
      cur.high = Math.max(cur.high, high);
      cur.low = Math.min(cur.low, low);
      cur.close = price;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Drops the last session while it is still trading at `nowSec` (its range and close are not final yet). */
export function finishedSessions(sessions: SessionHLC[], market: string | undefined, nowSec: number | undefined): SessionHLC[] {
  if (!sessions.length || nowSec === undefined || !(nowSec > 0)) return sessions;
  const last = sessions[sessions.length - 1];
  if (last.id !== sessionOf(nowSec)) return sessions;
  const close = sessionWindow(asMarket(market), nowSec)[1];
  return istMinuteOfDay(nowSec) < close ? sessions.slice(0, -1) : sessions;
}

/** True Range per session; the first has no previous close, so it is its high - low (TradingView does the same). */
export function trueRanges(sessions: SessionHLC[]): number[] {
  return sessions.map((cur, i) => {
    const hl = cur.high - cur.low;
    if (i === 0) return hl;
    const pc = sessions[i - 1].close;
    return Math.max(hl, Math.abs(cur.high - pc), Math.abs(cur.low - pc));
  });
}

/** TradingView's ta.atr: RMA (Wilder) of the True Range, seeded with the SMA of the first `period`; null with fewer than `period`. */
export function wilderAtr(trs: number[], period = AUTO_ATR_PERIOD): number | null {
  if (period < 1 || trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) atr = (atr * (period - 1) + trs[i]) / period;
  return atr;
}

export type DailyAtrResult = {
  atr: number;
  /** Finished sessions the ATR was read over. */
  sessionsCount: number;
  /** The last finished session's id (YYYY-MM-DD, IST) — the ATR changes only when this does. */
  lastSession: string;
  lastSessionRange: number;
};

/** Session ATR(`period`) from 1-minute bars, over finished sessions only; null until `period` of them exist. */
export function calculateDailyAtr(bars: Bar[], opts: { period?: number; market?: string; nowSec?: number } = {}): DailyAtrResult | null {
  const period = opts.period ?? AUTO_ATR_PERIOD;
  if (bars.length === 0) return null;
  const sessions = finishedSessions(sessionsFromBars(bars), opts.market, opts.nowSec);
  const atr = wilderAtr(trueRanges(sessions), period);
  if (atr === null || !(atr > 0)) return null;
  const last = sessions[sessions.length - 1];
  return {
    atr: Number(atr.toFixed(2)),
    sessionsCount: sessions.length,
    lastSession: last.id,
    lastSessionRange: Number((last.high - last.low).toFixed(2)),
  };
}

/** Snaps a value to the instrument tick (0.05 on NSE, 1 on an MCX crude future). */
export function snapToTick(val: number, tick = 0.05): number {
  if (!(tick > 0)) return Number(val.toFixed(2));
  const rounded = Math.round(val / tick) * tick;
  return Number(rounded.toFixed(2));
}

export type AutoBlockResult =
  | { source: 'atr'; boxPts: number; dailyAtr: number; blocks: number; lastSession: string; formula: string }
  | { source: 'baseline'; boxPts: number; dailyAtr: null; blocks: number; lastSession: null; formula: string }
  /** No ATR yet and no fallback for this instrument: keep the current box. */
  | { source: 'none'; boxPts: null; dailyAtr: null; blocks: number; lastSession: null; formula: string };

/**
 * The auto brick: session ATR(5) / (session hours × 60 / targetMinutes), on the instrument's tick. Falls back to the measured index /
 * future baseline (`kind` index or futures) while fewer than 5 finished sessions are loaded, else to 'none'.
 */
export function calculateAutoBlockSize(opts: {
  symbol?: string;
  kind?: string;
  bars?: Bar[];
  market?: string;
  /** Now, unix seconds: a session still trading at this time is left out of the ATR. */
  nowSec?: number;
  targetMinutes?: number;
  boxTick?: number;
}): AutoBlockResult {
  const { symbol = 'NIFTY', kind, bars, market, nowSec, targetMinutes = 30, boxTick } = opts;
  const s = (symbol || 'NIFTY').toUpperCase().trim();
  const sessionHours = sessionHoursForMarket(market, s);
  const blocks = Math.max(1, Math.round(sessionHours * (60 / targetMinutes)));
  const tick = boxTick && boxTick > 0 ? boxTick : (sessionHours === 14 && kind !== 'options' ? 1.0 : 0.05);

  const atrRes = bars && bars.length ? calculateDailyAtr(bars, { market, nowSec }) : null;
  if (atrRes) {
    const boxPts = Math.max(tick, snapToTick(atrRes.atr / blocks, tick));
    return {
      source: 'atr', boxPts, dailyAtr: atrRes.atr, blocks, lastSession: atrRes.lastSession,
      formula: `ATR(${AUTO_ATR_PERIOD}) ${atrRes.atr} over sessions to ${atrRes.lastSession} / ${blocks} blocks of ${targetMinutes}m = ${boxPts} pts`,
    };
  }

  const base = kind === 'options' || kind === 'equity' ? null : indexBaselineBlock(s);
  if (base !== null) {
    const boxPts = Math.max(tick, snapToTick(base, tick));
    return {
      source: 'baseline', boxPts, dailyAtr: null, blocks, lastSession: null,
      formula: `fewer than ${AUTO_ATR_PERIOD} finished sessions loaded: ${s} baseline ${boxPts} pts (${targetMinutes}m, ${blocks} blocks)`,
    };
  }
  return {
    source: 'none', boxPts: null, dailyAtr: null, blocks, lastSession: null,
    formula: `fewer than ${AUTO_ATR_PERIOD} finished sessions loaded and no baseline for ${s}: box unchanged`,
  };
}
