/**
 * NSE equity trading holidays (weekdays the exchange is closed) and special sessions.
 *
 * The data lives in nseHolidays.json — the single source shared with Python
 * (lib/nse_holidays.py). Edit the JSON, never a copy of the list. See
 * docs/NSE_HOLIDAYS_2026.md for the source and the maintenance notes. A year
 * the JSON lacks degrades to weekdays-only. MCX keeps its own calendar and is not covered.
 */
import data from './nseHolidays.json';

export const NSE_HOLIDAYS: ReadonlySet<string> = new Set(Object.values(data.holidays).flat());

/** Diwali Muhurat sessions (one hour, not the regular 09:15-15:30 day). */
export const NSE_MUHURAT_SESSIONS: ReadonlySet<string> = new Set(data.special_sessions.muhurat);

const IST_DATE = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' });

/** 'YYYY-MM-DD' for an instant, in IST. */
export function istDateIso(now: Date | number): string {
  return IST_DATE.format(now);
}

/** A weekday that is not an NSE holiday, for a 'YYYY-MM-DD' date. */
export function isNseTradingDay(iso: string): boolean {
  const day = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return day !== 0 && day !== 6 && !NSE_HOLIDAYS.has(iso);
}

/** A trading day with the full 09:15-15:30 session: not a holiday, not a Muhurat session. */
export function isRegularSession(iso: string): boolean {
  return isNseTradingDay(iso) && !NSE_MUHURAT_SESSIONS.has(iso);
}
