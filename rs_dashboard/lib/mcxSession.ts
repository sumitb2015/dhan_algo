/**
 * MCX commodity session hours for one IST trading date — the single source for the Price Ladder's MCX hours.
 *
 * MCX's evening session follows US daylight saving: it closes 23:30 IST while the US is on DST (second Sunday of March
 * to the first Sunday of November) and 23:55 IST otherwise. Holidays come from mcxHolidays.json (unconfirmed — see its
 * comment); weekends are closed. A year the JSON lacks degrades to weekdays-only. Pure.
 */
import data from './mcxHolidays.json' with { type: 'json' };

const CLOSED: ReadonlySet<string> = new Set(data.closed);
const EVENING_ONLY: ReadonlySet<string> = new Set(data.evening_only);
const MORNING_ONLY: ReadonlySet<string> = new Set(data.morning_only);

/** Session window in IST hhmm. `open === close` = no session that day. `autoExit` = MIS square-off time. */
export interface McxSession { open: number; close: number; autoExit: number; autoExitLabel: string; note?: string }

/** The n-th Sunday (1-based) of a month, as 'YYYY-MM-DD'. */
function nthSunday(year: number, month: number, n: number): string {
  const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const day = 1 + ((7 - first) % 7) + (n - 1) * 7;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** True while the US is on daylight saving for this IST date (MCX then closes at 23:30, else 23:55). */
export function usDstActive(iso: string): boolean {
  const y = Number(iso.slice(0, 4));
  return iso > nthSunday(y, 3, 2) && iso <= nthSunday(y, 11, 1);
}

const label = (hhmm: number) => `${String(Math.floor(hhmm / 100)).padStart(2, '0')}:${String(hhmm % 100).padStart(2, '0')}`;

export function mcxSession(iso: string): McxSession {
  const shut = (note: string): McxSession => ({ open: 2400, close: 2400, autoExit: 2400, autoExitLabel: '—', note });
  const dow = new Date(`${iso}T00:00:00Z`).getUTCDay();
  if (dow === 0 || dow === 6) return shut('MCX is closed at weekends');
  if (CLOSED.has(iso)) return shut('MCX holiday — closed today');
  const summer = usDstActive(iso);
  // MIS squared off 30 min before the close, ahead of the broker's own intraday square-off.
  let close = summer ? 2330 : 2355;
  let autoExit = summer ? 2300 : 2325;
  let open = 900;
  if (EVENING_ONLY.has(iso)) open = 1700;
  if (MORNING_ONLY.has(iso)) { close = 1700; autoExit = 1630; }
  return { open, close, autoExit, autoExitLabel: label(autoExit), ...(open > 900 ? { note: 'MCX holiday: evening session only (from 17:00)' } : {}) };
}
