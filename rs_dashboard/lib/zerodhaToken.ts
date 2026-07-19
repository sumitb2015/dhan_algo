import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE = path.join(PROJECT_ROOT, 'zerodha_access_token.json');
const ENV_FILE = path.join(PROJECT_ROOT, '.env.zerodha');
const KITE_BASE = 'https://api.kite.trade';

interface ZerodhaTokenCache { apiKey: string; accessToken: string; ts: number }
let cache: ZerodhaTokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

/** True if the given ISO expiry timestamp is missing or in the past. */
export function isTokenExpired(expiryTime: string | undefined): boolean {
  if (!expiryTime) return true;
  return new Date(expiryTime) < new Date();
}

/** True if zerodha_access_token.json holds a non-expired access token. */
export function isZerodhaTokenValid(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
      accessToken?: string;
      expiryTime?: string;
    };
    if (!data.accessToken) return false;
    return !isTokenExpired(data.expiryTime);
  } catch {
    return false;
  }
}

function readApiKey(): string {
  if (!fs.existsSync(ENV_FILE)) return '';
  const content = fs.readFileSync(ENV_FILE, 'utf8');
  const match = content.match(/^ZERODHA_API_KEY\s*=\s*"?([^"\r\n]+)"?/m);
  return match ? match[1].trim() : '';
}

/**
 * Cached Zerodha credentials for direct REST calls from Node (no Python spawn).
 * Reads the api key from .env.zerodha and the access token from zerodha_access_token.json.
 */
export function getZerodhaCredentials(): { apiKey: string; accessToken: string } {
  if (cache && Date.now() - cache.ts < TOKEN_TTL) {
    return { apiKey: cache.apiKey, accessToken: cache.accessToken };
  }
  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as { accessToken: string };
  const apiKey = readApiKey();
  cache = { apiKey, accessToken: raw.accessToken, ts: Date.now() };
  return { apiKey: cache.apiKey, accessToken: cache.accessToken };
}

function authHeaders(): Record<string, string> {
  const { apiKey, accessToken } = getZerodhaCredentials();
  return {
    Authorization: `token ${apiKey}:${accessToken}`,
    'X-Kite-Version': '3',
  };
}

/** Authenticated GET against the Kite Connect REST API. Returns the `data` payload. Throws on non-2xx. */
export async function kiteGet(apiPath: string, timeoutMs = 10_000): Promise<unknown> {
  const res = await fetch(`${KITE_BASE}${apiPath}`, {
    headers: authHeaders(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok || json.status === 'error') {
    throw new Error(String(json.message ?? `HTTP ${res.status}`));
  }
  return json.data;
}

/** Authenticated form-encoded POST against the Kite Connect REST API. Returns the `data` payload. Throws on non-2xx. */
export async function kitePost(
  apiPath: string,
  params: Record<string, string | number>,
  timeoutMs = 10_000,
): Promise<unknown> {
  const formBody = new URLSearchParams(
    Object.entries(params).map(([k, v]) => [k, String(v)]),
  );
  const res = await fetch(`${KITE_BASE}${apiPath}`, {
    method: 'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' },
    body: formBody.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const json = await res.json() as Record<string, unknown>;
  if (!res.ok || json.status === 'error') {
    throw new Error(String(json.message ?? `HTTP ${res.status}`));
  }
  return json.data;
}
