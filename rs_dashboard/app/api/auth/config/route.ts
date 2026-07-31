import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';
import { hasValidSessionCookie } from '@/lib/session';
import { SESSION_COOKIE } from '@/lib/auth';

const CONFIG_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'get_auth_config.py');

type FieldStatus = { set: boolean; masked?: string; value?: string };
type AuthConfig = Record<string, Record<string, FieldStatus>>;

/**
 * GET /api/auth/config          -> masked (which fields are configured)
 * GET /api/auth/config?reveal=1 -> plaintext values, SESSION REQUIRED
 *
 * The session check is done here rather than left to the middleware: this route
 * sits under /api/auth, which middleware.ts deliberately excludes from auth so
 * the login page can reach it before you have a session. That exemption is fine
 * for "is this field set", but the server binds 0.0.0.0 — so without this gate a
 * single unauthenticated request from anywhere on the network would return every
 * broker password, MPIN and TOTP seed, which is a complete 2FA bypass on all
 * three accounts.
 *
 * `canReveal` is echoed back so the UI can explain WHY it is still showing dots
 * rather than silently appearing broken.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const wantsReveal = req.nextUrl.searchParams.get('reveal') === '1';
  const authorized = hasValidSessionCookie(req.cookies.get(SESSION_COOKIE)?.value);
  const reveal = wantsReveal && authorized;

  try {
    const config = await runPythonJson<AuthConfig>(
      CONFIG_SCRIPT, reveal ? ['--reveal'] : [], 10_000,
    );
    return NextResponse.json(
      { ...config, revealed: reveal, canReveal: authorized },
      // Never let the browser or a proxy cache a response holding secrets.
      { headers: { 'Cache-Control': 'no-store' } },
    );
  } catch {
    return NextResponse.json({ error: 'Could not read auth configuration' }, { status: 500 });
  }
}
