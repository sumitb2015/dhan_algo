import { isMcxUnderlying } from '@/lib/underlyings';

// NSE cash/F&O session: 09:15-15:30 IST, Mon-Fri. Used only to pick a poll cadence (10s live vs
// 60s off-hours) for the live options charts - not a trading-hours source of truth elsewhere.
export function isNseLive(now: Date): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
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
