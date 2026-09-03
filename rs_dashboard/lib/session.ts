import path from 'path';
import fs from 'fs';
import { createHmac, randomUUID } from 'crypto';
import { COOKIE_SECRET, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE    = path.join(PROJECT_ROOT, 'access_token.json');
const SESSION_FILE  = path.join(PROJECT_ROOT, 'debug', 'session.json');

function readSessions(): Record<string, { clientId: string; createdAt: string; remember: boolean }> {
  try {
    const data = fs.readFileSync(SESSION_FILE, 'utf8');
    return JSON.parse(data).sessions ?? {};
  } catch {
    return {};
  }
}

function writeSessions(sessions: Record<string, unknown>) {
  const dir = path.dirname(SESSION_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(SESSION_FILE, JSON.stringify({ sessions }, null, 2));
}

/** Writes the shared Dhan access_token.json used by both the dashboard and Python scripts. */
export function writeDhanTokenFile(accessToken: string, clientId: string, expiryTime: string) {
  const createdAt = new Date().toISOString();
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ accessToken, clientId, expiryTime, createdAt }, null, 2)
  );
}

/**
 * Creates a new dashboard session: records it in debug/session.json and returns
 * the Set-Cookie header value string to attach to the response.
 */
export function createDashboardSession(clientId: string, remember: boolean): string {
  const uuid = randomUUID();
  const hmac = createHmac('sha256', COOKIE_SECRET).update(uuid).digest('hex');
  const cookieValue = `${uuid}.${hmac}`;

  const sessions = readSessions();
  sessions[uuid] = { clientId, createdAt: new Date().toISOString(), remember };
  writeSessions(sessions);

  const cookieParts = [
    `${SESSION_COOKIE}=${cookieValue}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ];
  if (remember) cookieParts.push(`Max-Age=${SESSION_MAX_AGE}`);

  return cookieParts.join('; ');
}

function getSessionStartIst(now = new Date()): Date {
  const istOffsetMs = (5 * 60 + 30) * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const year = istNow.getUTCFullYear();
  const month = istNow.getUTCMonth();
  const date = istNow.getUTCDate();
  const hour = istNow.getUTCHours();

  let sessionStartUtc = new Date(Date.UTC(year, month, date, 0, 30, 0, 0));
  if (hour < 6) {
    sessionStartUtc = new Date(sessionStartUtc.getTime() - 24 * 60 * 60 * 1000);
  }
  return sessionStartUtc;
}

function getTokenIssuedAt(data: { createdAt?: string; accessToken?: string; expiryTime?: string }): Date | null {
  if (data.createdAt) {
    const d = new Date(data.createdAt);
    if (!isNaN(d.getTime())) return d;
  }
  if (data.accessToken && typeof data.accessToken === 'string' && data.accessToken.includes('.')) {
    try {
      const parts = data.accessToken.split('.');
      if (parts[1]) {
        const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
        if (payload.iat && typeof payload.iat === 'number') {
          return new Date(payload.iat * 1000);
        }
      }
    } catch {
      // ignore
    }
  }
  if (data.expiryTime) {
    const d = new Date(data.expiryTime);
    if (!isNaN(d.getTime())) {
      return new Date(d.getTime() - 24 * 60 * 60 * 1000);
    }
  }
  return null;
}

/** True if access_token.json holds a non-expired Dhan access token from the current trading session. */
export function isDhanTokenValid(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!data.accessToken) return false;
    if (data.expiryTime && new Date(data.expiryTime) < new Date()) return false;

    const issuedAt = getTokenIssuedAt(data);
    if (issuedAt) {
      const sessionStart = getSessionStartIst();
      if (issuedAt < sessionStart) {
        return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/** True if the incoming request carries a validly-signed, known session cookie. */
export function hasValidSessionCookie(cookieValue: string | undefined): boolean {
  if (!cookieValue) return false;
  const [uuid, sig] = cookieValue.split('.');
  if (!uuid || !sig) return false;
  const expected = createHmac('sha256', COOKIE_SECRET).update(uuid).digest('hex');
  if (expected !== sig) return false;
  const sessions = readSessions();
  return !!sessions[uuid];
}
