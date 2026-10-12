import { isMcxUnderlying } from './underlyings.ts';
import { isNseTradingDay, istDateIso } from './nseHolidays.ts';

// NSE F&O session: 09:15-15:40 IST, Mon-Fri, except NSE holidays (SEBI's Close Auction Session pushed the F&O
// close from 15:30 to 15:40; cash/equity's 15:30 close is separate and unaffected). Used
// only to pick a poll cadence (10s live vs 60s off-hours) for the live options charts -
// not a trading-hours source of truth elsewhere.
export function isNseLive(now: Date): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  if (!isNseTradingDay(istDateIso(now))) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 40;
}

// NSE cash-equity session: 09:15-15:30 IST. The F&O close is 15:40 (isNseLive above); between 15:30 and 15:40 equity prices are
// final while derivatives still trade, so a screen showing equity data must not call that window "live".
export function isNseCashLive(now: Date): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  if (!isNseTradingDay(istDateIso(now))) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

// MCX commodity session: 09:00-23:30 IST, Mon-Fri. Crude keeps trading for another 8 hours after
// the NSE bell, so gating it on isNseLive() would drop its charts to the off-hours poll cadence
// for most of its own session.
export function isMcxLive(now: Date): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 && minutes <= 23 * 60 + 30;
}

/** Poll-cadence gate for the live options charts, per underlying. */
export function isUnderlyingLive(underlying: string, now: Date): boolean {
  return isMcxUnderlying(underlying) ? isMcxLive(now) : isNseLive(now);
}

/** The NSE session whose numbers a ranking or quote fetched at `nowMs` belongs to, as 'YYYY-MM-DD' (IST).
 *  A trading day from 09:15 IST is its own session; before the open, on a weekend or on a holiday it is the last trading day
 *  before it. This is inferred from the calendar - the Market Movers payload itself carries no date. */
export function lastNseSessionDate(nowMs: number): string {
  const today = istDateIso(nowMs);
  const ist = new Date(new Date(nowMs).toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  if (isNseTradingDay(today) && minutes >= 9 * 60 + 15) return today;
  let d = new Date(`${today}T00:00:00Z`).getTime();
  for (let i = 0; i < 14; i++) {
    d -= 86_400_000;
    const iso = new Date(d).toISOString().slice(0, 10);
    if (isNseTradingDay(iso)) return iso;
  }
  return today;
}
