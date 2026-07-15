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
    if (match) {
      envClientId = match[1].trim();
    }
  }

  const raw = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as {
    dhanClientId?: string;
    clientId?: string;
    accessToken: string;
  };

  // Prefer .env > process.env > JWT-embedded dhanClientId > file clientId
  // NOTE: access_token.json 'clientId' field may contain a phone number, not the Dhan client ID
  // Always prefer dhanClientId (which is the actual Dhan account ID embedded in the JWT)
  const clientId = envClientId || process.env.client_id || raw.dhanClientId || raw.clientId || '';
  tokenCache = { clientId, token: raw.accessToken, ts: Date.now() };
  return { clientId, token: raw.accessToken };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json().catch(() => null) as {
    legs?: { securityId: string; quantity: number; side: 'BUY' | 'SELL'; exchangeSegment?: string }[];
    mode?: 'intraday' | 'positional';
  } | null;

  if (!body || !body.legs || !Array.isArray(body.legs) || body.legs.length === 0) {
    return NextResponse.json({ success: false, error: 'legs array is required' }, { status: 400 });
  }

  const { legs, mode = 'intraday' } = body;

  // Validate every leg before touching the broker — fail fast with a clear message
  const invalidLegs: string[] = [];
  for (const leg of legs) {
    if (!leg.securityId || String(leg.securityId) === 'null' || String(leg.securityId).trim() === '') {
      invalidLegs.push(`leg ${leg.securityId ?? 'unknown'}: missing securityId (option chain data may not have loaded yet)`);
    }
    if (!Number.isFinite(leg.quantity) || leg.quantity <= 0) {
      invalidLegs.push(`leg ${leg.securityId}: invalid quantity=${leg.quantity}`);
    }
  }
  if (invalidLegs.length > 0) {
    return NextResponse.json({
      success: false,
      error: `Cannot place order — invalid leg(s): ${invalidLegs.join('; ')}`,
    }, { status: 400 });
  }

  try {
    const { clientId, token } = getToken();
    const productType = mode === 'positional' ? 'MARGIN' : 'INTRADAY';

    const orderPromises = legs.map(async (leg) => {
      const payload = {
        dhanClientId:     clientId,
        transactionType:  leg.side,
        exchangeSegment:  leg.exchangeSegment || 'NSE_FNO',
        productType,
        orderType:        'MARKET',
        validity:         'DAY',
        securityId:       String(leg.securityId),
        quantity:         Number(leg.quantity),
        disclosedQuantity: 0,
        price:            0,
        afterMarketOrder: false,
        boProfitValue:    0,
        boStopLossValue:  0,
        triggerPrice:     0,
      };

      try {
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

        const json = await res.json() as Record<string, any>;
        const orderId = String(json.orderId ?? json.data?.orderId ?? '');
        if (orderId) {
          return { success: true, orderId, securityId: leg.securityId };
        }
        return { success: false, error: json.remarks ?? json.message ?? JSON.stringify(json), securityId: leg.securityId };
      } catch (e) {
        return { success: false, error: String(e), securityId: leg.securityId };
      }
    });

    const results = await Promise.all(orderPromises);
    const failures = results.filter(r => !r.success);

    if (failures.length > 0) {
      return NextResponse.json({
        success: false,
        error: `Failed to place some orders: ${failures.map(f => `${f.securityId}: ${f.error}`).join(', ')}`,
        data: results
      });
    }

    return NextResponse.json({ success: true, data: results });

  } catch (err) {
    console.error('[options/order] error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
