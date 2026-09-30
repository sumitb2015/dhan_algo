// Trailing % returns over calendar-day windows — one copy shared by the Stock
// Ranking engine (lib/rankingFactors), /api/movers and /api/indices-performance,
// so the Performance and Stock Ranking pages agree on what "3M" or "6M" means.
//
// Every helper returns null when the history doesn't reach back far enough.
// Callers that still use a 0 sentinel (MoverResult, IndexResult) coalesce
// with `?? 0` themselves; don't bake that into this module.

import type { OHLCVRow } from '@/lib/rs';

export type ReturnWindow = '1w' | '1m' | '3m' | '6m' | '1y';

/** Calendar-day lookback per window. The base is the last close on or before latest date − N days. */
export const RETURN_WINDOW_DAYS: Record<ReturnWindow, number> = {
  '1w': 7,
  '1m': 29,
  '3m': 91,
  '6m': 182,
  '1y': 364,
};

export function shiftDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** % change from the last close on or before (latest date − days) to the latest close. */
export function pctChangeSince(rows: OHLCVRow[], days: number): number | null {
  if (rows.length < 2) return null;
  const latest = rows[rows.length - 1];
  const target = shiftDays(latest.date, days);
  for (let i = rows.length - 2; i >= 0; i--) {
    if (rows[i].date <= target) {
      const base = rows[i].close;
      return base > 0 ? ((latest.close - base) / base) * 100 : null;
    }
  }
  return null;
}

export function pctChangeWindow(rows: OHLCVRow[], window: ReturnWindow): number | null {
  return pctChangeSince(rows, RETURN_WINDOW_DAYS[window]);
}

/**
 * Latest-session % change. Dhan can report the previous settlement as today's
 * close until EOD processing runs; when close equals the prior close, the open
 * (or the range midpoint) stands in for the current price.
 */
export function pctChange1D(rows: OHLCVRow[]): number | null {
  if (rows.length < 2) return null;
  const curr = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  if (prev.close <= 0) return null;
  let price = curr.close;
  if (price === prev.close) {
    if (curr.open > 0) price = curr.open;
    else if (curr.high > 0 && curr.low > 0) price = (curr.high + curr.low) / 2;
    else return null;
  }
  return ((price - prev.close) / prev.close) * 100;
}
