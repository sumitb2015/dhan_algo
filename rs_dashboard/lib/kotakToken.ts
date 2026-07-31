import path from 'path';
import fs from 'fs';

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
/** Session expired/invalid — re-login required, retrying is pointless. */
export const KOTAK_UNAUTHORIZED = 100008;

// REST paths, from the SDK's PROD_URL table.
export const KOTAK_PATHS = {
  placeOrder: 'quick/order/rule/ms/place',
  cancelOrder: 'quick/order/cancel',
  modifyOrder: 'quick/order/vr/modify',
  orderBook: 'quick/user/orders',
  tradeBook: 'quick/user/trades',
  positions: 'quick/user/positions',
  limits: 'quick/user/limits',
} as const;

export interface KotakSession {
  baseUrl: string;
  editToken: string;
  editSid: string;
  serverId: string;
  ucc?: string;
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
    const { baseUrl, editToken, editSid, serverId, ucc } = cache;
    return { baseUrl, editToken, editSid, serverId, ucc };
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
    ts: Date.now(),
    fileMtimeMs,
  };
  const { baseUrl, editToken, editSid, serverId, ucc } = cache;
  return { baseUrl, editToken, editSid, serverId, ucc };
}

function kotakUrl(apiPath: string): string {
  const { baseUrl, serverId } = getKotakSession();
  // `sId` is always sent, even when empty — that is what the Kotak SDK does, and
  // some accounts genuinely come back with an empty hsServerId. Omitting the
  // parameter on those accounts is an untested deviation from the working path.
  return `${baseUrl}/${apiPath}?sId=${encodeURIComponent(serverId ?? '')}`;
}

function authHeaders(): Record<string, string> {
  const { editToken, editSid } = getKotakSession();
  return { Sid: editSid, Auth: editToken };
}

function raiseIfError(json: Record<string, unknown>): void {
  if (json.stCode === KOTAK_NO_DATA) return;   // an empty book, not a failure
  if (json.error) {
    const errs = json.error;
    const message = Array.isArray(errs)
      ? errs.map(e => (e && typeof e === 'object' ? String((e as Record<string, unknown>).message ?? e) : String(e))).join('; ')
      : String(errs);
    throw new Error(message);
  }
  const data = (typeof json.data === 'object' && json.data !== null ? json.data : {}) as Record<string, unknown>;
  const msg = json.errMsg ?? json.emsg ?? data.errMsg ?? data.emsg;
  if (msg) throw new Error(String(msg));
  if (json.stat === 'Not_Ok') throw new Error(`Kotak rejected the request (stCode ${json.stCode ?? '?'})`);
}

/** Authenticated GET against the Kotak Neo REST API. Throws on error, `[]`-safe on an empty book. */
export async function kotakGet(apiPath: string, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const res = await fetch(kotakUrl(apiPath), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json() as Record<string, unknown>;
  raiseIfError(json);
  return json;
}

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
  const formBody = new URLSearchParams({ jData: JSON.stringify(params) });
  const res = await fetch(kotakUrl(apiPath), {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json() as Record<string, unknown>;
  raiseIfError(json);
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
  return kotakPost(KOTAK_PATHS.limits, { seg: 'ALL', exch: 'ALL', prod: 'ALL' }, timeoutMs);
}

/** The row list from a positions/orders/trades response — `[]` when genuinely empty. */
export function kotakRows(json: Record<string, unknown>): Record<string, unknown>[] {
  if (json.stCode === KOTAK_NO_DATA) return [];
  const data = json.data;
  return Array.isArray(data) ? data as Record<string, unknown>[] : [];
}
