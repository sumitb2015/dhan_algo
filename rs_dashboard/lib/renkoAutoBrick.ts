import { sessionOf, type Bar } from './straddlePnf.ts';
import { IST_OFFSET_S } from './istTime.ts';
import { istMinuteOfDay, sessionWindow, type Market } from './straddlePnfLive.ts';

/**
 * Auto Renko brick size, after Dr. Devendra Pratap Singh's "Why 8.33 ATR?" (Upsurge, YouTube 0sZIYc1I4Eg, ~24:30-31:10): put a
 * Renko [ATR(5)] on a chart whose timeframe is the session length (6H for NSE), read its box (NIFTY "ATR 100" in the video), and
 * divide it by the target-timeframe slots in the session: 100 / (6 h × 2 per hour) = 8.33 for a 30-minute brick.
 *
 * Built to match tradingcharts.co / TradingView exactly (checked 2026-11-28, see the tests):
 *  - candles are `sessionHours` long from the session open, so an NSE day is TWO candles: 09:15-15:15 and a 15:15-15:30 stub. The
 *    stub's small range roughly halves the ATR against a whole-day ATR (NIFTY 180.8 vs 384.8) — that is the chart the video reads.
 *  - ATR is Wilder's RMA of the True Range (ta.atr), seeded with the SMA of the first `period`.
 *  - the Renko [ATR] box is that ATR rounded to the nearest 1 / 1.5 / 2 / 2.5 / 3 / 4 / 5 / 6 / 8 × 10^n (NIFTY 180.8 → 200,
 *    CRUDEOILM 171.1 → 150, BANKNIFTY 561.5 → 600, FINNIFTY 255.1 → 250, MIDCPNIFTY 96.9 → 100). The ladder is inferred from those
 *    five readings, not from documentation.
 * One deliberate difference: a candle still forming is left out, so the brick does not depend on what time the page was opened.
 */

/** ATR period, in session-length candles (the video's "ATR 5"). */
export const AUTO_ATR_PERIOD = 5;
/** Candles read back for the RMA to settle: one 60 back weighs (4/5)^55 ≈ 0.0005 % in ATR(5). */
export const AUTO_ATR_LOOKBACK = 60;

/** The round numbers a Renko [ATR] box snaps to, per decade (see above). */
const NICE_STEPS = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];

/** The nearest round box to an ATR value: 180.8 → 200, 171.1 → 150, 561.5 → 600. */
export function niceRound(v: number): number {
  if (!(v > 0) || !Number.isFinite(v)) return 0;
  const mag = 10 ** Math.floor(Math.log10(v));
  let best = NICE_STEPS[0] * mag;
  for (const s of NICE_STEPS) if (Math.abs(s * mag - v) < Math.abs(best - v)) best = s * mag;
  return Number(best.toPrecision(12));
}

/**
 * Fallback brick (pts, 30-minute target) when the feed has too few finished candles for an ATR: the tradingcharts.co Renko [ATR(5)]
 * box on the 6H chart on 2026-11-28, / 12 (NSE) or / 28 (MCX). It drifts with volatility, so it is only a starting point. Only an
 * index or a future gets one: an option's premium has no fixed scale, so it keeps its current box.
 */
export const INDEX_BASELINE_BLOCKS: Record<string, number> = {
  NIFTY: 16.65,      // box 200 / 12
  BANKNIFTY: 50,     // box 600 / 12
  FINNIFTY: 20.85,   // box 250 / 12
  MIDCPNIFTY: 8.35,  // box 100 / 12
  CRUDEOIL: 5,       // box 150 / 28, on the 1-point MCX tick
  CRUDEOILM: 5,
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

export type Candle = { id: string; high: number; low: number; close: number; /** IST minute of day the candle ends (exclusive). */ end: number };

const MARKETS: readonly Market[] = ['NSE', 'NSE_CAS', 'NSE_FNO', 'MCX'];
const asMarket = (m?: string): Market => (MARKETS as readonly string[]).includes(m ?? '') ? (m as Market) : 'NSE';

/**
 * The last `maxCandles` candles of `candleMin` minutes from 1-minute bars, anchored at each day's session open the way
 * TradingView anchors an intraday timeframe (NSE 6H: 09:15-15:15, then a 15:15-15:30 stub). Read from the end of the array only
 * (an index carries two years of minutes). A bar's own high / low is used where the source has it, else its close.
 */
export function sessionCandles(bars: Bar[], market: string | undefined, candleMin: number, maxCandles = AUTO_ATR_LOOKBACK + 1): Candle[] {
  const mkt = asMarket(market);
  // the session window and date label once per IST day (a date conversion per bar costs ~100 ms on a month of minutes)
  const days = new Map<number, { day: string; open: number; close: number }>();
  const keyOf = (t: number) => {
    const dn = Math.floor((t + IST_OFFSET_S) / 86_400);
    let d = days.get(dn);
    if (!d) {
      const [open, close] = sessionWindow(mkt, t);
      d = { day: sessionOf(t), open, close: close || 24 * 60 };
      days.set(dn, d);
    }
    const k = Math.max(0, Math.floor((istMinuteOfDay(t) - d.open) / candleMin));
    return { id: `${d.day}#${k}`, end: Math.min(d.open + (k + 1) * candleMin, d.close) };
  };
  // walk back to the first bar of the oldest candle wanted
  let start = bars.length;
  let seen = 0;
  let curId: string | null = null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const { id } = keyOf(bars[i].t);
    if (id !== curId) {
      if (seen === maxCandles) break;
      seen++;
      curId = id;
    }
    start = i;
  }
  const out: Candle[] = [];
  let cur: Candle | null = null;
  for (let i = start; i < bars.length; i++) {
    const b = bars[i];
    const price = b.straddle > 0 ? b.straddle : (b.ce + b.pe);
    if (!(price > 0)) continue;
    const high = b.h ?? price;
    const low = b.l ?? price;
    const { id, end } = keyOf(b.t);
    if (!cur || cur.id !== id) {
      if (cur) out.push(cur);
      cur = { id, high, low, close: price, end };
    } else {
      cur.high = Math.max(cur.high, high);
      cur.low = Math.min(cur.low, low);
      cur.close = price;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** Drops the last candle while it is still forming at `nowSec` (its range and close are not final yet). */
export function finishedCandles(candles: Candle[], nowSec: number | undefined): Candle[] {
  if (!candles.length || nowSec === undefined || !(nowSec > 0)) return candles;
  const last = candles[candles.length - 1];
  if (!last.id.startsWith(`${sessionOf(nowSec)}#`)) return candles;
  return istMinuteOfDay(nowSec) < last.end ? candles.slice(0, -1) : candles;
}

/** True Range per candle; the first has no previous close, so it is its high - low (TradingView does the same). */
export function trueRanges(candles: { high: number; low: number; close: number }[]): number[] {
  return candles.map((cur, i) => {
    const hl = cur.high - cur.low;
    if (i === 0) return hl;
    const pc = candles[i - 1].close;
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
  /** Wilder ATR(period) on the session-length candles. */
  atr: number;
  /** `atr` rounded the way the Renko [ATR] box shows it (niceRound). */
  box: number;
  /** Finished candles the ATR was read over. */
  candlesCount: number;
  /** The last finished candle's id (YYYY-MM-DD#n, IST) — the ATR changes only when this does. */
  lastCandle: string;
};

/** ATR(`period`) on `candleMin`-minute session candles from 1-minute bars, finished candles only; null until `period` of them exist. */
export function calculateDailyAtr(
  bars: Bar[], opts: { period?: number; market?: string; nowSec?: number; candleMin?: number } = {},
): DailyAtrResult | null {
  const period = opts.period ?? AUTO_ATR_PERIOD;
  const candleMin = opts.candleMin ?? 360;
  if (bars.length === 0) return null;
  const candles = finishedCandles(sessionCandles(bars, opts.market, candleMin), opts.nowSec);
  const atr = wilderAtr(trueRanges(candles), period);
  if (atr === null || !(atr > 0)) return null;
  return { atr: Number(atr.toFixed(2)), box: niceRound(atr), candlesCount: candles.length, lastCandle: candles[candles.length - 1].id };
}

/** Snaps a value to the instrument tick (0.05 on NSE, 1 on an MCX crude future). */
export function snapToTick(val: number, tick = 0.05): number {
  if (!(tick > 0)) return Number(val.toFixed(2));
  const rounded = Math.round(val / tick) * tick;
  return Number(rounded.toFixed(2));
}

export type AutoBlockResult =
  | { source: 'atr'; boxPts: number; dailyAtr: number; renkoBox: number; blocks: number; lastSession: string; formula: string }
  | { source: 'baseline'; boxPts: number; dailyAtr: null; blocks: number; lastSession: null; formula: string }
  /** No ATR yet and no fallback for this instrument: keep the current box. */
  | { source: 'none'; boxPts: null; dailyAtr: null; blocks: number; lastSession: null; formula: string };

/**
 * The auto brick: the Renko [ATR(5)] box on a session-length chart / (session hours × 60 / targetMinutes), on the instrument's
 * tick. Falls back to the measured index / future baseline (`kind` index or futures) while fewer than 5 finished candles are
 * loaded, else to 'none'.
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

  const atrRes = bars && bars.length ? calculateDailyAtr(bars, { market, nowSec, candleMin: sessionHours * 60 }) : null;
  if (atrRes) {
    const boxPts = Math.max(tick, snapToTick(atrRes.box / blocks, tick));
    return {
      source: 'atr', boxPts, dailyAtr: atrRes.atr, renkoBox: atrRes.box, blocks, lastSession: atrRes.lastCandle,
      formula: `Renko ATR(${AUTO_ATR_PERIOD}) on ${sessionHours}H ${atrRes.atr} → box ${atrRes.box} / ${blocks} blocks of ${targetMinutes}m = ${boxPts} pts`,
    };
  }

  const base = kind === 'options' || kind === 'equity' ? null : indexBaselineBlock(s);
  if (base !== null) {
    const boxPts = Math.max(tick, snapToTick(base, tick));
    return {
      source: 'baseline', boxPts, dailyAtr: null, blocks, lastSession: null,
      formula: `fewer than ${AUTO_ATR_PERIOD} finished ${sessionHours}H candles: ${s} baseline ${boxPts} pts (${targetMinutes}m, ${blocks} blocks)`,
    };
  }
  return {
    source: 'none', boxPts: null, dailyAtr: null, blocks, lastSession: null,
    formula: `fewer than ${AUTO_ATR_PERIOD} finished ${sessionHours}H candles and no baseline for ${s}: box unchanged`,
  };
}
