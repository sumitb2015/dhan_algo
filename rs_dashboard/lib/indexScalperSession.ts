// Is the NSE cash / F&O session open right now (regular day, 09:15 <= IST time < 15:30)? Pure, clock passed in.
// /index-scalper uses it so a feed that keeps sending packets after the close (or a stale spot on a holiday) can never
// make the page look live: outside the session no paper order fills and no REAL market order is sent.
// Muhurat sessions are not regular sessions and read as closed here.

import { istDateIso, isRegularSession } from './nseHolidays.ts';

const OPEN_S = 9 * 3600 + 15 * 60;
const CLOSE_S = 15 * 3600 + 30 * 60;

export function inNseSession(nowMs: number): boolean {
  if (!isRegularSession(istDateIso(nowMs))) return false;
  const ist = Math.floor(nowMs / 1000) + 19800;
  const sec = ((ist % 86400) + 86400) % 86400;
  return sec >= OPEN_S && sec < CLOSE_S;
}
