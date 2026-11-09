import { isNseSessionDay, istDateIso } from './nseHolidays.ts';
import { istMinuteOfDay, sessionWindow } from './straddlePnfLive.ts';

// When the dashboard server keeps NIFTY in the price bridge's tick log with every tab closed (lib/pnfAlwaysRecord.ts). Pure.

/** Asked from this long before the open (the first price after subscribing is the hub's replay and is never logged) to after the close. */
export const LEAD_MIN = 10;
export const TAIL_MIN = 2;

/** An NSE session day (Muhurat included), from LEAD_MIN before its open to TAIL_MIN after its close. */
export function recordWindowOpen(nowMs: number): boolean {
  if (!isNseSessionDay(istDateIso(nowMs))) return false;
  const t = nowMs / 1000;
  const [open, close] = sessionWindow('NSE', t);
  const m = istMinuteOfDay(t);
  return open < close && m >= open - LEAD_MIN && m < close + TAIL_MIN;
}
