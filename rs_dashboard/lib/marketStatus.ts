// Open/closed state and last-tick age for the /markets table's Status column.

import { isNseTradingDay, istDateIso } from '@/lib/nseHolidays';

export type MarketState = 'live' | 'pre' | 'stale' | 'closed';

const IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** Indian exchange hours (IST). NSE holidays close the NSE session; MCX has its own calendar, which is not modelled. */
export function indianMarketState(nowMs: number, isMcx: boolean, feedStale: boolean): MarketState {
  const p = Object.fromEntries(IST_PARTS.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'closed';
  if (!isMcx && !isNseTradingDay(istDateIso(nowMs))) return 'closed';
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const [open, close] = isMcx ? [9 * 60, 23 * 60 + 30] : [9 * 60 + 15, 15 * 60 + 30];
  if (!isMcx && mins >= 9 * 60 && mins < open) return 'pre';
  if (mins < open || mins >= close) return 'closed';
  return feedStale ? 'stale' : 'live';
}

/**
 * Yahoo rows. Its index bars run 15-21 min behind the exchange, so a trading
 * market always shows a bar that old; the cutoff sits well above that lag.
 * `closed` is the script's verdict that the last bar is at/after the session close.
 */
export const YAHOO_LAG_CUTOFF_MS = 40 * 60_000;

export function globalMarketState(nowMs: number, ts: number | undefined, isLiveSource: boolean, closed?: boolean): MarketState {
  if (!isLiveSource || !ts || closed) return 'closed';
  return nowMs - ts <= YAHOO_LAG_CUTOFF_MS ? 'live' : 'closed';
}

export function fmtAge(nowMs: number, ts: number): string {
  const m = Math.max(0, Math.round((nowMs - ts) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
