// Open/closed state and last-tick age for the /markets table's Status column.

export type MarketState = 'live' | 'pre' | 'stale' | 'closed';

const IST_PARTS = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Kolkata', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false,
});

/** Indian exchange hours (IST). Exchange holidays are not modelled. */
export function indianMarketState(nowMs: number, isMcx: boolean, feedStale: boolean): MarketState {
  const p = Object.fromEntries(IST_PARTS.formatToParts(new Date(nowMs)).map(x => [x.type, x.value]));
  if (p.weekday === 'Sat' || p.weekday === 'Sun') return 'closed';
  const mins = Number(p.hour) * 60 + Number(p.minute);
  const [open, close] = isMcx ? [9 * 60, 23 * 60 + 30] : [9 * 60 + 15, 15 * 60 + 30];
  if (!isMcx && mins >= 9 * 60 && mins < open) return 'pre';
  if (mins < open || mins >= close) return 'closed';
  return feedStale ? 'stale' : 'live';
}

/** Yahoo rows: "live" only while the newest 1-min bar is recent. */
export function globalMarketState(nowMs: number, ts: number | undefined, isLiveSource: boolean): MarketState {
  if (!isLiveSource || !ts) return 'closed';
  return nowMs - ts <= 20 * 60_000 ? 'live' : 'closed';
}

export function fmtAge(nowMs: number, ts: number): string {
  const m = Math.max(0, Math.round((nowMs - ts) / 60_000));
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}
