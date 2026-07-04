import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { createHmac, randomUUID } from 'crypto';
import { COOKIE_SECRET, SESSION_COOKIE, SESSION_MAX_AGE } from '@/lib/auth';

const execFileAsync = promisify(execFile);

const PROJECT_ROOT    = path.resolve(process.cwd(), '..');
const PYTHON_EXE      = path.join(PROJECT_ROOT, 'venv', 'Scripts', 'pythonw.exe');
const VALIDATE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'validate_token.py');
const TOKEN_FILE      = path.join(PROJECT_ROOT, 'access_token.json');
const SESSION_FILE    = path.join(PROJECT_ROOT, 'debug', 'session.json');

function signSession(uuid: string): string {
  const hmac = createHmac('sha256', COOKIE_SECRET).update(uuid).digest('hex');
  return `${uuid}.${hmac}`;
}

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

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { client_id?: string; access_token?: string; remember?: boolean };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid request body' }, { status: 400 });
  }

  const { client_id, access_token, remember = false } = body;

  if (!client_id?.trim() || !access_token?.trim()) {
    return NextResponse.json({ success: false, error: 'client_id and access_token are required' }, { status: 400 });
  }
  if (access_token.trim().length < 10) {
    return NextResponse.json({ success: false, error: 'Access token appears too short' }, { status: 400 });
  }

  // Validate credentials via Python script
  let validationResult: { success: boolean; error?: string };
  try {
    const { stdout } = await execFileAsync(
      PYTHON_EXE,
      [VALIDATE_SCRIPT, client_id.trim(), access_token.trim()],
      { cwd: PROJECT_ROOT, timeout: 20_000, windowsHide: true }
    );
    const lines = stdout.trim().split('\n').filter(Boolean);
    validationResult = JSON.parse(lines[lines.length - 1]);
  } catch (err: unknown) {
    const e = err as { stdout?: string; message?: string };
    if (e.stdout) {
      try {
        const lines = String(e.stdout).trim().split('\n').filter(Boolean);
        validationResult = JSON.parse(lines[lines.length - 1]);
      } catch {
        return NextResponse.json({ success: false, error: 'Validation script failed to run' }, { status: 500 });
      }
    } else {
      return NextResponse.json({ success: false, error: 'Could not reach validation service' }, { status: 500 });
    }
  }

  if (!validationResult.success) {
    return NextResponse.json(
      { success: false, error: validationResult.error ?? 'Invalid credentials' },
      { status: 401 }
    );
  }

  // Write access_token.json (adds clientId so Python scripts can reference it)
  const expiryTime = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ accessToken: access_token.trim(), clientId: client_id.trim(), expiryTime }, null, 2)
  );

  // Create signed session cookie
  const uuid = randomUUID();
  const cookieValue = signSession(uuid);

  const sessions = readSessions();
  sessions[uuid] = { clientId: client_id.trim(), createdAt: new Date().toISOString(), remember };
  writeSessions(sessions);

  const cookieParts = [
    `${SESSION_COOKIE}=${cookieValue}`,
    'HttpOnly',
    'SameSite=Strict',
    'Path=/',
  ];
  if (remember) cookieParts.push(`Max-Age=${SESSION_MAX_AGE}`);

  const response = NextResponse.json({ success: true });
  response.headers.set('Set-Cookie', cookieParts.join('; '));
  return response;
}
