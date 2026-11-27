// Pure helpers for the /candlestick page (daily EOD stock / index charts). No React, no chart library.
// Indicators are the Index Scalper's catalogue (lib/indexScalperIndicators.ts) so a value here matches the scalper's
// and TradingView's; only the intraday-only kinds are left out.

import { resampleWeekly } from './rsStrategyCore.ts';
import { INDICATOR_CATALOG, migrateIndicatorsV1, newIndicator, type Bar, type IndicatorInstance, type IndicatorKind } from './indexScalperIndicators.ts';

export interface CandleRow { date: string; open: number; high: number; low: number; close: number; volume: number }

export type Timeframe = 'D' | 'W' | 'M';
export const TIMEFRAMES: { key: Timeframe; label: string; hint: string }[] = [
  { key: 'D', label: '1D', hint: 'Daily candles' },
  { key: 'W', label: '1W', hint: 'Weekly candles (Monday to Friday; the current week is a partial bar)' },
  { key: 'M', label: '1M', hint: 'Monthly candles (the current month is a partial bar)' },
];

/** Session-based kinds (VWAP resets each IST day; CPR / pivots / Day H/L step at the day change with a gap after every
 *  day). On one bar per day every point is a "day change", so their lines would be invisible or meaningless. */
const INTRADAY_ONLY: IndicatorKind[] = ['vwap', 'cpr', 'pivots', 'daylevels'];
export const EQUITY_INDICATOR_KINDS: IndicatorKind[] = INDICATOR_CATALOG.map(c => c.kind).filter(k => !INTRADAY_ONLY.includes(k));

/** Month (UTC) of a YYYY-MM-DD date, as its first day. */
function monthKey(date: string): string {
  return `${date.slice(0, 7)}-01`;
}

/** Ascending daily rows -> monthly rows dated by the month's 1st. The current month is a partial bar, as on TradingView. */
export function resampleMonthly(rows: CandleRow[]): CandleRow[] {
  const out: CandleRow[] = [];
  let key = '';
  for (const r of rows) {
    const k = monthKey(r.date);
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

export function resample(rows: CandleRow[], tf: Timeframe): CandleRow[] {
  if (tf === 'W') return resampleWeekly(rows);
  if (tf === 'M') return resampleMonthly(rows);
  return rows;
}

/** YYYY-MM-DD -> epoch seconds at UTC midnight (the chart's time axis; daily bars carry no time of day). */
export function dateToSec(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 1000;
}

/** Candle rows -> the indicator engine's bars. `v` only when the series has real volume: the index CSVs carry 0, and a
 *  bar without `v` keeps the Volume indicator from drawing a flat zero histogram. */
export function toBars(rows: CandleRow[]): Bar[] {
  const hasVol = rows.some(r => r.volume > 0);
  return rows.map(r => ({ t: dateToSec(r.date), o: r.open, h: r.high, l: r.low, c: r.close, ...(hasVol ? { v: r.volume } : {}) }));
}

/** Trading days per bar of each timeframe, to turn a period button (in trading days) into a bar count. */
const DAYS_PER_BAR: Record<Timeframe, number> = { D: 1, W: 5, M: 21 };

/** Bars to frame for a period of `days` trading days (null = everything). */
export function barsForPeriod(days: number | null, tf: Timeframe): number | null {
  if (days === null) return null;
  return Math.max(6, Math.ceil(days / DAYS_PER_BAR[tf]));
}

/** The default indicator set: what the page always showed (volume, SMA 20, SMA 200). */
export function defaultEquityIndicators(): IndicatorInstance[] {
  const sma20 = newIndicator('sma', 'sma20');
  const sma200 = newIndicator('sma', 'sma200');
  return [
    newIndicator('volume', 'vol'),
    { ...sma20, params: { period: 20 }, color: '#f59e0b' },
    { ...sma200, params: { period: 200 }, color: '#a78bfa' },
  ];
}

/** A saved indicator list read back from localStorage: anything malformed or of a kind this page does not offer is
 *  dropped; an unreadable value gives the defaults. */
export function parseSavedIndicators(raw: string | null): IndicatorInstance[] {
  if (!raw) return defaultEquityIndicators();
  try {
    const v: unknown = JSON.parse(raw);
    if (!Array.isArray(v)) return defaultEquityIndicators();
    const ok = v.filter((i): i is IndicatorInstance =>
      !!i && typeof i === 'object' && typeof i.id === 'string' && EQUITY_INDICATOR_KINDS.includes(i.kind)
      && !!i.params && typeof i.params === 'object' && typeof i.color === 'string' && typeof i.visible === 'boolean');
    return migrateIndicatorsV1(ok);
  } catch {
    return defaultEquityIndicators();
  }
}

export interface BarLegend { o: number; h: number; l: number; c: number; v: number | null; chg: number | null; chgPct: number | null }

/** OHLC legend for bar `i`: change against the previous bar's close (none for the first bar). */
export function legendAt(bars: Bar[], i: number): BarLegend | null {
  const b = bars[i];
  if (!b) return null;
  const p = i > 0 ? bars[i - 1].c : null;
  const chg = p !== null ? b.c - p : null;
  return { o: b.o, h: b.h, l: b.l, c: b.c, v: b.v ?? null, chg, chgPct: chg !== null && p ? (chg / p) * 100 : null };
}

/** 52-week high / low from DAILY rows: the last 365 calendar days up to the last row (null for an empty list). */
export function week52(rows: CandleRow[]): { high: number; low: number; highDate: string; lowDate: string } | null {
  if (rows.length === 0) return null;
  const end = dateToSec(rows[rows.length - 1].date);
  const from = end - 365 * 86400;
  let hi = -Infinity, lo = Infinity, hd = '', ld = '';
  for (const r of rows) {
    if (dateToSec(r.date) <= from) continue;
    if (r.high > hi) { hi = r.high; hd = r.date; }
    if (r.low < lo) { lo = r.low; ld = r.date; }
  }
  return Number.isFinite(hi) ? { high: hi, low: lo, highDate: hd, lowDate: ld } : null;
}

/** Indian-grouped volume: 1.23 Cr / 4.5 L / 12,345. */
export function fmtVolume(v: number): string {
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  return Math.round(v).toLocaleString('en-IN');
}
