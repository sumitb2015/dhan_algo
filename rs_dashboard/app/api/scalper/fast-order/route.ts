import { NextRequest, NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';

/** Products this route will book. CNC is included so a delivery position can be
 *  closed under its own product; CO/BO are excluded because the broker holds its
 *  own exit order against them. */
const DHAN_PRODUCTS = new Set(['INTRADAY', 'MARGIN', 'CNC']);

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
    productType?: string;
  };

  const { securityId, quantity, side, orderType = 'MARKET', price = 0, exchangeSegment = 'NSE_FNO', productType: productTypeRaw } = body;

  // Reject an unrecognised product rather than coercing it to INTRADAY. A close
  // order booked under the wrong product does not reduce the position — the
  // broker opens a fresh intraday one on the other side instead. Absent still
  // defaults to INTRADAY so callers that never sent the field are unaffected.
  const productType = productTypeRaw === undefined
    ? 'INTRADAY'
    : String(productTypeRaw).toUpperCase();
  if (!DHAN_PRODUCTS.has(productType)) {
    return NextResponse.json(
      { success: false, error: `Unsupported productType: ${productTypeRaw} (expected ${[...DHAN_PRODUCTS].join(' / ')})` },
      { status: 400 },
    );
  }

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
      productType,
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
