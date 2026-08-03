// NSE cash/F&O session: 09:15-15:30 IST, Mon-Fri. Used only to pick a poll cadence (10s live vs
// 60s off-hours) for the live options charts - not a trading-hours source of truth elsewhere.
export function isNseLive(now: Date): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}
