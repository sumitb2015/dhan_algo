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
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ accessToken, clientId, expiryTime }, null, 2)
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

/** True if access_token.json holds a non-expired Dhan access token. */
export function isDhanTokenValid(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!data.accessToken) return false;
    if (data.expiryTime && new Date(data.expiryTime) < new Date()) return false;
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
