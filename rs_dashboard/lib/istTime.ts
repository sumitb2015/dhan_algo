import { istDateIso } from './nseHolidays.ts';

// IST clock arithmetic shared by the chart/terminal code. IST has no DST, so a fixed +05:30 offset is exact.
// Calendar dates ('YYYY-MM-DD') come from lib/nseHolidays.ts' istDateIso — one formatter for the whole dashboard.

/** +05:30 in seconds. Bar times (`t`) are epoch seconds. */
export const IST_OFFSET_S = 19_800;

/** Today's IST calendar date, 'YYYY-MM-DD'. */
export const istToday = (): string => istDateIso(Date.now());

/** IST calendar-day number of an epoch-seconds time: cheap per-bar day comparison (no Date / string per call). */
export const istDayNumber = (tSec: number): number => Math.floor((tSec + IST_OFFSET_S) / 86_400);

/** IST wall-clock minute of the day (0-1439) for an epoch-ms time; `withSeconds` adds the seconds as a fraction. */
export function istMinuteOfDay(ms: number, withSeconds = false): number {
  const d = new Date(ms + IST_OFFSET_S * 1000);
  return d.getUTCHours() * 60 + d.getUTCMinutes() + (withSeconds ? d.getUTCSeconds() / 60 : 0);
}

/** IST wall-clock time of an epoch-ms time, 'HH:MM:SS'. */
export const istClock = (ms: number): string => new Date(ms + IST_OFFSET_S * 1000).toISOString().slice(11, 19);

/** Start of the minute containing `tSec` (epoch seconds; the offset is whole minutes, so UTC and IST minutes coincide). */
export const minuteStart = (tSec: number): number => Math.floor(tSec / 60) * 60;
