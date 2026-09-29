// Shape of GET /api/portfolio-trades (debug/portfolio_trade_history.json, written by
// scripts/tools/get_trade_pnl_by_segment.py): Dhan's realized P&L per day, FIFO-matched and
// dated by the closing trade. Pure helpers here so `node --test` can exercise them.

export interface DailyPnlPoint {
  date: string;
  grossPnl: number;
  charges: number;
  statutoryCharges: number;
  netPnl: number;
  tradeCount: number;
  // Kotak-only. Its Gain/Loss export aggregates per scrip over a DATE RANGE and carries no per-trade
  // date, so a multi-day export cannot be split into daily points — it becomes one point stamped at
  // the range's end date with approx=true. Exact when the export covers a single day.
  approx?: boolean;
  spanDays?: number;
  fromDate?: string;
}

export interface TradeHistoryResponse {
  success: boolean;
  available: boolean;
  syncRunning?: boolean;
  syncError?: string | null;
  fromDate?: string;
  toDate?: string;
  generatedAt?: string;
  marketTradingDates?: string[];
  dailyPnl?: DailyPnlPoint[];
  dailyPnlBySegment?: Record<string, DailyPnlPoint[]>;
}

export interface RecentDaysPnl {
  gross: number;
  charges: number;
  net: number;
  /** One entry per day in the window, newest first; a market day with no trades has zeros. */
  days: DailyPnlPoint[];
}

const zeroDay = (date: string): DailyPnlPoint =>
  ({ date, grossPnl: 0, charges: 0, statutoryCharges: 0, netPnl: 0, tradeCount: 0 });

/**
 * The `n` most recent days before `today` ('YYYY-MM-DD', IST) from the account's daily P&L. The
 * window is market days (the Nifty 50 calendar the route returns) plus any day that has trades,
 * so an exchange holiday is skipped and a traded day is never dropped if the calendar CSV lags.
 */
export function previousDaysPnl(resp: TradeHistoryResponse, today: string, n = 3): RecentDaysPnl {
  const points = resp.dailyPnl ?? [];
  const byDate = new Map(points.map(p => [p.date, p]));
  const dates = [...new Set([...(resp.marketTradingDates ?? []), ...byDate.keys()])]
    .filter(d => d < today)
    .sort()
    .slice(-n)
    .reverse();
  const days = dates.map(d => byDate.get(d) ?? zeroDay(d));
  const sum = (f: (p: DailyPnlPoint) => number) => days.reduce((s, p) => s + f(p), 0);
  return { gross: sum(p => p.grossPnl), charges: sum(p => p.charges), net: sum(p => p.netPnl), days };
}
