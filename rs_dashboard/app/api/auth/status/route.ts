import { NextRequest, NextResponse } from 'next/server';
import { SESSION_COOKIE } from '@/lib/auth';
import { hasValidSessionCookie, isDhanTokenValid } from '@/lib/session';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const cookieHeader = req.cookies.get(SESSION_COOKIE)?.value;
  if (!hasValidSessionCookie(cookieHeader)) return NextResponse.json({ authenticated: false });

  // Cross-check that access_token.json is still valid
  if (!isDhanTokenValid()) return NextResponse.json({ authenticated: false });

  return NextResponse.json({ authenticated: true });
}
