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
      const json = await res.json() as Record<string, unknown>;
      detail = String(json.errorMessage ?? json.remarks ?? json.message ?? JSON.stringify(json));
    } catch {}
    throw new Error(`Dhan GET ${apiPath} failed: ${detail}`);
  }
  return res.json();
}
