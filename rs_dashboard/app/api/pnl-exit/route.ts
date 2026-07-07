import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE   = path.join(PROJECT_ROOT, 'access_token.json');
const DHAN_PNL_EXIT = 'https://api.dhan.co/v2/pnlExit';

interface TokenCache { clientId: string; token: string; ts: number }
let tokenCache: TokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000;

function getToken(): { clientId: string; token: string } {
  if (tokenCache && Date.now() - tokenCache.ts < TOKEN_TTL) {
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  }
  
  // Read parent .env file to get client_id
  let envClientId = '';
  const envFile = path.join(PROJECT_ROOT, '.env');
  if (fs.existsSync(envFile)) {
    const content = fs.readFileSync(envFile, 'utf8');
    const match = content.match(/^client_id\s*=\s*["']?([^"'\r\n]+)["']?/m);
    if (match) {
      envClientId = match[1].trim();
    }
  }

  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
    dhanClientId?: string;
    clientId?: string;
    accessToken: string;
  };
  const clientId = envClientId || process.env.client_id || raw.dhanClientId || raw.clientId || '';
  tokenCache = { clientId, token: raw.accessToken, ts: Date.now() };
  return { clientId: tokenCache.clientId, token: tokenCache.token };
}

function dhanHeaders(clientId: string, token: string) {
  return {
    'access-token': token,
    'client-id': clientId,
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  };
}

export async function GET() {
  try {
    const { clientId, token } = getToken();
    const res  = await fetch(DHAN_PNL_EXIT, { headers: dhanHeaders(clientId, token) });
    const json = await res.json() as { status?: string; data?: unknown; remarks?: string };
    if (String(json.status).toUpperCase() === 'SUCCESS') {
      return NextResponse.json({ success: true, data: json.data });
    }
    return NextResponse.json({ success: false, error: json.remarks ?? 'Failed to retrieve P&L exit config' });
  } catch (err) {
    console.error('[/api/pnl-exit GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const { profitValue, lossValue, productTypes, enableKillSwitch } = await req.json() as {
      profitValue?: number;
      lossValue?: number;
      productTypes?: string[];
      enableKillSwitch?: boolean;
    };
    tokenCache = null; // always re-read token for mutating operations
    const { clientId, token } = getToken();
    const payload = {
      dhanClientId:    clientId,
      profitValue:     Number(profitValue ?? 0),
      lossValue:       Number(lossValue ?? 0),
      productType:     productTypes ?? ['INTRADAY'],
      enableKillSwitch: enableKillSwitch ?? false,
    };
    const res  = await fetch(DHAN_PNL_EXIT, {
      method:  'POST',
      headers: dhanHeaders(clientId, token),
      body:    JSON.stringify(payload),
    });
    const text = await res.text();
    console.error('[/api/pnl-exit POST] Dhan raw response:', res.status, text);
    let json: Record<string, unknown> = {};
    try { json = JSON.parse(text); } catch {}
    if (String(json.status).toUpperCase() === 'SUCCESS') return NextResponse.json({ success: true });
    const errMsg = (json.remarks ?? json.errorMessage ?? json.message ?? json.errorType ?? text) as string;
    return NextResponse.json({ success: false, error: errMsg || 'Failed to configure P&L exit' });
  } catch (err) {
    console.error('[/api/pnl-exit POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    tokenCache = null;
    const { clientId, token } = getToken();
    const res  = await fetch(DHAN_PNL_EXIT, {
      method:  'DELETE',
      headers: dhanHeaders(clientId, token),
    });
    const json = await res.json() as { status?: string; remarks?: string };
    if (String(json.status).toUpperCase() === 'SUCCESS') return NextResponse.json({ success: true });
    return NextResponse.json({ success: false, error: json.remarks ?? 'Failed to disable P&L exit' });
  } catch (err) {
    console.error('[/api/pnl-exit DELETE]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
