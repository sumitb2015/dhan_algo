import path from 'path';
import fs from 'fs';
import { runPythonJson } from './pyExec.ts';
import { globalOnce } from './globalOnce.ts';

// Direct Kotak Neo REST from Node, mirroring lib/zerodhaToken.ts.
//
// Two things differ from every other broker here and both are load-bearing:
//
//  1. **The base URL is per user.** It comes back in the totp_validate response
//     (e.g. https://e21.kotaksecurities.com) and is persisted with the tokens.
//     There is no fixed host to fall back on, so a missing baseUrl means the
//     session is unusable, not that we should guess.
//  2. **"No data" is error-shaped.** positions/orders/trades return
//     {"stat":"Not_Ok","stCode":5203,"errMsg":"No Data"} instead of an empty
//     list. kotakPost treats that as an empty result, never as a failure —
//     reading it as an error would make an empty book look like an outage.
//
// The session is written by scripts/tools/kotak_autologin.py (and by the
// copy-trade bridge, which shares the same file). Node never logs in itself:
// Kotak binds one session per consumer-key/UCC, so a second login here would
// invalidate the bridge's.

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE = path.join(PROJECT_ROOT, 'kotak_access_token.json');

/** Kotak's "nothing to report" code, returned in place of an empty data list. */
export const KOTAK_NO_DATA = 5203;
/** Session expired — retrying the SAME session is pointless; see reloginKotak(). */
export const KOTAK_UNAUTHORIZED = 100008;
/** Session token is malformed/invalid — same recovery path as KOTAK_UNAUTHORIZED.
 *  Confirmed empirically: a corrupted token comes back as this code, not 100008. */
export const KOTAK_INVALID_SESSION = 100010;
/** Session token rejected by neo-login-check-api ("invalid session token"). */
export const KOTAK_INVALID_SESSION_TOKEN = 100022;

// REST paths, from the SDK's PROD_URL table.
export const KOTAK_PATHS = {
  placeOrder: 'quick/order/rule/ms/place',
  cancelOrder: 'quick/order/cancel',
  modifyOrder: 'quick/order/vr/modify',
  orderBook: 'quick/user/orders',
  tradeBook: 'quick/user/trades',
  // kotakneoapi 3.0.9 moved positions() here from quick/user/positions "per a backend endpoint update". Same row
  // fields plus `ltp` (verified live 2026-10-17); the old path still answered then.
  positions: 'portfolio/v2/positions',
  limits: 'quick/user/limits',
  // From the SDK's settings.py (portfolio_holdings: GET, Sid/Auth headers, NO sId — see NO_SERVER_ID_PATHS).
  holdings: 'portfolio/v1/holdings',
} as const;

// Paths the SDK calls WITHOUT the `sId` query parameter. Holdings answers HTTP 404 {"error": ...} when it is
// present and 200 with the book when it is not (verified live 2026-10-17), so a sell capped by holdings failed closed.
const NO_SERVER_ID_PATHS: ReadonlySet<string> = new Set([KOTAK_PATHS.holdings]);

export interface KotakSession {
  baseUrl: string;
  editToken: string;
  editSid: string;
  serverId: string;
  ucc?: string;
  consumerKey?: string;
}

interface KotakTokenCache extends KotakSession { ts: number; fileMtimeMs: number }
let cache: KotakTokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

/** True if the given ISO expiry timestamp is missing or in the past. */
export function isTokenExpired(expiryTime: string | undefined): boolean {
  if (!expiryTime) return true;
  return new Date(expiryTime) < new Date();
}

/** True if kotak_access_token.json holds a complete, non-expired session. */
export function isKotakTokenValid(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as Record<string, string>;
    // base_url matters as much as the token: without it there is nowhere to send
    // the request, so a session missing it is not usable.
    if (!data.edit_token || !data.edit_sid || !data.base_url) return false;
    return !isTokenExpired(data.expiryTime);
  } catch {
    return false;
  }
}

/**
 * Cached Kotak session for direct REST calls from Node.
 *
 * Invalidated on either the TTL OR the token file's mtime changing — same
 * reasoning as getZerodhaCredentials(): a fresh login while the server is
 * already running would otherwise keep serving a stale session for 5 minutes.
 */
export function getKotakSession(): KotakSession {
  let fileMtimeMs = 0;
  try { fileMtimeMs = fs.statSync(TOKEN_FILE).mtimeMs; } catch { /* fall through to full read */ }

  if (cache && cache.fileMtimeMs === fileMtimeMs && Date.now() - cache.ts < TOKEN_TTL) {
    const { baseUrl, editToken, editSid, serverId, ucc, consumerKey } = cache;
    return { baseUrl, editToken, editSid, serverId, ucc, consumerKey };
  }
  // Kotak is an optional broker — the token file legitimately not existing
  // (never run kotak_autologin.py) is routine, not a bug. Without this
  // check, fs.readFileSync below throws a raw ENOENT with a stack trace
  // pointing into a minified Next.js server chunk instead of here — see the
  // matching comment in zerodhaToken.ts's getZerodhaCredentials().
  if (!fs.existsSync(TOKEN_FILE)) {
    throw new Error('No Kotak session — run kotak_autologin.py');
  }
  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as Record<string, string>;
  if (!raw.edit_token || !raw.edit_sid || !raw.base_url) {
    throw new Error('No Kotak session — run kotak_autologin.py');
  }
  cache = {
    baseUrl: raw.base_url.replace(/\/+$/, ''),
    editToken: raw.edit_token,
    editSid: raw.edit_sid,
    serverId: raw.serverId ?? '',
    ucc: raw.ucc,
    consumerKey: raw.consumerKey,
    ts: Date.now(),
    fileMtimeMs,
  };
  const { baseUrl, editToken, editSid, serverId, ucc, consumerKey } = cache;
  return { baseUrl, editToken, editSid, serverId, ucc, consumerKey };
}

const RELOGIN_COOLDOWN_MS = 20_000;
let lastReloginAt = 0;
let reloginInFlight: Promise<boolean> | null = null;

/**
 * Kotak sessions can die mid-day (stCode 100008 'unauthorized') independent
 * of our locally tracked expiryTime — a broker-side quirk already documented
 * and handled on the Python side in scripts/tools/child_brokers.py's
 * KotakChild (one capped re-login; retrying the same session fixes nothing).
 * This is the Node-side twin: concurrent callers that hit a dead session in
 * the same window share one kotak_autologin.py spawn instead of each
 * starting their own, and a cooldown stops every poll tick from re-attempting
 * a login that is genuinely broken (revoked API key, TOTP drift) rather than
 * just stale.
 */
function reloginKotak(): Promise<boolean> {
  if (reloginInFlight) return reloginInFlight;
  if (Date.now() - lastReloginAt < RELOGIN_COOLDOWN_MS) return Promise.resolve(false);
  lastReloginAt = Date.now();
  reloginInFlight = (async () => {
    try {
      const scriptPath = path.join(PROJECT_ROOT, 'scripts', 'tools', 'kotak_autologin.py');
      const result = await runPythonJson<{ success: boolean; error?: string }>(scriptPath, ['--force'], 30_000);
      if (!result.success) return false;
      cache = null; // force getKotakSession() to re-read the just-refreshed file
      return true;
    } catch {
      return false;
    } finally {
      reloginInFlight = null;
    }
  })();
  return reloginInFlight;
}

/** True for any Kotak response signaling a dead session (expired or malformed token). */
export function isSessionDead(json: Record<string, unknown>): boolean {
  // stCode can live at either depth — mirrors lib/kotak/responses.py's
  // st_code() on the Python side. Checking only the top level would silently
  // skip the relogin-retry for any response shaped like {"data": {"stCode": ...}}.
  const data = (typeof json.data === 'object' && json.data !== null ? json.data : {}) as Record<string, unknown>;
  const code = json.stCode ?? data.stCode;
  if (code === KOTAK_UNAUTHORIZED || code === KOTAK_INVALID_SESSION || code === KOTAK_INVALID_SESSION_TOKEN) {
    return true;
  }
  const msg = String(json.errMsg ?? json.emsg ?? data.errMsg ?? data.emsg ?? '');
  const stat = String(json.stat ?? '');
  return /invalid\s*session|unauthorized|session\s*expired|token\s*expired/i.test(msg) || stat === 'error in neo-login-check-api';
}

function kotakUrl(apiPath: string): string {
  const { baseUrl, serverId } = getKotakSession();
  // `sId` is always sent, even when empty — that is what the Kotak SDK does, and
  // some accounts genuinely come back with an empty hsServerId. Omitting the
  // parameter on those accounts is an untested deviation from the working path.
  if (NO_SERVER_ID_PATHS.has(apiPath)) return `${baseUrl}/${apiPath}`;
  return `${baseUrl}/${apiPath}?sId=${encodeURIComponent(serverId ?? '')}`;
}

function authHeaders(): Record<string, string> {
  const { editToken, editSid, consumerKey } = getKotakSession();
  const headers: Record<string, string> = { Sid: editSid, Auth: editToken };
  // The official SDK sends this on order/modify/search calls but omits it on
  // plain reads (positions/limits/orders/trades) — see services/order.py vs.
  // services/positions.py in neo_api_client. Sending it unconditionally is
  // safe (the read endpoints simply ignore it) and avoids maintaining a
  // per-endpoint header table. Without it, order placement fails with a bare
  // "unauthorized" even under an otherwise perfectly valid session — this is
  // NOT the same failure reloginKotak() fixes, so don't remove this header
  // thinking the session-death handling above makes it redundant.
  if (consumerKey) headers.Authorization = consumerKey;
  return headers;
}

/**
 * Kotak ANSWERED and refused the request (an error-shaped body). Distinct from a timeout / network / unparseable reply,
 * where the request may still have been acted on: for an order, only this error means "nothing was placed".
 */
export class KotakRejectedError extends Error {
  constructor(message: string) { super(message); this.name = 'KotakRejectedError'; }
}

/** Throws on an error-shaped Kotak reply. `apiPath` only labels the log line (which call failed). Exported for tests. */
export function raiseIfError(json: Record<string, unknown>, apiPath = '?', quietRateLimit = false): void {
  if (json.stCode === KOTAK_NO_DATA) return;   // an empty book, not a failure
  if (json.error) {
    const errs = json.error;
    const message = Array.isArray(errs)
      ? errs.map(e => (e && typeof e === 'object' ? String((e as Record<string, unknown>).message ?? e) : String(e))).join('; ')
      : String(errs);
    console.error(`[kotakToken] request failed (${apiPath}), full response:`, JSON.stringify(json));
    throw new KotakRejectedError(message);
  }
  const data = (typeof json.data === 'object' && json.data !== null ? json.data : {}) as Record<string, unknown>;
  const msg = json.errMsg ?? json.emsg ?? data.errMsg ?? data.emsg;
  if (msg) {
    // A rate limit on a READ is retried by the read lane, which logs it itself; anything else (an order write's included) is logged in full.
    if (!(quietRateLimit && Number(json.stCode ?? data.stCode) === KOTAK_RATE_LIMIT)) console.error(`[kotakToken] request failed (${apiPath}), full response:`, JSON.stringify(json));
    // Surface the stCode alongside the message — Kotak reuses the same
    // errMsg text ("Unauthorized", etc.) across genuinely different stCodes,
    // and the bare message alone isn't enough to tell them apart later.
    const code = json.stCode ?? data.stCode;
    throw new KotakRejectedError(code !== undefined ? `${String(msg)} (stCode ${code})` : String(msg));
  }
  if (json.stat === 'Not_Ok') {
    console.error(`[kotakToken] request failed (${apiPath}), full response:`, JSON.stringify(json));
    throw new KotakRejectedError(`Kotak rejected the request (stCode ${json.stCode ?? '?'})`);
  }
}

// ─── One read lane for every Kotak read in the server process ──────────────────────────────────────────────────────
// Kotak answers stCode 100025 "rate limit exceeded" past a few requests a second ACROSS the account, and two dozen
// routes and watchers read it "live" with kotakGet (Fresh Money, Price Ladder, guards, scalper books...), each on its
// own clock. Every read (GET, and the read-only POSTs such as limits) now goes through one process-wide lane:
//   - reads START at least KOTAK_READ_GAP_MS apart, whoever sends them;
//   - a read of a path already on the wire is joined, but only if it was queued after the last order write, so an
//     exit's sizing read never gets a pre-order book;
//   - a 100025 pauses the whole lane for KOTAK_RATE_LIMIT_PAUSE_MS and the read retries (twice) instead of failing,
//     so a caller sees a short delay, not an error.
// Order writes (place / modify / cancel) never wait on this lane: they keep their own 400 ms order lane.
export const KOTAK_READ_GAP_MS = 350;
export const KOTAK_RATE_LIMIT_PAUSE_MS = 1_500;
const KOTAK_READ_RETRIES = 2;
type ReadLane = { nextAt: number; pausedUntil: number; lastWriteAt: number; inflight: Map<string, { queuedAt: number; p: Promise<Record<string, unknown>> }> };
const readLane = globalOnce<ReadLane>('__kotakReadLane', () => ({ nextAt: 0, pausedUntil: 0, lastWriteAt: 0, inflight: new Map() }));

/** The wait before the next read may start: after the previous read's slot plus `gap`, and not before a rate-limit pause ends. Pure apart from `state`. */
export function reserveReadSlot(state: { nextAt: number; pausedUntil: number }, now: number, gap = KOTAK_READ_GAP_MS): number {
  const at = Math.max(now, state.nextAt, state.pausedUntil);
  state.nextAt = at + gap;
  return at - now;
}

/** A Kotak 100025 rejection, as raiseIfError words it (`… (stCode 100025)`): matched on the stCode, not on any '100025' in a message. */
export const isKotakRateLimit = (err: unknown) => /stCode 100025\b/.test(String((err as Error)?.message ?? err));

/** Run one read through the lane: paced, retried after a rate limit (the lane pauses for everyone), joined when the same read is already on the wire. */
export async function laneRead(key: string, send: () => Promise<Record<string, unknown>>): Promise<Record<string, unknown>> {
  const on = readLane.inflight.get(key);
  // Strictly after: a read queued in the same millisecond as an order write may have been queued before it.
  if (on && on.queuedAt > readLane.lastWriteAt) return on.p;
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      // A slot reserved before another read hit the limit must not fire inside the pause it started: wait again.
      do {
        const wait = reserveReadSlot(readLane, Date.now());
        if (wait > 0) await new Promise(res => setTimeout(res, wait));
      } while (Date.now() < readLane.pausedUntil);
      try {
        return await send();
      } catch (err) {
        if (!isKotakRateLimit(err)) throw err;
        if (attempt >= KOTAK_READ_RETRIES) { console.error(`[kotakToken] ${key}: still rate limited after ${KOTAK_READ_RETRIES} retries — giving up`); throw err; }
        readLane.pausedUntil = Math.max(readLane.pausedUntil, Date.now() + KOTAK_RATE_LIMIT_PAUSE_MS);
        console.warn(`[kotakToken] rate limited on ${key} — every Kotak read paused ${KOTAK_RATE_LIMIT_PAUSE_MS} ms, retry ${attempt + 1}/${KOTAK_READ_RETRIES}`);
      }
    }
  };
  const entry = { queuedAt: Date.now(), p: run() };
  readLane.inflight.set(key, entry);
  void entry.p.finally(() => { if (readLane.inflight.get(key) === entry) readLane.inflight.delete(key); }).catch(() => {});
  return entry.p;
}

/** An order write is about to go out / just answered: no read queued before now may be joined from here on (it could carry the pre-order book). */
export function noteKotakOrderWrite(now = Date.now()): void { readLane.lastWriteAt = Math.max(readLane.lastWriteAt, now); }

/** Authenticated GET against the Kotak Neo REST API. Throws on error, `[]`-safe on an empty book. Paced through the read lane. */
export async function kotakGet(apiPath: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const doRequest = async () => {
    const res = await fetch(kotakUrl(apiPath), {
      headers: authHeaders(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json() as Record<string, unknown>;
  };
  return laneRead(`GET ${apiPath}`, async () => {
    let json = await doRequest();
    if (isSessionDead(json) && await reloginKotak()) {
      json = await doRequest();
    }
    raiseIfError(json, apiPath, true);
    return json;
  });
}

// Display polls (positions / orders / trades, every open tab every 2 s) share one Kotak call per path: Kotak answers
// stCode 100025 "rate limit exceeded" past a few requests a second, and every tab (plus the guard tickers) was making
// its own three. Concurrent callers join the call in flight; a result is reused for SHARED_GET_TTL_MS; after a 100025
// the same error is replayed for RATE_LIMIT_COOLDOWN_MS instead of hammering the limit. Anything that sizes an order
// off the book must keep calling `kotakGet` (always live) — and any order POST drops this cache, so a poll right
// after a placement never reads the pre-order book.
const SHARED_GET_TTL_MS = 1_200;
const RATE_LIMIT_COOLDOWN_MS = 3_000;
const KOTAK_RATE_LIMIT = 100025;
// One map per server PROCESS, not per bundle: Next compiles each route and the instrumentation watchers into separate
// bundles, and a module-level Map made the Price Ladder watcher, /api/dashboard/portfolio and the scalper poll each
// call portfolio/v2/positions on their own clock (stCode 100025 with two REAL Kotak ladder positions open, 2026-11-18).
type SharedGet = { at: number; json?: Record<string, unknown>; err?: unknown; inflight?: Promise<Record<string, unknown>> };
const sharedGets = globalOnce('__kotakSharedGets', () => new Map<string, SharedGet>());

// Order placement and an exit's position read are the only Kotak calls whose speed matters: display polls (books, P&L chips) yield to
// them. While a priority window is open a display read is served from its last result, or waits for the window to end, instead of
// spending the same per-second budget (a burst of polls right after an order is what produced stCode 100025 on the exit's own read).
// Shared through globalThis: Next bundles each route separately, and the order routes, the server watcher and the poll route must all see
// the same window and the same order lane.
type KotakLane = { priorityUntil: number; nextOrderAt: number };
const lane: KotakLane = ((globalThis as { __kotakLane?: KotakLane }).__kotakLane ??= { priorityUntil: 0, nextOrderAt: 0 });
export function kotakPriority(ms: number): void { lane.priorityUntil = Math.max(lane.priorityUntil, Date.now() + ms); }

/** Orders (place / modify / cancel) leave at least this far apart, whichever chart, page or watcher sends them. */
export const KOTAK_ORDER_GAP_MS = 400;
/**
 * The wait before an order may be sent: each order takes the next free slot, `gap` after the previous one's slot, so two charts flipping
 * in the same second go out 0.4 s apart instead of together (a burst of three order requests in 1-2 s produced an order Kotak never
 * answered). Only the START of the requests is spaced - a slow reply never holds the next order back. Pure apart from `state`.
 */
export function reserveOrderSlot(state: { nextOrderAt: number }, now: number, gap = KOTAK_ORDER_GAP_MS): number {
  const at = Math.max(now, state.nextOrderAt);
  state.nextOrderAt = at + gap;
  return at - now;
}
// The order and trade books are display reads (fills are confirmed through scalper/orders' own live read): they may be a few seconds old.
const SLOW_BOOK_TTL_MS = 4_000;
// Delivery holdings move only with a delivery trade: the portfolio chip's 5 s poll reused them for 30 s instead of adding a
// third Kotak call to every poll. Anything that sizes a sell off holdings (kotakContracts) keeps reading them live.
const HOLDINGS_TTL_MS = 30_000;
const ttlFor = (apiPath: string) => (apiPath === KOTAK_PATHS.holdings ? HOLDINGS_TTL_MS
  : apiPath === KOTAK_PATHS.orderBook || apiPath === KOTAK_PATHS.tradeBook ? SLOW_BOOK_TTL_MS : SHARED_GET_TTL_MS);

export async function kotakGetShared(apiPath: string): Promise<Record<string, unknown>> {
  const held = lane.priorityUntil - Date.now();
  if (held > 0) {
    const last = sharedGets.get(apiPath);
    if (last?.json) return last.json;
    await new Promise(res => setTimeout(res, held));
  }
  const hit = sharedGets.get(apiPath);
  if (hit?.inflight) return hit.inflight;
  if (hit) {
    const age = Date.now() - hit.at;
    if (hit.json && age < ttlFor(apiPath)) return hit.json;
    if (hit.err && age < RATE_LIMIT_COOLDOWN_MS) throw hit.err;
  }
  const inflight = kotakGet(apiPath).then(
    json => { sharedGets.set(apiPath, { at: Date.now(), json }); return json; },
    err => {
      // Only a rate limit is remembered; any other failure is retried by the next caller.
      if (isKotakRateLimit(err)) sharedGets.set(apiPath, { at: Date.now(), err });
      else sharedGets.delete(apiPath);
      throw err;
    },
  );
  sharedGets.set(apiPath, { at: hit?.at ?? 0, json: hit?.json, err: hit?.err, inflight });
  return inflight;
}

// POSTs that only READ, and so may be paced, retried after a rate limit and joined. An ALLOW-list on purpose: every
// other POST (place / modify / cancel, and any path added later) is treated as an order write — sent once, never
// retried or merged with another, through the order lane, and it drops the shared read cache.
const READ_POST_PATHS: ReadonlySet<string> = new Set([KOTAK_PATHS.limits]);

/**
 * Authenticated form-encoded POST against the Kotak Neo REST API.
 *
 * The body is wrapped in a SINGLE `jData` field holding the JSON payload —
 * Kotak does not accept flat form fields, and sending them returns HTTP 500 with
 * an empty body (verified against the live limits and order endpoints). This
 * mirrors RESTClientObject.request in the SDK, which does exactly
 * `request_body["jData"] = json.dumps(body)` for every x-www-form-urlencoded
 * POST. Everything that posts to Kotak must go through here.
 */
export async function kotakPost(
  apiPath: string,
  params: Record<string, string | number>,
  timeoutMs = 10_000,
): Promise<Record<string, unknown>> {
  const doRequest = async () => {
    const formBody = new URLSearchParams({ jData: JSON.stringify(params) });
    const res = await fetch(kotakUrl(apiPath), {
      method: 'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: formBody.toString(),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await res.json() as Record<string, unknown>;
  };

  const once = async () => {
    // Kotak rejects a request under a dead session outright rather than
    // silently accepting it (see reloginKotak's doc comment) — a retry after a
    // fresh login cannot double-place an order the first attempt never placed.
    let json = await doRequest();
    if (isSessionDead(json) && await reloginKotak()) {
      json = await doRequest();
    }
    return json;
  };
  if (READ_POST_PATHS.has(apiPath)) {
    // A read-only POST (limits): the read lane, joined only for an identical body.
    return laneRead(`POST ${apiPath} ${JSON.stringify(params)}`, async () => { const json = await once(); raiseIfError(json, apiPath); return json; });
  }
  const wait = reserveOrderSlot(lane, Date.now());
  kotakPriority(2_000 + wait);
  sharedGets.clear();
  if (wait > 0) await new Promise(res => setTimeout(res, wait));
  // From here no read queued earlier may be joined: it could answer with the pre-order book.
  noteKotakOrderWrite();
  const json = await once();
  sharedGets.clear();
  noteKotakOrderWrite();
  raiseIfError(json, apiPath);
  return json;
}

/**
 * Account limits/funds.
 *
 * Unlike positions/orders/trades (plain GETs), this endpoint is a form-encoded
 * POST with seg/exch/prod — a GET returns a non-JSON body that fails to parse.
 * Verified against the SDK's LimitsAPI.limit_init.
 */
export async function kotakLimits(timeoutMs = 10_000): Promise<Record<string, unknown>> {
  // A read-only POST, but it counts against the same limit as the GETs: after a 100025 replay the error for
  // RATE_LIMIT_COOLDOWN_MS rather than retrying on every poll (a failed fetch is not cached upstream).
  if (limitsRateLimit && Date.now() - limitsRateLimit.at < RATE_LIMIT_COOLDOWN_MS) throw limitsRateLimit.err;
  try {
    return await kotakPost(KOTAK_PATHS.limits, { seg: 'ALL', exch: 'ALL', prod: 'ALL' }, timeoutMs);
  } catch (err) {
    if (isKotakRateLimit(err)) limitsRateLimit = { at: Date.now(), err };
    throw err;
  }
}
let limitsRateLimit: { at: number; err: unknown } | null = null;

/** The row list from a positions/orders/trades response — `[]` when genuinely empty. */
export function kotakRows(json: Record<string, unknown>): Record<string, unknown>[] {
  if (json.stCode === KOTAK_NO_DATA) return [];
  const data = json.data;
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}
