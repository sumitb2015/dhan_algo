import { NextRequest, NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';

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
    exchangeSegment?: string;
  };

  const { securityId, quantity, side, orderType = 'MARKET', price = 0, exchangeSegment = 'NSE_FNO' } = body;

  if (!securityId || !quantity || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: securityId, quantity, side' }, { status: 400 });
  }

  const qtyNum = Number(quantity);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
    return NextResponse.json({ success: false, error: `Invalid quantity: ${quantity} (must be a positive integer)` }, { status: 400 });
  }

  const sideUpper = String(side).toUpperCase();
  if (sideUpper !== 'BUY' && sideUpper !== 'SELL') {
    return NextResponse.json({ success: false, error: `Invalid side: ${side} (must be BUY or SELL)` }, { status: 400 });
  }

  const isLimitOrder = String(orderType).toUpperCase() === 'LIMIT';
  if (isLimitOrder && !(Number(price) > 0)) {
    return NextResponse.json({ success: false, error: `Invalid price for LIMIT order: ${price}` }, { status: 400 });
  }

  try {
    const { clientId, token } = getDhanCredentials();

    const payload = {
      dhanClientId:     clientId,
      transactionType:  sideUpper,
      exchangeSegment,
      productType:      'INTRADAY',
      orderType:        isLimitOrder ? 'LIMIT' : 'MARKET',
      validity:         'DAY',
      securityId:       String(securityId),
      quantity:         qtyNum,
      disclosedQuantity: 0,
      price:            isLimitOrder ? Number(price) : 0,
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
