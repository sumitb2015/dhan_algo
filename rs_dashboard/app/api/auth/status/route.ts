import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { createHmac } from 'crypto';
import { COOKIE_SECRET, SESSION_COOKIE } from '@/lib/auth';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE   = path.join(PROJECT_ROOT, 'access_token.json');
const SESSION_FILE = path.join(PROJECT_ROOT, 'debug', 'session.json');

function verifySession(cookieValue: string): string | null {
  const [uuid, sig] = cookieValue.split('.');
  if (!uuid || !sig) return null;
  const expected = createHmac('sha256', COOKIE_SECRET).update(uuid).digest('hex');
  return expected === sig ? uuid : null;
}

function isTokenValid(): boolean {
  try {
    const data = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    if (!data.accessToken) return false;
    if (data.expiryTime && new Date(data.expiryTime) < new Date()) return false;
    return true;
  } catch {
    return false;
  }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cookieHeader = req.cookies.get(SESSION_COOKIE)?.value;
  if (!cookieHeader) return NextResponse.json({ authenticated: false });

  const uuid = verifySession(cookieHeader);
  if (!uuid) return NextResponse.json({ authenticated: false });

  // Check session file
  try {
    const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    const session = data.sessions?.[uuid];
    if (!session) return NextResponse.json({ authenticated: false });
  } catch {
    return NextResponse.json({ authenticated: false });
  }

  // Cross-check that access_token.json is still valid
  if (!isTokenValid()) return NextResponse.json({ authenticated: false });

  return NextResponse.json({ authenticated: true });
}
