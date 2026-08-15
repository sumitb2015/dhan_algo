import { NextRequest, NextResponse } from 'next/server';
import { kotakPost, KOTAK_PATHS } from '@/lib/kotakToken';

/** Products this route will book. CO/BO are excluded — Neo holds its own exit
 *  order against them, which a plain market order would leave dangling. */
const NEO_PRODUCTS = new Set(['MIS', 'NRML', 'CNC']);

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ready: true });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json() as {
    tradingsymbol: string;
    quantity: number;
    side: string;
    orderType?: string;
    price?: number;
    exchange?: string;
    product?: string;
  };

  const {
    tradingsymbol, quantity, side,
    orderType = 'MARKET', price = 0,
    exchange = 'nse_fo', product: productRaw,
  } = body;

  // Reject an unrecognised product rather than coercing it to MIS. A close order
  // booked under the wrong product does not reduce the position — Neo opens a
  // fresh intraday one on the other side instead. Absent still defaults to MIS
  // so callers that never sent the field are unaffected.
  const product = productRaw === undefined ? 'MIS' : String(productRaw).toUpperCase();
  if (!NEO_PRODUCTS.has(product)) {
    return NextResponse.json(
      { success: false, error: `Unsupported product: ${productRaw} (expected ${[...NEO_PRODUCTS].join(' / ')})` },
      { status: 400 },
    );
  }

  if (!tradingsymbol || !quantity || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: tradingsymbol, quantity, side' }, { status: 400 });
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

  // NSE/BSE options trade in Rs 0.05 ticks — snap so the exchange never rejects
  // an otherwise-valid limit price.
  const tickPrice = isLimitOrder ? (Math.round(Number(price) / 0.05) * 0.05).toFixed(2) : '0';

  try {
    const json = await kotakPost(KOTAK_PATHS.placeOrder, {
      es: String(exchange).toLowerCase(),          // exchange segment
      pc: product,                                  // product code
      pr: tickPrice,                                // price
      pt: isLimitOrder ? 'L' : 'MKT',               // price type
      qt: String(qtyNum),                           // absolute quantity, not lots
      rt: 'DAY',                                    // retention/validity
      ts: tradingsymbol,                            // trading symbol
      tt: sideUpper === 'BUY' ? 'B' : 'S',          // transaction type
      am: 'NO',
      dq: '0',
      mp: '0',
      pf: 'N',
      tp: '0',
      os: 'NEOTRADEAPI',
    });

    const data = (typeof json.data === 'object' && json.data !== null ? json.data : {}) as Record<string, unknown>;
    const orderId = json.nOrdNo ?? data.nOrdNo;
    if (json.stat === 'Ok' && orderId) {
      return NextResponse.json({ success: true, order_id: String(orderId) });
    }
    // kotakPost already throws on an error-shaped body; reaching here means the
    // response was neither an error nor a confirmed placement, which is worth
    // surfacing verbatim rather than reporting as success.
    return NextResponse.json({ success: false, error: `Unexpected Kotak response: ${JSON.stringify(json)}` });
  } catch (err) {
    console.error('[scalper/kotak/order] error:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) });
  }
}
