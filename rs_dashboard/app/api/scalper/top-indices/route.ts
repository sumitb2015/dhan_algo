import { NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import path from 'path';
import fs from 'fs';
import { dedupe, runPythonJson, PROJECT_ROOT } from '@/lib/pyExec';

// Absolute: runPythonJson execs without a cwd, so a relative path would resolve
// against rs_dashboard/ rather than the project root and silently never run.
const OPTIONS_FETCH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');
const HUB_QUOTES_FILE = path.join(PROJECT_ROOT, 'debug', 'live_indices_quotes.json');

// Live LTP + % change vs yesterday's close for the headline indices, for the
// Advanced Scalper's Top Indices panel.
//
// The 9 NSE indices (everything except CRUDEOIL) are sourced from the shared
// market_data_hub.py WebSocket via scripts/tools/live_indices_ws.py, which
// now also writes debug/live_indices_quotes.json every 2s — see `fromHub`
// below. This used to be a REST call to Dhan's batched OHLC endpoint for
// every row on every poll; that endpoint is rate-limited to ~1 req/s and
// shared across every open tab/panel, and a rejected call blanked the whole
// panel for a cycle (see git history on this file, and lastGood below, which
// still guards whatever remains on the REST path). Moving the 9 real indices
// to the hub removes that rate-limit exposure almost entirely.
//
// CRUDEOIL stays on the REST path below: it's an MCX rolling future, not an
// NSE index (see futUnderlying/getFutSid) — live_indices_ws.py's catalogue is
// NSE indices only, and duplicating monthly-contract-roll resolution into the
// Python bridge isn't worth it for one row. `fromDhan` is still exactly what
// CRUDEOIL needs.
//
// Dhan is the ONLY source — Zerodha/Kite must never be used for market-data
// ingestion here (Dhan is the account of record for every calculation in this
// dashboard; Kite was previously used as a primary source for this panel, but
// that made every number on it depend on a second broker's session being
// alive). The two Dhan quirks that motivated that are handled directly
// instead — both still apply to CRUDEOIL's REST path (the hub path has its
// own, separate handling of quirk 1, in live_indices_ws.py):
//
//  1. Dhan's `ohlc.close` flips from yesterday's close to TODAY's close the
//     moment the 15:30 bell rings (measured 2026-07-30: at 14:5x NIFTY read
//     close=24250.20, correct; at 15:36 the same field read 24317.15 — equal
//     to the last price). Handled by `rejectFlippedClose` plus `prevCloseCache`:
//     a genuine close captured earlier in the session (or before 09:15, when
//     `ltp === close` is expected rather than a flip) is cached and reused for
//     the rest of the day, so a later flip can't overwrite it with a blank.
//     If nothing was ever cached today (e.g. the server started after 15:30),
//     `close` is unrecoverable — the flip already happened — so `fromDhan`
//     falls back to the daily-candle endpoint (`fetchLatestPrevClose`) for
//     yesterday's genuine close instead of N/A.
//  2. Dhan answers BSE_IDX with HTTP 200 but an EMPTY data object for this
//     account, so it cannot serve SENSEX — SENSEX is simply not in the row
//     list below (dropped in favour of MCX crude oil).
//
// Yesterday's close changes once per trading day, so it is cached per IST
// date: once a genuine value is captured, a later same-day flip still yields
// a correct percentage rather than a blank one.

const DHAN_OHLC_URL = 'https://api.dhan.co/v2/marketfeed/ohlc';
const DHAN_HISTORICAL_URL = 'https://api.dhan.co/v2/charts/historical';

interface IndexDef {
  /** Stable key used by the UI. */
  key: string;
  label: string;
  /** Dhan security id; null when it must be resolved at runtime (rolling futures). */
  dhanSid: number | null;
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
  { key: 'NIFTY',     label: 'Nifty 50',     dhanSid: 13 },
  { key: 'BANKNIFTY', label: 'Bank Nifty',   dhanSid: 25 },
  { key: 'FINNIFTY',  label: 'Fin Services', dhanSid: 27 },
  { key: 'IT',        label: 'IT',           dhanSid: 29 },
  { key: 'AUTO',      label: 'Auto',         dhanSid: 14 },
  { key: 'PHARMA',    label: 'Pharma',       dhanSid: 32 },
  { key: 'METAL',     label: 'Metal',        dhanSid: 31 },
  { key: 'REALTY',    label: 'Realty',       dhanSid: 34 },
  { key: 'VIX',       label: 'India VIX',    dhanSid: 21 },
  // Crude has no spot index and its contract ROLLS MONTHLY, so the security id
  // cannot be hardcoded — it is resolved once per IST day (see getFutSid below).
  { key: 'CRUDEOIL',  label: 'Crude Oil',    dhanSid: null,
    segment: 'MCX_COMM', futUnderlying: 'CRUDEOIL' },
];

// Split by data source. Keep in sync with live_indices_ws.py's ROUTE_KEY_MAP.
const WS_INDICES = INDICES.filter(i => i.key !== 'CRUDEOIL');
const REST_INDICES = INDICES.filter(i => i.key === 'CRUDEOIL');

interface Quote { ltp: number; prev_close: number; change_pct: number | null; source: string }

interface HubQuotesFile {
  updated_at?: string;
  quotes?: Record<string, { ltp?: number; prev_close?: number; change_pct?: number }>;
}

// A snapshot older than this is not "quiet", it's a dead/not-yet-started
// bridge — matches the STALE_MS the client already applies to the whole
// panel (lib/useLiveTickerPoll.ts), so a stale hub file degrades the same
// way a stale overall response would, rather than serving frozen numbers
// indefinitely under a fresh-looking response envelope.
const HUB_STALE_MS = 15_000;

/**
 * Reads live_indices_quotes.json (written every 2s by live_indices_ws.py off
 * the shared market_data_hub.py WebSocket) — no REST call, no rate limit.
 * Missing file (bridge never started) or stale file (bridge dead) both yield
 * {} for `wanted`, which GET() reports as `missing` rows rather than masking
 * it — that in turn is what triggers AdvancedScalper to start the bridge.
 */
function fromHub(wanted: IndexDef[]): Record<string, Quote> {
  const out: Record<string, Quote> = {};
  if (wanted.length === 0) return out;

  let parsed: HubQuotesFile | null;
  try {
    parsed = JSON.parse(fs.readFileSync(HUB_QUOTES_FILE, 'utf8')) as HubQuotesFile;
  } catch {
    return out; // file missing or unreadable — bridge not running yet
  }

  const updatedMs = parsed.updated_at ? new Date(parsed.updated_at).getTime() : NaN;
  if (!Number.isFinite(updatedMs) || Date.now() - updatedMs > HUB_STALE_MS) return out;

  for (const { key } of wanted) {
    const q = parsed.quotes?.[key];
    if (!q || !(Number(q.ltp) > 0)) continue;
    const prevClose = Number(q.prev_close) || 0;
    out[key] = {
      ltp: Number(q.ltp),
      prev_close: prevClose,
      change_pct: prevClose > 0 ? (Number(q.change_pct) ?? null) : null,
      source: 'hub',
    };
  }
  return out;
}

// Short TTL so several open tabs (or a re-render storm) collapse onto one
// upstream call. Kept well under the client's poll interval so it never
// degrades perceived freshness — it only removes duplicate work.
const CACHE_TTL_MS = 2000;

interface ResponseBody {
  success: true;
  updated_at: string;
  order: { key: string; label: string }[];
  quotes: Record<string, Quote>;
  count: number;
  errors: string[];
}

let cache: { ts: number; body: ResponseBody } | null = null;

// Last response that actually carried data (count > 0), kept separately from
// `cache` above. Dhan's OHLC call is shared across every open tab/panel
// against a ~1 req/s budget, so single-poll rejections are routine, not rare
// — without this, a rejected call fell through to an empty `quotes: {}`
// which the client renders as ten blank rows before the next poll (~3s
// later) repopulates them. That's a highly visible flash for a ~3-6s-old
// value that was still perfectly usable a moment ago.
//
// `updated_at` on the served fallback is deliberately left untouched (the
// original successful poll's timestamp, not "now") so useLiveTickerPoll's
// own staleness clock (STALE_MS = 15000) still correctly ages this into
// STALE if Dhan stays down for real, rather than this route perpetually
// claiming fresh data off a recycled snapshot.
let lastGood: ResponseBody | null = null;

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
 *
 * Before today's 15:30 bell, `close` still holds whatever the LAST flip wrote
 * — which is exactly yesterday's close, whether that's being read mid-session
 * (LTP has since moved away from it) or before market open (LTP hasn't moved
 * yet, so `ltp === close` is the EXPECTED state, not a flip artifact). Applying
 * the equality check pre-market rejected a correct prev_close as "flipped" on
 * every call before 09:15 whenever Dhan alone was serving the panel, zeroing
 * out % change for every row. So `close` is trusted unconditionally any time
 * before 15:30 today; the equality check only guards the window from the bell
 * itself onward, when `close` has just flipped to today's own value.
 */
function rejectFlippedClose(ltp: number, close: number, istMinutes: number = istMinutesOfDay()): number {
  if (close <= 0) return 0;
  if (istMinutes < MARKET_CLOSE_IST_MIN) return close;
  return close !== ltp ? close : 0;
}

function istMinutesOfDay(): number {
  const hhmm = new Date().toLocaleTimeString('en-GB', {
    timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

const MARKET_CLOSE_IST_MIN = 15 * 60 + 30;
// NSE cash/index session opens 09:15 IST. Before this, there is no "today" to
// compare against — see fromDhanPrevSessionChange for what's shown instead.
const MARKET_OPEN_IST_MIN = 9 * 60 + 15;

/** Resolve each def to a concrete Dhan security id + segment, dropping any
 *  rolling-futures row whose id hasn't been resolved yet. */
function resolveSids(defs: IndexDef[]): { def: IndexDef; sid: number; segment: string }[] {
  const resolved: { def: IndexDef; sid: number; segment: string }[] = [];
  for (const def of defs) {
    const sid = def.dhanSid ?? getFutSid(def);
    if (sid) resolved.push({ def, sid, segment: def.segment ?? 'IDX_I' });
  }
  return resolved;
}

function mkQuote(ltp: number, prevClose: number, source: string): Quote | null {
  if (!(ltp > 0)) return null;
  // A missing/zero prev_close makes any percentage meaningless — return null
  // for change_pct rather than a fabricated 0.00%.
  const pct = prevClose > 0 ? ((ltp - prevClose) / prevClose) * 100 : null;
  return { ltp, prev_close: prevClose, change_pct: pct, source };
}

/**
 * Dhan: last_price + prev close for every row, in one request.
 *
 * Prefers a prev close cached earlier today; otherwise falls back to Dhan's own
 * `close` but only after flip-detection, so a post-close value is dropped rather
 * than reported as yesterday's.
 */
async function fromDhan(wanted: IndexDef[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  if (wanted.length === 0) return out;

  const day = istToday();
  prunePrevCloseCache(day);

  const { clientId, token } = getDhanCredentials();
  if (!token) return out;

  // Resolve any rolling-futures ids first, then group by segment: Dhan's OHLC
  // endpoint takes several segments in ONE request, so crude costs no extra call.
  const resolved = resolveSids(wanted);
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

  const nowMin = istMinutesOfDay();

  for (const { def, sid, segment } of resolved) {
    const row = json.data?.[segment]?.[String(sid)];
    if (!row) continue;
    const ltp = Number(row.last_price ?? 0);
    const cached = prevCloseCache.get(`${day}:${def.key}`);
    const fresh = rejectFlippedClose(ltp, Number(row.ohlc?.close ?? 0), nowMin);
    let prev = cached ?? fresh;
    let source = cached ? 'dhan+cache' : 'dhan';

    // Post-close with nothing cached from earlier today (e.g. the server was
    // only started after 15:30): `close` now holds TODAY's close — the flip
    // already happened — so no reading of it can recover yesterday's value.
    // Fall back to the same daily-candle source `fromDhanPrevSessionChange`
    // uses pre-market (see `fetchLatestPrevClose` for why this needs a
    // different row-selection rule than that function).
    if (prev === 0 && nowMin >= MARKET_CLOSE_IST_MIN) {
      try {
        const instrument = segment === 'MCX_COMM' ? 'FUTCOM' : 'INDEX';
        const prevClose = await fetchLatestPrevClose(sid, segment, instrument, day);
        if (prevClose) {
          prev = prevClose;
          source = 'dhan-prevsession';
        }
      } catch {
        // Leave prev at 0 — mkQuote reports change_pct: null, the honest outcome.
      }
      await new Promise(r => setTimeout(r, HISTORICAL_STAGGER_MS));
    }

    // Cache a genuine close so a later flip (or an MCX session that runs past
    // the NSE bell) still yields a correct percentage rather than a blank one.
    if (!cached && prev > 0) prevCloseCache.set(`${day}:${def.key}`, prev);
    const q = mkQuote(ltp, prev, source);
    if (q) out[def.key] = q;
  }
  return out;
}

// Previous-session % change, keyed "<IST date>:<index key>". Computed once
// pre-market and reused for the rest of the pre-market window — the value it
// answers ("how did yesterday's session close vs the one before") cannot
// change again until tomorrow, so there is no reason to re-fetch it on every
// poll of a panel that gets hit every few seconds.
const prevDayChangeCache = new Map<string, Quote>();

function prunePrevDayChangeCache(day: string): void {
  for (const key of prevDayChangeCache.keys()) {
    if (!key.startsWith(`${day}:`)) prevDayChangeCache.delete(key);
  }
}

// Wide enough to survive the longest realistic NSE/MCX gap (a long weekend
// butted up against a holiday) while staying a small, fast request.
const LOOKBACK_DAYS = 12;
// Dhan's ~1 req/s guidance applies to the batched OHLC endpoint under
// continuous polling; this path runs once a day (cached below) but still
// issues one historical request per row, so a small stagger avoids bursting
// nine requests in the same instant.
const HISTORICAL_STAGGER_MS = 150;

/**
 * Fetches daily-candle closes for the last `LOOKBACK_DAYS` calendar days, as
 * {date, close} rows in IST-date order (oldest first). Dhan's daily-candle
 * endpoint only ever returns rows for days the exchange actually traded, so
 * callers get weekend/holiday skipping for free — no local calendar needed.
 */
async function fetchDailyCloses(
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
 * Before 09:15 IST there is no "today" yet — `fromDhan`'s live LTP still
 * mirrors yesterday's close (nothing has traded), so its % change is a
 * mathematically correct but useless 0.00% for every row. Pre-market, show
 * something informative instead: yesterday's full-session move against the
 * trading day before it (e.g. Friday vs Thursday across a weekend, or across
 * a holiday).
 */
async function fetchPrevSessionChange(
  sid: number, segment: string, instrument: string, today: string,
): Promise<{ ltp: number; prevClose: number } | null> {
  // Same-day row filtered out: this call site only makes sense over
  // COMPLETED sessions strictly before today (not observed pre-market, but
  // guarded regardless — see fetchLatestPrevClose for the post-close case,
  // where today's own row, once Dhan publishes it, is exactly what's wanted).
  const rows = (await fetchDailyCloses(sid, segment, instrument))?.filter(r => r.date < today);
  if (!rows || rows.length < 2) return null;
  const last = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  return last.close > 0 && prev.close > 0 ? { ltp: last.close, prevClose: prev.close } : null;
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
async function fetchLatestPrevClose(
  sid: number, segment: string, instrument: string, today: string,
): Promise<number | null> {
  const rows = (await fetchDailyCloses(sid, segment, instrument))?.filter(r => r.date < today);
  if (!rows || rows.length === 0) return null;
  const last = rows[rows.length - 1];
  return last.close > 0 ? last.close : null;
}

async function fromDhanPrevSessionChange(wanted: IndexDef[]): Promise<Record<string, Quote>> {
  const out: Record<string, Quote> = {};
  if (wanted.length === 0) return out;

  const day = istToday();
  prunePrevDayChangeCache(day);

  const resolved = resolveSids(wanted);
  for (const { def, sid, segment } of resolved) {
    const cacheKey = `${day}:${def.key}`;
    const cached = prevDayChangeCache.get(cacheKey);
    if (cached) {
      out[def.key] = cached;
      continue;
    }
    try {
      const instrument = segment === 'MCX_COMM' ? 'FUTCOM' : 'INDEX';
      const change = await fetchPrevSessionChange(sid, segment, instrument, day);
      if (change) {
        const q = mkQuote(change.ltp, change.prevClose, 'dhan-prevsession');
        if (q) {
          prevDayChangeCache.set(cacheKey, q);
          out[def.key] = q;
        }
      }
    } catch {
      // Leave this row out — GET() below has no per-row error channel, and a
      // missing row (rather than a stale/wrong one) is the honest outcome.
    }
    await new Promise(r => setTimeout(r, HISTORICAL_STAGGER_MS));
  }
  return out;
}

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  const errors: string[] = [];
  let quotes: Record<string, Quote> = {};
  const preMarket = istMinutesOfDay() < MARKET_OPEN_IST_MIN;

  if (preMarket) {
    // Pre-market "yesterday vs the day before" comparison needs Dhan's daily
    // candles regardless of row — the hub's live ticks haven't moved from
    // yesterday's close yet, so they can't answer this question either.
    try {
      quotes = await fromDhanPrevSessionChange(INDICES);
    } catch (e) {
      errors.push(`dhan: ${String(e).slice(0, 120)}`);
    }
  } else {
    // Two independent sources, each fails without taking the other down —
    // a CRUDEOIL REST rejection must never blank the 9 hub-sourced rows,
    // and vice versa.
    try {
      quotes = { ...quotes, ...fromHub(WS_INDICES) };
    } catch (e) {
      errors.push(`hub: ${String(e).slice(0, 120)}`);
    }
    try {
      quotes = { ...quotes, ...(await fromDhan(REST_INDICES)) };
    } catch (e) {
      errors.push(`dhan: ${String(e).slice(0, 120)}`);
    }
  }

  const count = Object.keys(quotes).length;

  // A transient rejection (count === 0 after a throw, or Dhan answering
  // "success" with nothing usable) is not the same claim as "the market has
  // no data" — serve the last good snapshot instead of blanking every row.
  // A genuine, sustained outage still surfaces correctly: `lastGood`'s
  // original `updated_at` keeps aging until STALE_MS trips client-side.
  if (count === 0 && lastGood) {
    const body: ResponseBody = { ...lastGood, errors: [...errors, ...lastGood.errors] };
    cache = { ts: Date.now(), body };
    return NextResponse.json(body);
  }

  const body: ResponseBody = {
    success: true,
    updated_at: new Date().toISOString(),
    // Definition order is returned so the client controls sorting and labels
    // without duplicating this list.
    order: INDICES.map(i => ({ key: i.key, label: i.label })),
    quotes,
    count,
    errors,
  };

  cache = { ts: Date.now(), body };
  if (count > 0) lastGood = body;
  return NextResponse.json(body);
}
