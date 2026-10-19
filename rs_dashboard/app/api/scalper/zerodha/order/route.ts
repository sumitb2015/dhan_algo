import { NextRequest, NextResponse } from 'next/server';
import { placeZerodhaOrderSliced } from '@/lib/zerodhaPlaceOrder';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { zerodhaLotCapError, zerodhaSnapPrice } from '@/lib/zerodhaOrderRules';
import { cachedZerodhaContract, slicesFor } from '@/lib/zerodhaContracts';

/** Products this route will book. CO/BO are excluded — Kite holds its own exit
 *  order against them, which a plain market order would leave dangling. */
const KITE_PRODUCTS = new Set(['MIS', 'NRML', 'CNC']);

const sideOf = (side: unknown): string => String(side).toUpperCase();

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
    /** Stop orders (orderType SL / SLM): the trigger the exchange watches. */
    triggerPrice?: number;
    exchange?: string;
    product?: string;
    /** Calling terminal, for the per-source lot cap (lib/kotakOrderRules SOURCE_LOT_CAPS). Absent = uncapped (closes). */
    source?: string;
  };

  const { tradingsymbol, quantity, side, orderType = 'MARKET', price = 0, exchange = 'NFO', product: productRaw, source } = body;

  // Reject an unrecognised product rather than coercing it to MIS. A close order
  // booked under the wrong product does not reduce the position — Kite opens a
  // fresh intraday one on the other side instead. Absent still defaults to MIS
  // so callers that never sent the field are unaffected.
  const product = productRaw === undefined ? 'MIS' : String(productRaw).toUpperCase();
  if (!KITE_PRODUCTS.has(product)) {
    return NextResponse.json(
      { success: false, error: `Unsupported product: ${productRaw} (expected ${[...KITE_PRODUCTS].join(' / ')})` },
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

  const orderTypeUpper = String(orderType).toUpperCase();
  const isLimitOrder = orderTypeUpper === 'LIMIT';
  const isStopLimit = orderTypeUpper === 'SL' || orderTypeUpper === 'STOP_LOSS';
  const isStopMarket = orderTypeUpper === 'SLM' || orderTypeUpper === 'SL-M' || orderTypeUpper === 'STOP_LOSS_MARKET';
  const isStop = isStopLimit || isStopMarket;
  if (!isLimitOrder && !isStop && orderTypeUpper !== 'MARKET') {
    return NextResponse.json({ success: false, error: `Unsupported order type: ${orderType}` }, { status: 400 });
  }
  if ((isLimitOrder || isStopLimit) && !(Number(price) > 0)) {
    return NextResponse.json({ success: false, error: `Invalid price for ${orderTypeUpper} order: ${price}` }, { status: 400 });
  }
  // A stop with no positive trigger must never fall through as a market order.
  const triggerNum = Number(body.triggerPrice) || 0;
  if (isStop && !(triggerNum > 0)) {
    return NextResponse.json({ success: false, error: `Invalid triggerPrice for ${orderTypeUpper} order: ${body.triggerPrice}` }, { status: 400 });
  }
  if (isStopLimit && (sideOf(side) === 'BUY' ? Number(price) < triggerNum : Number(price) > triggerNum)) {
    return NextResponse.json({ success: false, error: `${sideOf(side)} SL limit ${price} must be ${sideOf(side) === 'BUY' ? '>=' : '<='} its trigger ${triggerNum}` }, { status: 400 });
  }

  const contract = source || isLimitOrder || isStop ? cachedZerodhaContract(String(tradingsymbol)) : null;
  const capError = zerodhaLotCapError(qtyNum, source, String(tradingsymbol), contract);
  if (capError) return NextResponse.json({ success: false, error: capError }, { status: 400 });

  const params: Record<string, string | number> = {
    tradingsymbol,
    exchange,
    transaction_type: sideUpper,
    order_type: isStopLimit ? 'SL' : isStopMarket ? 'SL-M' : isLimitOrder ? 'LIMIT' : 'MARKET',
    quantity: qtyNum,
    product,
    validity: 'DAY',
  };
  if (isLimitOrder || isStopLimit) params.price = zerodhaSnapPrice(Number(price), contract);
  if (isStop) params.trigger_price = zerodhaSnapPrice(triggerNum, contract);
  if (!isLimitOrder && !isStopLimit) {
    // Zerodha rejects API market orders on options without market
    // protection; -1 = automatic system-managed protection band.
    params.market_protection = -1;
  }

  // Over the exchange freeze quantity an order is rejected outright: send whole-lot slices instead.
  const slices = slicesFor(String(tradingsymbol), qtyNum);
  // A resting stop is tracked by ONE order id, so it cannot be cut into several orders.
  if (isStop && slices.length > 1) {
    return NextResponse.json({ success: false, error: `A stop order of ${qtyNum} is above the exchange freeze quantity — use fewer lots (nothing was sent).` }, { status: 400 });
  }
  const r = await placeZerodhaOrderSliced(params, slices);
  if (r.status === 'placed') {
    invalidateBrokerCache('zerodha');
    return NextResponse.json({ success: true, order_id: r.orderId, ...(r.reconciled ? { reconciled: true } : {}) });
  }
  if (r.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: r.error }, { status: 504 });
  return NextResponse.json({ success: false, error: r.error });
}
