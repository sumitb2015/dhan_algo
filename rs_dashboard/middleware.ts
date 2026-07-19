import { NextRequest, NextResponse } from 'next/server';
import { COOKIE_SECRET, SESSION_COOKIE } from '@/lib/auth';

// Edge Runtime — cannot use Node.js fs. Session validity is encoded in the
// HMAC-signed cookie value: "<uuid>.<hmac-sha256(uuid, SECRET)>".
// The session.json lookup (deeper validation) happens in the status route.

async function verifySessionCookie(cookieValue: string): Promise<boolean> {
  const dotIdx = cookieValue.lastIndexOf('.');
  if (dotIdx === -1) return false;
  const uuid = cookieValue.slice(0, dotIdx);
  const sig   = cookieValue.slice(dotIdx + 1);
  if (!uuid || !sig) return false;

  // Web Crypto API — available in Edge Runtime
  const enc     = new TextEncoder();
  const keyMat  = await crypto.subtle.importKey('raw', enc.encode(COOKIE_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sigBuf  = await crypto.subtle.sign('HMAC', keyMat, enc.encode(uuid));
  const expected = Array.from(new Uint8Array(sigBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  return expected === sig;
}

export async function middleware(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  const cookieValue = req.cookies.get(SESSION_COOKIE)?.value;

  console.log(`[middleware] path: ${pathname}, hasCookie: ${!!cookieValue}`);

  if (cookieValue && await verifySessionCookie(cookieValue)) {
    return NextResponse.next();
  }

  // Do not redirect API requests to the login HTML page; return a 401 JSON response instead!
  if (pathname.startsWith('/api/')) {
    console.log(`[middleware] unauthorized API request: ${pathname} - returning 401`);
    return new NextResponse(JSON.stringify({ success: false, error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  console.log(`[middleware] redirecting to /login from: ${pathname}`);
  const loginUrl = new URL('/login', req.url);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    '/((?!login|api/auth|api/scalper/zerodha/lookup|_next/static|_next/image|favicon.ico).*)',
  ],
};
