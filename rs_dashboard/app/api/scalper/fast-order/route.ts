import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';

const PROJECT_ROOT = path.resolve(process.cwd(), '..');
const TOKEN_FILE   = path.join(PROJECT_ROOT, 'access_token.json');
const DHAN_ORDERS  = 'https://api.dhan.co/v2/orders';

interface TokenCache { clientId: string; token: string; ts: number }
let tokenCache: TokenCache | null = null;
const TOKEN_TTL = 5 * 60 * 1000; // re-read file every 5 min in case of token refresh

function getToken(): { clientId: string; token: string } {
  if (tokenCache && Date.now() - tokenCache.ts < TOKEN_TTL) {
    return { clientId: tokenCache.clientId, token: tokenCache.token };
  }
  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
    dhanClientId: string;
    accessToken: string;
  };
  tokenCache = { clientId: raw.dhanClientId, token: raw.accessToken, ts: Date.now() };
  return { clientId: tokenCache.clientId, token: tokenCache.token };
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ready: true });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json() as {
    securityId: string;
    quantity: number;
    side: string;
    orderType?: string;
    price?: number;
  };

  const { securityId, quantity, side, orderType = 'MARKET', price = 0 } = body;

  if (!securityId || !quantity || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: securityId, quantity, side' }, { status: 400 });
  }

  try {
    const { clientId, token } = getToken();
    const isLimit = String(orderType).toUpperCase() === 'LIMIT';

    const payload = {
      dhanClientId:     clientId,
      transactionType:  String(side).toUpperCase(),
      exchangeSegment:  'NSE_FNO',
      productType:      'INTRADAY',
      orderType:        isLimit ? 'LIMIT' : 'MARKET',
      validity:         'DAY',
      securityId:       String(securityId),
      quantity:         Number(quantity),
      disclosedQuantity: 0,
      price:            isLimit ? Number(price) : 0,
      afterMarketOrder: false,
      boProfitValue:    0,
      boStopLossValue:  0,
      triggerPrice:     0,
    };

    const res = await fetch(DHAN_ORDERS, {
      method:  'POST',
      headers: {
        'access-token':  token,
        'client-id':     clientId,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify(payload),
    });

    const json = await res.json() as Record<string, unknown>;

    // Dhan order API returns {orderId, orderStatus:"TRANSIT"} on success — no "status" field
    const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
    if (orderId) {
      return NextResponse.json({ success: true, order_id: orderId });
    }

    const errMsg = String(json.remarks ?? json.message ?? JSON.stringify(json));
    console.error('[scalper/fast-order] Dhan API error:', errMsg, 'HTTP', res.status);
    return NextResponse.json({ success: false, error: errMsg });

  } catch (err) {
    console.error('[scalper/fast-order] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
