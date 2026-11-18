// Pure rules for the master_list.csv refresh scheduler (lib/masterListRefresh.ts), kept apart so node --test can load them.
import { istDateIso } from './nseHolidays.ts';

/** A failed download or no Dhan session waits this long before the next attempt. */
export const MASTER_LIST_RETRY_MS = 30 * 60_000;

/** True when a file last written at `mtimeMs` is from an earlier IST day than `nowMs` (or there is no file). */
export function masterListStale(mtimeMs: number | null, nowMs: number): boolean {
  return mtimeMs === null || istDateIso(mtimeMs) < istDateIso(nowMs);
}

/** Whether to spawn the refresh now: stale, nothing in flight, and the last attempt (if any) at least RETRY ago. */
export function shouldRefreshMasterList(mtimeMs: number | null, nowMs: number, lastAttemptMs: number | null, inFlight: boolean): boolean {
  if (inFlight || !masterListStale(mtimeMs, nowMs)) return false;
  return lastAttemptMs === null || nowMs - lastAttemptMs >= MASTER_LIST_RETRY_MS;
}
