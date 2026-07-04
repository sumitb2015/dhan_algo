import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { createHmac } from 'crypto';
import { COOKIE_SECRET, SESSION_COOKIE } from '@/lib/auth';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const SESSION_FILE = path.join(PROJECT_ROOT, 'debug', 'session.json');

function verifySession(cookieValue: string): string | null {
  const [uuid, sig] = cookieValue.split('.');
  if (!uuid || !sig) return null;
  const expected = createHmac('sha256', COOKIE_SECRET).update(uuid).digest('hex');
  return expected === sig ? uuid : null;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const cookieValue = req.cookies.get(SESSION_COOKIE)?.value;

  if (cookieValue) {
    const uuid = verifySession(cookieValue);
    if (uuid) {
      try {
        const data = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
        if (data.sessions?.[uuid]) {
          delete data.sessions[uuid];
          fs.writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
        }
      } catch {
        // Session file missing or malformed — proceed with cookie clear
      }
    }
  }

  const response = NextResponse.json({ success: true });
  response.headers.set('Set-Cookie', `${SESSION_COOKIE}=; Max-Age=0; Path=/; HttpOnly; SameSite=Strict`);
  return response;
}
