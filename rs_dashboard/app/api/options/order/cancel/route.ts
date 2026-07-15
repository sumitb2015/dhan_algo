import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE   = path.join(PROJECT_ROOT, 'access_token.json');
const DHAN_ORDERS  = 'https://api.dhan.co/v2/orders';

interface TokenCache { clientId: string; token: string; ts: number }
let tokenCache: TokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

function getToken(): { clientId: string; token: string } {
  if (tokenCache && Date.now() - tokenCache.ts < TOKEN_TTL) {
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  }

  let envClientId = '';
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8');
    const match = content.match(/^client_id\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (match) envClientId = match[1].trim();
  }

  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
    dhanClientId?: string;
    clientId?: string;
    accessToken: string;
  };
  const clientId = envClientId || process.env.client_id || raw.dhanClientId || raw.clientId || '';
  tokenCache = { clientId, token: raw.accessToken, ts: Date.now() };
  return { clientId, token: raw.accessToken };
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const { orderId } = await req.json().catch(() => ({})) as { orderId?: string };

  if (!orderId || !orderId.trim()) {
    return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
  }

  try {
    tokenCache = null; // force fresh token for mutations
    const { clientId, token } = getToken();

    const res = await fetch(`${DHAN_ORDERS}/${orderId}`, {
      method: 'DELETE',
      headers: {
        'access-token': token,
        'client-id': clientId,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
    });

    const text = await res.text();
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch {}

    // Dhan returns 202 with orderId on successful cancel
    if (res.ok || String(json.status).toUpperCase() === 'SUCCESS' || json.orderId) {
      return NextResponse.json({ success: true, orderId });
    }

    const errMsg = (json.remarks ?? json.errorMessage ?? json.message ?? text) as string;
    return NextResponse.json({ success: false, error: errMsg || `Broker returned ${res.status}` });

  } catch (err) {
    console.error('[options/order/cancel DELETE]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
