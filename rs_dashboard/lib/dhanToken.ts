import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE = path.join(PROJECT_ROOT, 'access_token.json');

interface TokenCache { clientId: string; token: string; ts: number; fileMtimeMs: number }
let tokenCache: TokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000; // re-read file at least every 5 min regardless

/**
 * Cached Dhan credentials for direct REST calls from Node (no Python spawn).
 * Reads client_id from the parent .env and the access token from access_token.json.
 *
 * Invalidated on either the TTL OR the token file's mtime changing — a bare
 * TTL alone would keep serving a stale (and, after a fresh login.py run,
 * actively revoked-by-Dhan) token from memory for up to 5 minutes after the
 * file was rewritten, since the long-running Next.js process has no other
 * way to notice a re-login happened.
 */
export function getDhanCredentials(): { clientId: string; token: string } {
  let fileMtimeMs = 0;
  try { fileMtimeMs = fs.statSync(TOKEN_FILE).mtimeMs; } catch { /* fall through to full read below */ }

  if (tokenCache && tokenCache.fileMtimeMs === fileMtimeMs && Date.now() - tokenCache.ts < TOKEN_TTL) {
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  }

  let envClientId = '';
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8');
    const match = content.match(/^client_id\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (match) {
      envClientId = match[1].trim();
    }
  }

  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
    dhanClientId?: string;
    clientId?: string;
    accessToken: string;
  };
  const clientId = envClientId || process.env.client_id || raw.dhanClientId || raw.clientId || '';
  tokenCache = { clientId, token: raw.accessToken, ts: Date.now(), fileMtimeMs };
  return { clientId: tokenCache.clientId, token: tokenCache.token };
}

const DHAN_BASE = 'https://api.dhan.co/v2';

/**
 * Authenticated GET against the Dhan REST API. Returns the parsed JSON body
 * (Dhan returns the payload directly — an array for /positions, /orders,
 * /trades; an object for /fundlimit, /pnlExit). Throws on non-2xx.
 */
export async function dhanGet(apiPath: string, timeoutMs = 10_000): Promise<unknown> {
  const { clientId, token } = getDhanCredentials();
  const res = await fetch(`${DHAN_BASE}${apiPath}`, {
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Accept': 'application/json',
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        detail = String(json.errorMessage ?? json.remarks ?? json.message ?? JSON.stringify(json));
      } catch {
        if (text.includes("CloudFront wasn't able to resolve the origin domain name")) {
          detail = 'HTTP 502 Bad Gateway (Dhan CloudFront origin DNS failure — broker outage)';
        } else if (res.status === 502) {
          detail = 'HTTP 502 Bad Gateway (Dhan backend servers unavailable)';
        }
      }
    } catch {}
    throw new Error(`Dhan GET ${apiPath} failed: ${detail}`);
  }
  return res.json();
}

/**
 * Authenticated POST against the Dhan REST API. Returns the parsed JSON body.
 * Auto-injects dhanClientId into the body. Throws on non-2xx.
 */
export async function dhanPost(
  apiPath: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const { clientId, token } = getDhanCredentials();
  const body = { ...payload, dhanClientId: clientId };
  const res = await fetch(`${DHAN_BASE}${apiPath}`, {
    method: 'POST',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        detail = String(json.errorMessage ?? json.remarks ?? json.message ?? JSON.stringify(json));
      } catch {
        if (text.includes("CloudFront wasn't able to resolve the origin domain name")) {
          detail = 'HTTP 502 Bad Gateway (Dhan CloudFront origin DNS failure — broker outage)';
        } else if (res.status === 502) {
          detail = 'HTTP 502 Bad Gateway (Dhan backend servers unavailable)';
        }
      }
    } catch {}
    throw new Error(`Dhan POST ${apiPath} failed: ${detail}`);
  }
  return res.json();
}

/**
 * Authenticated PUT against the Dhan REST API (used for order modifications).
 */
export async function dhanPut(
  apiPath: string,
  payload: Record<string, unknown> = {},
  timeoutMs = 10_000,
): Promise<unknown> {
  const { clientId, token } = getDhanCredentials();
  const body = { ...payload, dhanClientId: clientId };
  const res = await fetch(`${DHAN_BASE}${apiPath}`, {
    method: 'PUT',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        detail = String(json.errorMessage ?? json.remarks ?? json.message ?? JSON.stringify(json));
      } catch {
        if (text.includes("CloudFront wasn't able to resolve the origin domain name")) {
          detail = 'HTTP 502 Bad Gateway (Dhan CloudFront origin DNS failure — broker outage)';
        } else if (res.status === 502) {
          detail = 'HTTP 502 Bad Gateway (Dhan backend servers unavailable)';
        }
      }
    } catch {}
    throw new Error(`Dhan PUT ${apiPath} failed: ${detail}`);
  }
  // 204 No Content is a valid success — res.json() would throw on an empty body.
  if (res.status === 204) return {};
  return res.json();
}

/**
 * Authenticated DELETE against the Dhan REST API (used for order cancellations).
 * Dhan v2 requires dhanClientId in the JSON body (same as PUT) — sending only
 * the header is not sufficient and results in a DH-904 Invalid Request error.
 */
export async function dhanDelete(apiPath: string, timeoutMs = 10_000): Promise<unknown> {
  const { clientId, token } = getDhanCredentials();
  const res = await fetch(`${DHAN_BASE}${apiPath}`, {
    method: 'DELETE',
    headers: {
      'access-token': token,
      'client-id': clientId,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify({ dhanClientId: clientId }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const text = await res.text();
      try {
        const json = JSON.parse(text) as Record<string, unknown>;
        detail = String(json.errorMessage ?? json.remarks ?? json.message ?? JSON.stringify(json));
      } catch {
        if (text.includes("CloudFront wasn't able to resolve the origin domain name")) {
          detail = 'HTTP 502 Bad Gateway (Dhan CloudFront origin DNS failure — broker outage)';
        } else if (res.status === 502) {
          detail = 'HTTP 502 Bad Gateway (Dhan backend servers unavailable)';
        }
      }
    } catch {}
    throw new Error(`Dhan DELETE ${apiPath} failed: ${detail}`);
  }
  // 204 No Content is a valid success — res.json() would throw on an empty body,
  // causing the UI to show "cancel failed" even though the order was cancelled.
  if (res.status === 204) return {};
  return res.json();
}


