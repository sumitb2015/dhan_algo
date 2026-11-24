// Is the market session open right now for the given underlying? Pure, clock passed in.
// - NIFTY: NSE cash / F&O session (regular trading day, 09:15 <= IST time < 15:30)
// - CRUDEOILM: MCX session (weekdays, 09:00 <= IST time < 23:30 in summer DST or 23:55 in winter)
// /index-scalper uses it so a feed that keeps sending packets after the close (or a stale spot on a holiday) can never
// make the page look live: outside the session no paper order fills and no REAL market order is sent.

import { istDateIso, isRegularSession } from './nseHolidays.ts';
import { mcxSession } from './mcxSession.ts';
import type { Underlying } from './indexScalperInstrument.ts';

const NSE_OPEN_S = 9 * 3600 + 15 * 60;
const NSE_CLOSE_S = 15 * 3600 + 30 * 60;

export function inNseSession(nowMs: number): boolean {
  if (!isRegularSession(istDateIso(nowMs))) return false;
  const ist = Math.floor(nowMs / 1000) + 19800;
  const sec = ((ist % 86400) + 86400) % 86400;
  return sec >= NSE_OPEN_S && sec < NSE_CLOSE_S;
}

export function inMcxSession(nowMs: number): boolean {
  const iso = istDateIso(nowMs);
  const sess = mcxSession(iso);
  if (sess.open >= sess.close) return false;
  const ist = Math.floor(nowMs / 1000) + 19800;
  const sec = ((ist % 86400) + 86400) % 86400;
  const openSec = Math.floor(sess.open / 100) * 3600 + (sess.open % 100) * 60;
  const closeSec = Math.floor(sess.close / 100) * 3600 + (sess.close % 100) * 60;
  return sec >= openSec && sec < closeSec;
}

export function inMarketSession(underlying: Underlying, nowMs: number): boolean {
  return underlying === 'CRUDEOILM' ? inMcxSession(nowMs) : inNseSession(nowMs);
}
