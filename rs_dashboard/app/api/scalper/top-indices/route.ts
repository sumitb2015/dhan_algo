import { NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import { kiteGet } from '@/lib/zerodhaToken';

// Live LTP + % change vs yesterday's close for the headline indices, for the
// Advanced Scalper's Top Indices panel.
//
// Deliberately NOT sourced from scripts/tools/live_indices_ws.py: that bridge
// writes only `opens` and `ltps` (see its atomic_write payload) with no
// prev_close, and its `opens` is "the first tick the bridge happened to see"
// rather than the true session open — so it cannot answer "% vs yesterday's
// close" at all, and its default write cadence is 20s. Dhan's OHLC endpoint
// returns last_price and ohlc.close together for a whole batch in one call,
// which is exactly what's needed.
//
// Kite is the PRIMARY source, which is not the obvious choice (Dhan is the
// default broker) but is the only correct one. Two behaviours measured on
// 2026-07-30 decide it:
//
//  1. Dhan's `ohlc.close` flips from yesterday's close to TODAY's close the
//     moment the 15:30 bell rings. At 14:5x NIFTY read close=24250.20 (correct,
//     yesterday) giving +0.19%; at 15:36 the same field read 24317.15 — equal to
//     the last price — collapsing every row to 0.00%. Kite's `ohlc.close` stayed
//     on 24250.20 and kept reporting the true +0.28%.
//  2. Dhan answers BSE_IDX with HTTP 200 but an EMPTY data object for this
//     account, so it cannot serve SENSEX at all. Kite returns it as BSE:SENSEX.
//
// So Kite serves last_price + prev close for all ten rows in one call, correct
// both during and after the session. Dhan remains a fallback for last_price
// only, guarded by explicit flip-detection (see rejectFlippedClose) so a
// post-close Dhan `close` can never be passed off as yesterday's.
//
// Yesterday's close changes once per trading day, so it is additionally cached
// per IST date: if Kite answered at any point today, a later Kite outage still
// yields correct percentages rather than blank ones.

const DHAN_OHLC_URL = 'https://api.dhan.co/v2/marketfeed/ohlc';

interface IndexDef {
  /** Stable key used by the UI. */
  key: string;
  label: string;
  /** Dhan security id in the IDX_I segment; null when Dhan cannot serve it. */
  dhanSid: number | null;
  /** Kite instrument string, used for SENSEX and as the Dhan fallback. */
  kiteSymbol: string;
}

// Ten headline indices. Order here is the display order when % change is equal;
// the panel itself sorts by % change. Edit this list to change what's shown.
const INDICES: IndexDef[] = [
  { key: 'NIFTY',     label: 'Nifty 50',     dhanSid: 13,   kiteSymbol: 'NSE:NIFTY 50' },
  { key: 'BANKNIFTY', label: 'Bank Nifty',   dhanSid: 25,   kiteSymbol: 'NSE:NIFTY BANK' },
  { key: 'SENSEX',    label: 'Sensex',       dhanSid: null, kiteSymbol: 'BSE:SENSEX' },
  { key: 'FINNIFTY',  label: 'Fin Services', dhanSid: 27,   kiteSymbol: 'NSE:NIFTY FIN SERVICE' },
  { key: 'IT',        label: 'IT',           dhanSid: 29,   kiteSymbol: 'NSE:NIFTY IT' },
  { key: 'AUTO',      label: 'Auto',         dhanSid: 14,   kiteSymbol: 'NSE:NIFTY AUTO' },
  { key: 'PHARMA',    label: 'Pharma',       dhanSid: 32,   kiteSymbol: 'NSE:NIFTY PHARMA' },
  { key: 'METAL',     label: 'Metal',        dhanSid: 31,   kiteSymbol: 'NSE:NIFTY METAL' },
  { key: 'REALTY',    label: 'Realty',       dhanSid: 34,   kiteSymbol: 'NSE:NIFTY REALTY' },
  { key: 'VIX',       label: 'India VIX',    dhanSid: 21,   kiteSymbol: 'NSE:INDIA VIX' },
];

interface Quote { ltp: number; prev_close: number; change_pct: number | null; source: string }

// Short TTL so several open tabs (or a re-render storm) collapse onto one
// upstream call. Kept well under the client's poll interval so it never
// degrades perceived freshness — it only removes duplicate work.
const CACHE_TTL_MS = 2000;
let cache: { ts: number; body: unknown } | null = null;

// Yesterday's close, keyed "<IST date>:<index key>". Populated by whichever
// source proved trustworthy today and reused for the rest of the session.
const prevCloseCache = new Map<string, number>();

function istToday(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

/**
 * Drop entries from previous days.
 *
 * Without this the map grows by one entry per index per trading day and never
 * shrinks — harmless in dev, but this dashboard is also run under `next start`
 * as a long-lived process, where "small but unbounded" is still a leak.
 */
function prunePrevCloseCache(day: string): void {
  for (const key of prevCloseCache.keys()) {
    if (!key.startsWith(`${day}:`)) prevCloseCache.delete(key);
  }
}

/**
 * Reject a `close` that is really today's close masquerading as yesterday's.
 *
 * Dhan flips this field at the closing bell, at which point it equals the last
 * price. Treating that as yesterday's close yields a confident 0.00% for every
 * row — worse than admitting the value is unknown.
 *
 * Known and accepted false positive: an index sitting at exactly its previous
 * close to the paisa (most plausible for India VIX, which has few decimals and
 * low variance) is indistinguishable from a flip, so its genuine 0.00% is
 * reported as unknown instead. It only arises on the Dhan fallback path with no
 * cached close for the day, and it errs toward "unknown" rather than a wrong
 * number, which is the direction to err on an order-entry screen.
 */
function rejectFlippedClose(ltp: number, close: number): number {
  return close > 0 && close !== ltp ? close : 0;
}

function mkQuote(ltp: number, prevClose: number, source: string): Quote | null {
  if (!(ltp > 0)) return null;
  // A missing/zero prev_close makes any percentage meaningless — return null
  // for change_pct rather than a fabricated 0.00%.
  const pct = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : null;
  return { ltp, prev_close: prevClose, change_pct: pct, source };
}

/**
 * Kite: last_price + yesterday's close for every row, in one request.
 * Correct both during and after the session — the primary source.
 */
async function fromKite(defs: IndexDef[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  if (defs.length === 0) return out;

  const qs = defs.map(d => `i=${encodeURIComponent(d.kiteSymbol)}`).join('&');
  const data = (await kiteGet(`/quote/ohlc?${qs}`)) as
    Record<string, { last_price?: number; ohlc?: { close?: number } }>;

  const day = istToday();
  prunePrevCloseCache(day);
  for (const def of defs) {
    const row = data?.[def.kiteSymbol];
    if (!row) continue;
    const ltp = Number(row.last_price ?? 0);
    const close = Number(row.ohlc?.close ?? 0);
    if (close > 0) prevCloseCache.set(`${day}:${def.key}`, close);
    const q = mkQuote(ltp, close, 'kite');
    if (q) out[def.key] = q;
  }
  return out;
}

/**
 * Dhan: last_price only, for the NSE rows. Fallback when Kite is unavailable
 * (its token expires daily around 06:00 IST).
 *
 * Prefers a prev close cached earlier today; otherwise falls back to Dhan's own
 * `close` but only after flip-detection, so a post-close value is dropped rather
 * than reported as yesterday's.
 */
async function fromDhan(): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  const defs = INDICES.filter(i => i.dhanSid !== null);
  if (defs.length === 0) return out;

  const { clientId, token } = getDhanCredentials();
  if (!token) return out;

  const res = await fetch(DHAN_OHLC_URL, {
    method: 'POST',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ IDX_I: defs.map(d => d.dhanSid as number) }),
    signal: AbortSignal.timeout(6000),
  });
  const json = (await res.json()) as {
    status?: string;
    data?: Record<string, Record<string, { last_price?: number; ohlc?: { close?: number } }>>;
  };
  if (json.status !== 'success') return out;

  const seg = json.data?.IDX_I ?? {};
  const day = istToday();
  for (const def of defs) {
    const row = seg[String(def.dhanSid)];
    if (!row) continue;
    const ltp = Number(row.last_price ?? 0);
    const cached = prevCloseCache.get(`${day}:${def.key}`);
    const prev = cached ?? rejectFlippedClose(ltp, Number(row.ohlc?.close ?? 0));
    const q = mkQuote(ltp, prev, cached ? 'dhan+cache' : 'dhan');
    if (q) out[def.key] = q;
  }
  return out;
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const errors: string[] = [];
  let quotes: Record<string, Quote> = {};

  try {
    quotes = await fromKite(INDICES);
  } catch (e) {
    errors.push(`kite: ${String(e).slice(0, 120)}`);
  }

  // Only reach for Dhan if Kite left rows unserved — normally it serves all ten,
  // so this costs nothing in the happy path.
  const missing = INDICES.filter(d => !quotes[d.key]);
  if (missing.length > 0) {
    try {
      const dhan = await fromDhan();
      for (const def of missing) {
        if (dhan[def.key]) quotes[def.key] = dhan[def.key];
      }
    } catch (e) {
      errors.push(`dhan: ${String(e).slice(0, 120)}`);
    }
  }

  const body = {
    success: true,
    updated_at: new Date().toISOString(),
    // Definition order is returned so the client controls sorting and labels
    // without duplicating this list.
    order: INDICES.map(i => ({ key: i.key, label: i.label })),
    quotes,
    count: Object.keys(quotes).length,
    errors,
  };

  cache = { ts: Date.now(), body };
  return NextResponse.json(body);
}
