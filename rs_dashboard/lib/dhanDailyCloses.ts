import { getDhanCredentials } from '@/lib/dhanToken';

// Dhan's daily candles, for a previous close that survives the 15:30 flip of the quote `close` field
// (dhan-prevclose-pct-change). Moved here from app/api/scalper/top-indices/route.ts so the Fresh Money board's live
// price can use the same source.

const DHAN_HISTORICAL_URL = 'https://api.dhan.co/v2/charts/historical';

// Wide enough to survive the longest realistic NSE/MCX gap (a long weekend
// butted up against a holiday) while staying a small, fast request.
const LOOKBACK_DAYS = 12;

/**
 * Fetches daily-candle closes for the last `LOOKBACK_DAYS` calendar days, as
 * {date, close} rows in IST-date order (oldest first). Dhan's daily-candle
 * endpoint only ever returns rows for days the exchange actually traded, so
 * callers get weekend/holiday skipping for free — no local calendar needed.
 */
export async function fetchDailyCloses(
  sid: number, segment: string, instrument: string,
): Promise<{ date: string; close: number }[] | null> {
  const { clientId, token } = getDhanCredentials();
  if (!token) return null;

  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - LOOKBACK_DAYS);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);

  const res = await fetch(DHAN_HISTORICAL_URL, {
    method: 'POST',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({
      securityId: String(sid),
      exchangeSegment: segment,
      instrument,
      oi: false,
      fromDate: fmt(from),
      toDate: fmt(to),
    }),
    signal: AbortSignal.timeout(8000),
  });
  const json = (await res.json()) as { close?: number[]; timestamp?: number[]; remarks?: unknown };
  const closes = json.close ?? [];
  const timestamps = json.timestamp ?? [];
  if (closes.length === 0 || closes.length !== timestamps.length) return null;

  return timestamps.map((ts, i) => ({
    date: new Date(ts * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }),
    close: closes[i],
  }));
}

/**
 * Yesterday's close for `fromDhan`'s post-close fallback.
 *
 * Verified 2026-09-10: Dhan's daily candle for TODAY is not published at the
 * close bell — still absent from this endpoint at 20:17 IST, ~5h after close.
 * So the most recent row strictly before today already IS the correct
 * prevClose; no "last two rows" comparison is needed here (unlike
 * `fetchPrevSessionChange` above, this call site already has a genuine live
 * `ltp` from the OHLC batch call in `fromDhan` — it only needs one number).
 */
export async function fetchLatestPrevClose(
  sid: number, segment: string, instrument: string, today: string,
): Promise<number | null> {
  const rows = (await fetchDailyCloses(sid, segment, instrument))?.filter(r => r.date < today);
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return last.close > 0 ? last.close : null;
}
