import { alignByDate } from './rs.ts';
import { supertrendSeries, rsiArray, emaSmaSeeded } from './indicators.ts';
import type { OHLCVRow } from './rs.ts';

/**
 * BUY / SELL are the decisive states. HOLD = was long, but the entry condition no longer holds
 * and the exit (both negative) has not triggered. WAIT = flat and the entry condition is absent.
 */
export type RsSignal = 'BUY' | 'HOLD' | 'SELL' | 'WAIT';

export interface RsStrategyParams {
  period: number; // RS lookback in bars (Pine default 123; this strategy uses 55)
  stPeriod: number;
  stMult: number;
  rsiPeriod: number;
  rsiMin: number; // BUY also requires RSI > rsiMin; 0 disables the filter
  emaPeriod: number; // the EMA shown in the table; 0 = not computed (weekly series)
  emaGate: boolean; // BUY also requires close > EMA(emaPeriod). Entry only: never affects Hold or Sell
}

export const DEFAULT_PARAMS: RsStrategyParams = { period: 55, stPeriod: 10, stMult: 2, rsiPeriod: 14, rsiMin: 50, emaPeriod: 200, emaGate: true };

export interface RsStrategyStock {
  symbol: string;
  close: number;
  change1D: number;
  rs: number; // ratio as TradingView/StockEdge show it: (stock/stock[n]) / (nifty/nifty[n]) - 1 (0.46 = +46%)
  supertrend: number;
  distPct: number; // (close - supertrend) / close, percent
  stDir: 1 | -1;
  rsi: number;
  ema: number | null; // EMA(emaPeriod) of the close; null until emaPeriod bars exist
  /** Bullish EMA stack on the last bar: close > EMA 20 > EMA 50 > EMA 100 > EMA 200. False until 200 bars exist. A display filter only; not part of the signal. */
  emaStack: boolean;
  rsRisingDays: number; // consecutive sessions RS has risen, ending on the last bar (0 = RS did not rise on the last bar)
  signal: RsSignal;
  /** Date the current buy triggered (YYYY-MM-DD); null unless the stock is Buy or In Trend (i.e. a buy is still active). */
  entryDate: string | null;
  daysInSignal: number; // consecutive bars the current signal has held
  date: string;
  /** Same rules run on weekly bars (resampled from daily). null = not enough weekly history. */
  weekly: RsSignal | null;
}

export interface RsStrategyResponse {
  dataDate: string;
  params: RsStrategyParams;
  totalScanned: number;
  counts: { buy: number; hold: number; sell: number; wait: number };
  stocks: RsStrategyStock[];
}

/**
 * Entry rule. `aboveEma` is true when the EMA gate is off or close > EMA; with the gate on and no
 * EMA yet (a short history) the caller passes false, so such a stock cannot be bought.
 * The exit rule (isSell) deliberately has no EMA term.
 */
export const EMA_STACK_PERIODS = [20, 50, 100, 200] as const;

/** close > EMA20 > EMA50 > EMA100 > EMA200 on the last bar (SMA-seeded EMAs, as TradingView). False when any EMA is missing. */
export function isEmaStacked(closes: number[]): boolean {
  if (closes.length === 0) return false;
  let prev = closes[closes.length - 1];
  for (const period of EMA_STACK_PERIODS) {
    const v = emaSmaSeeded(closes, period)[closes.length - 1];
    if (v === null || !(prev > v)) return false;
    prev = v;
  }
  return true;
}

export function isBuy(rs: number, stDir: 1 | -1, rsi: number, rsiMin: number, aboveEma = true): boolean {
  return rs > 0 && stDir === 1 && (rsiMin <= 0 || rsi > rsiMin) && aboveEma;
}
export function isSell(rs: number, stDir: 1 | -1): boolean {
  return rs < 0 && stDir === -1;
}

type Bar = OHLCVRow;

/** Monday (UTC) of the week containing a YYYY-MM-DD date, as YYYY-MM-DD. */
function weekKey(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const back = (d.getUTCDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * Resample ascending daily bars into weekly bars (Mon-Sun). Each weekly bar is dated by that
 * week's Monday, not its last trading day: a stock halted on Friday would otherwise carry a
 * different date from the index and silently drop out of the RS alignment. The current week is
 * included as a partial bar, as a live TradingView weekly chart does.
 */
export function resampleWeekly(rows: Bar[]): Bar[] {
  const out: Bar[] = [];
  let key = '';
  for (const r of rows) {
    const k = weekKey(r.date);
    const cur = out[out.length - 1];
    if (k === key && cur) {
      cur.high = Math.max(cur.high, r.high);
      cur.low = Math.min(cur.low, r.low);
      cur.close = r.close;
      cur.volume += r.volume;
    } else {
      out.push({ ...r, date: k });
      key = k;
    }
  }
  return out;
}

/**
 * Run the strategy over one timeframe's bars (daily or weekly). Returns the state on the last bar,
 * or null when there is not enough history for the RS lookback plus Supertrend/RSI warm-up.
 */
function evaluateSeries(symbol: string, stockRows: Bar[], indexRows: Bar[], p: RsStrategyParams): Omit<RsStrategyStock, 'weekly'> | null {
  const n = stockRows.length;
  if (n < p.period + p.stPeriod + 5) return null;

  const aligned = alignByDate(stockRows, indexRows);
  if (aligned.length <= p.period) return null;

  // RS is measured over `period` bars the stock and index both traded (a halted day is skipped),
  // keyed by date so it joins to the stock's own bars (Supertrend/RSI use all of them).
  const rsByDate = new Map<string, number>();
  for (let i = p.period; i < aligned.length; i++) {
    const c = aligned[i];
    const b = aligned[i - p.period];
    if (b.stockClose === 0 || b.indexClose === 0) continue;
    rsByDate.set(c.date, (c.stockClose / b.stockClose) / (c.indexClose / b.indexClose) - 1);
  }

  const st = supertrendSeries(stockRows, p.stPeriod, p.stMult);
  const closes = stockRows.map((r) => r.close);
  const rsi = rsiArray(closes, p.rsiPeriod);
  const ema = p.emaPeriod > 0 ? emaSmaSeeded(closes, p.emaPeriod) : null;

  // State machine: enter on BUY, leave only on SELL (RS and Supertrend both negative).
  let long = false;
  let days = 0;
  let valid = 0;
  let prevRs: number | null = null;
  let lastRs = 0;
  let risingDays = 0;
  let lastIdx = -1;
  let entryDate: string | null = null; // bar on which the current long phase began
  let signal: RsSignal = 'WAIT';
  for (let i = 0; i < n; i++) {
    const rs = rsByDate.get(stockRows[i].date);
    const dir = st[i].dir;
    const rsiV = rsi[i];
    if (rs === undefined || dir === null || rsiV === null) continue;
    risingDays = prevRs !== null && rs > prevRs ? risingDays + 1 : 0;
    prevRs = rs;
    lastRs = rs;
    valid++;
    const emaV = ema ? ema[i] : null;
    const aboveEma = !p.emaGate || (emaV !== null && stockRows[i].close > emaV);
    const buy = isBuy(rs, dir, rsiV, p.rsiMin, aboveEma);
    const sell = isSell(rs, dir);
    const wasLong = long;
    if (buy) long = true;
    else if (sell) long = false;
    if (long && !wasLong) entryDate = stockRows[i].date; // a new buy starts a new phase
    if (!long) entryDate = null;
    days = valid > 1 && long === wasLong ? days + 1 : 1;
    signal = long ? (buy ? 'BUY' : 'HOLD') : sell ? 'SELL' : 'WAIT';
    lastIdx = i;
  }
  if (lastIdx < 0) return null;

  const row = stockRows[lastIdx];
  const rs = lastRs;
  const line = st[lastIdx].line as number;
  const prev = lastIdx > 0 ? stockRows[lastIdx - 1].close : row.close;
  return {
    symbol,
    close: row.close,
    change1D: prev > 0 ? ((row.close - prev) / prev) * 100 : 0,
    rs,
    supertrend: line,
    distPct: row.close > 0 ? ((row.close - line) / row.close) * 100 : 0,
    stDir: st[lastIdx].dir as 1 | -1,
    rsi: rsi[lastIdx] as number,
    ema: ema ? ema[lastIdx] : null,
    emaStack: p.emaPeriod > 0 && isEmaStacked(closes.slice(0, lastIdx + 1)), // the daily series only; the weekly run does not use it
    rsRisingDays: risingDays,
    signal,
    entryDate: signal === 'BUY' || signal === 'HOLD' ? entryDate : null,
    daysInSignal: days,
    date: row.date,
  };
}

/**
 * Pure per-stock evaluation on daily bars, plus the weekly-timeframe signal ("mother" chart).
 * Returns null when the stock lacks enough daily history.
 */
export function evaluateStock(
  symbol: string,
  stockRows: Bar[],
  indexRows: Bar[],
  p: RsStrategyParams,
  weeklyIndexRows: Bar[] = resampleWeekly(indexRows), // pass a precomputed one when scanning many stocks
): RsStrategyStock | null {
  const daily = evaluateSeries(symbol, stockRows, indexRows, p);
  if (!daily) return null;
  // The EMA gate is a daily-chart entry filter; a 200-week EMA would need ~4 years of history.
  const weekly = evaluateSeries(symbol, resampleWeekly(stockRows), weeklyIndexRows, { ...p, emaPeriod: 0, emaGate: false });
  return { ...daily, weekly: weekly ? weekly.signal : null };
}
