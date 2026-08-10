import { NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import { kiteGet } from '@/lib/zerodhaToken';
import path from 'path';
import { dedupe, runPythonJson, PROJECT_ROOT } from '@/lib/pyExec';

// Absolute: runPythonJson execs without a cwd, so a relative path would resolve
// against rs_dashboard/ rather than the project root and silently never run.
const OPTIONS_FETCH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');

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
  /** Dhan security id; null when it must be resolved at runtime (rolling futures). */
  dhanSid: number | null;
  /** Kite instrument string. Empty when Kite cannot serve this row. */
  kiteSymbol: string;
  /** Dhan segment. MCX_COMM rows are commodity futures, not indices. */
  segment?: 'IDX_I' | 'MCX_COMM';
  /** Underlying to resolve a nearest-future security id for, via `futsid`. */
  futUnderlying?: string;
}

// Ten headline rows. Order here is the display order when % change is equal;
// the panel itself sorts by % change. Edit this list to change what's shown.
//
// SENSEX was removed in favour of MCX crude oil. Note the panel is therefore no
// longer purely indices — CRUDEOIL is the nearest MCX futures contract.
const INDICES: IndexDef[] = [
  { key: 'NIFTY',     label: 'Nifty 50',     dhanSid: 13, kiteSymbol: 'NSE:NIFTY 50' },
  { key: 'BANKNIFTY', label: 'Bank Nifty',   dhanSid: 25, kiteSymbol: 'NSE:NIFTY BANK' },
  { key: 'FINNIFTY',  label: 'Fin Services', dhanSid: 27, kiteSymbol: 'NSE:NIFTY FIN SERVICE' },
  { key: 'IT',        label: 'IT',           dhanSid: 29, kiteSymbol: 'NSE:NIFTY IT' },
  { key: 'AUTO',      label: 'Auto',         dhanSid: 14, kiteSymbol: 'NSE:NIFTY AUTO' },
  { key: 'PHARMA',    label: 'Pharma',       dhanSid: 32, kiteSymbol: 'NSE:NIFTY PHARMA' },
  { key: 'METAL',     label: 'Metal',        dhanSid: 31, kiteSymbol: 'NSE:NIFTY METAL' },
  { key: 'REALTY',    label: 'Realty',       dhanSid: 34, kiteSymbol: 'NSE:NIFTY REALTY' },
  { key: 'VIX',       label: 'India VIX',    dhanSid: 21, kiteSymbol: 'NSE:INDIA VIX' },
  // Crude has no spot index and its contract ROLLS MONTHLY, so the security id
  // cannot be hardcoded — it is resolved once per IST day (see crudeSid below).
  // Kite is skipped for this row: its MCX tradingsymbol embeds the expiry
  // (MCX:CRUDEOIL25AUGFUT), which would need an instruments dump to build, so
  // Dhan serves it directly from the MCX_COMM segment instead.
  { key: 'CRUDEOIL',  label: 'Crude Oil',    dhanSid: null, kiteSymbol: '',
    segment: 'MCX_COMM', futUnderlying: 'CRUDEOIL' },
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

// ── Rolling-futures security ids, resolved once per IST day ──────────────────
// A futures security id is only valid until the contract expires, so it cannot be
// hardcoded like an index id. Resolving it costs a Python spawn (~1.5s, mostly
// master-list load), which is far too slow for a panel the scalper polls every
// few seconds — so it is resolved once per day and reused. `dedupe` collapses
// the concurrent first-hit from several open tabs onto one spawn.
const futSidCache = new Map<string, number>();
let futResolveFailedFor = '';

/**
 * Cached security id for a rolling futures contract, or null if not resolved yet.
 *
 * NON-BLOCKING by design. Resolution costs a ~2.5s Python spawn, and awaiting it
 * inside the request would hold up the nine index rows too — measured: the first
 * request after a restart returned zero rows instead of nine. Instead the miss
 * kicks off resolution in the background and returns null, so this poll serves
 * the indices immediately and crude appears on the next one (~2s later).
 */
function getFutSid(def: IndexDef): number | null {
  const under = def.futUnderlying;
  if (!under) return null;
  const day = istToday();
  const key = `${day}:${under}`;

  const hit = futSidCache.get(key);
  if (hit) return hit;
  // One failed resolution per day is enough; without this a permanently
  // unresolvable contract would spawn Python on every single poll.
  if (futResolveFailedFor === key) return null;

  // Fire and forget. `dedupe` collapses concurrent pollers onto one spawn, and
  // the .catch keeps a rejected promise from surfacing as an unhandled rejection.
  void dedupe(`futsid:${key}`, () =>
    runPythonJson<{ security_id?: number; error?: string }>(
      OPTIONS_FETCH,
      ['futsid', '--underlying', under],
      20_000,
    ))
    .then(out => {
      const sid = Number(out?.security_id ?? 0);
      if (sid > 0) {
        for (const k of futSidCache.keys()) {
          if (!k.startsWith(`${day}:`)) futSidCache.delete(k);
        }
        futSidCache.set(key, sid);
      } else {
        futResolveFailedFor = key;
      }
    })
    .catch(() => { futResolveFailedFor = key; });

  return null;
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
async function fromDhan(wanted: IndexDef[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  if (wanted.length === 0) return out;

  const { clientId, token } = getDhanCredentials();
  if (!token) return out;

  // Resolve any rolling-futures ids first, then group by segment: Dhan's OHLC
  // endpoint takes several segments in ONE request, so crude costs no extra call.
  const resolved: { def: IndexDef; sid: number; segment: string }[] = [];
  for (const def of wanted) {
    const sid = def.dhanSid ?? getFutSid(def);
    if (sid) resolved.push({ def, sid, segment: def.segment ?? 'IDX_I' });
  }
  if (resolved.length === 0) return out;

  const body: Record<string, number[]> = {};
  for (const r of resolved) (body[r.segment] ??= []).push(r.sid);

  const res = await fetch(DHAN_OHLC_URL, {
    method: 'POST',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(6000),
  });
  const json = (await res.json()) as {
    status?: string;
    Data?: unknown;
    data?: Record<string, Record<string, { last_price?: number; ohlc?: { close?: number } }>>;
  };
  // Throw rather than return {}: GET records the reason in `errors`, which the
  // panel surfaces as a tooltip. Returning empty silently made an occasional
  // blank panel unexplainable — and with Dhan's ~1 req/s OHLC limit and several
  // pollers sharing this route, a rejected call is exactly what tends to happen.
  if (json.status !== 'success') {
    throw new Error(`ohlc ${res.status}: ${JSON.stringify(json.Data ?? json.status).slice(0, 120)}`);
  }

  const day = istToday();
  for (const { def, sid, segment } of resolved) {
    const row = json.data?.[segment]?.[String(sid)];
    if (!row) continue;
    const ltp = Number(row.last_price ?? 0);
    const cached = prevCloseCache.get(`${day}:${def.key}`);
    const fresh = rejectFlippedClose(ltp, Number(row.ohlc?.close ?? 0));
    // Cache a genuine close so a later flip (or an MCX session that runs past
    // the NSE bell) still yields a correct percentage rather than a blank one.
    if (!cached && fresh > 0) prevCloseCache.set(`${day}:${def.key}`, fresh);
    const prev = cached ?? fresh;
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
    // Rows with no Kite symbol (crude) are excluded — asking Kite for an empty
    // instrument string makes it reject the whole batch, blanking all ten rows.
    quotes = await fromKite(INDICES.filter(d => d.kiteSymbol));
  } catch (e) {
    errors.push(`kite: ${String(e).slice(0, 120)}`);
  }

  // Dhan serves whatever Kite could not — normally just crude, so this is one
  // extra call rather than a fallback for the whole panel.
  const missing = INDICES.filter(d => !quotes[d.key]);
  if (missing.length > 0) {
    try {
      const dhan = await fromDhan(missing);
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
