/** Latest-session move for a held position (pure; the route supplies the daily rows). */
export interface DayRow { date: string; close: number }

export interface DayChange {
  day_pnl: number;
  day_pct: number | null;
  prev_close: number | null;
  date: string | null;
}

/**
 * (latest close − previous session's close) × qty. A position bought on the latest session has no previous close of its
 * own, so it is measured from its entry price. `date` is the session the move belongs to: "today" means the latest
 * trading day, which is not the calendar day on a weekend or holiday.
 */
export function dayChangeFromRows(
  rows: DayRow[],
  holding: { qty: number; entry_price: number; entry_date?: string },
): DayChange {
  const last = rows[rows.length - 1];
  if (!last) return { day_pnl: 0, day_pct: null, prev_close: null, date: null };
  const boughtToday = Boolean(holding.entry_date) && String(holding.entry_date) >= last.date;
  const base = boughtToday ? holding.entry_price : rows[rows.length - 2]?.close;
  if (!base || base <= 0) return { day_pnl: 0, day_pct: null, prev_close: null, date: last.date };
  return {
    day_pnl: (last.close - base) * holding.qty,
    day_pct: (last.close / base - 1) * 100,
    prev_close: base,
    date: last.date,
  };
}
