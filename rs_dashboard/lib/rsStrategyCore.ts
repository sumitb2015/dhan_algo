import { alignByDate } from './rs.ts';
import { supertrendSeries, rsiArray } from './indicators.ts';
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
}

export const DEFAULT_PARAMS: RsStrategyParams = { period: 55, stPeriod: 10, stMult: 2, rsiPeriod: 14, rsiMin: 50 };

export interface RsStrategyStock {
  symbol: string;
  close: number;
  change1D: number;
  rs: number; // percent: (stock/stock[n]) / (nifty/nifty[n]) - 1, x100
  supertrend: number;
  distPct: number; // (close - supertrend) / close, percent
  stDir: 1 | -1;
  rsi: number;
  rsRising: boolean; // RS strictly rising for 3 consecutive sessions
  signal: RsSignal;
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

export function isBuy(rs: number, stDir: 1 | -1, rsi: number, rsiMin: number): boolean {
  return rs > 0 && stDir === 1 && (rsiMin <= 0 || rsi > rsiMin);
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
  const rsi = rsiArray(stockRows.map((r) => r.close), p.rsiPeriod);

  // State machine: enter on BUY, leave only on SELL (RS and Supertrend both negative).
  let long = false;
  let days = 0;
  let valid = 0;
  const rsHist: number[] = []; // last 4 RS readings, for the "rising 3 sessions" test
  let lastIdx = -1;
  let signal: RsSignal = 'WAIT';
  for (let i = 0; i < n; i++) {
    const rs = rsByDate.get(stockRows[i].date);
    const dir = st[i].dir;
    const rsiV = rsi[i];
    if (rs === undefined || dir === null || rsiV === null) continue;
    if (rsHist.length === 4) rsHist.shift();
    rsHist.push(rs);
    valid++;
    const buy = isBuy(rs, dir, rsiV, p.rsiMin);
    const sell = isSell(rs, dir);
    const wasLong = long;
    if (buy) long = true;
    else if (sell) long = false;
    days = valid > 1 && long === wasLong ? days + 1 : 1;
    signal = long ? (buy ? 'BUY' : 'HOLD') : sell ? 'SELL' : 'WAIT';
    lastIdx = i;
  }
  if (lastIdx < 0) return null;

  const row = stockRows[lastIdx];
  const rs = rsHist[rsHist.length - 1];
  const line = st[lastIdx].line as number;
  const prev = lastIdx > 0 ? stockRows[lastIdx - 1].close : row.close;
  return {
    symbol,
    close: row.close,
    change1D: prev > 0 ? ((row.close - prev) / prev) * 100 : 0,
    rs: rs * 100,
    supertrend: line,
    distPct: row.close > 0 ? ((row.close - line) / row.close) * 100 : 0,
    stDir: st[lastIdx].dir as 1 | -1,
    rsi: rsi[lastIdx] as number,
    rsRising: rsHist.length === 4 && rsHist[3] > rsHist[2] && rsHist[2] > rsHist[1] && rsHist[1] > rsHist[0],
    signal,
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
  const weekly = evaluateSeries(symbol, resampleWeekly(stockRows), weeklyIndexRows, p);
  return { ...daily, weekly: weekly ? weekly.signal : null };
}
