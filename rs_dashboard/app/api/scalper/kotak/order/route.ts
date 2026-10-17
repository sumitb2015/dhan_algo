import { NextRequest, NextResponse } from 'next/server';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { kotakDerivativeBySymbol } from '@/lib/kotakContracts';
import { kotakUnderlyingOf } from '@/lib/kotakPositionContracts';
import { snapToTick, sourceLotCapError } from '@/lib/kotakOrderRules';

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
    /** Stop orders (orderType SL / SLM): the trigger the exchange watches. */
    triggerPrice?: number;
    exchange?: string;
    product?: string;
    /** Calling terminal, for SOURCE_LOT_CAPS. Absent = uncapped (closes, other desks). */
    source?: string;
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

  const orderTypeUpper = String(orderType).toUpperCase();
  const isStopLimit = orderTypeUpper === 'SL' || orderTypeUpper === 'STOP_LOSS';
  const isStopMarket = orderTypeUpper === 'SLM' || orderTypeUpper === 'STOP_LOSS_MARKET';
  const isLimitOrder = orderTypeUpper === 'LIMIT' || isStopLimit;
  if (isLimitOrder && !(Number(price) > 0)) {
    return NextResponse.json({ success: false, error: `Invalid price for ${orderTypeUpper} order: ${price}` }, { status: 400 });
  }
  // A stop with no positive trigger must never fall through as a market order.
  const triggerNum = Number(body.triggerPrice) || 0;
  if ((isStopLimit || isStopMarket) && !(triggerNum > 0)) {
    return NextResponse.json({ success: false, error: `Invalid triggerPrice for ${orderTypeUpper} order: ${body.triggerPrice}` }, { status: 400 });
  }
  const sideForCheck = String(side).toUpperCase();
  if (isStopLimit && (sideForCheck === 'BUY' ? Number(price) < triggerNum : Number(price) > triggerNum)) {
    return NextResponse.json({ success: false, error: `${sideForCheck} ${orderTypeUpper} limit ${price} must be ${sideForCheck === 'BUY' ? '>=' : '<='} its trigger ${triggerNum}` }, { status: 400 });
  }

  const isDerivative = /_fo$/i.test(String(exchange));
  const underlying = isDerivative ? kotakUnderlyingOf(String(tradingsymbol)) : null;
  const contract = underlying ? kotakDerivativeBySymbol(String(tradingsymbol), underlying) : null;

  // Per-source lot cap (lib/kotakOrderRules): only callers that name a source, on opening orders.
  const capError = sourceLotCapError(qtyNum, body.source, String(tradingsymbol), contract?.lotSize ?? null);
  if (capError) return NextResponse.json({ success: false, error: capError }, { status: 400 });

  // Snap derivative prices to the contract's own tick so the exchange never rejects an otherwise-valid price (an MCX
  // future ticks at 1.00). A cash-equity price (nse_cm, ticks down to 0.01) is the caller's own, already on the stock's
  // tick, and is only rounded to paise.
  const snap = (v: number) => snapToTick(v, contract?.tick);
  const tickPrice = !isLimitOrder ? '0'
    : isDerivative ? snap(Number(price))
    : (Math.round(Number(price) * 100) / 100).toFixed(2);

  const orderPayload = {
    es: String(exchange).toLowerCase(),          // exchange segment
    pc: product,                                  // product code
    pr: tickPrice,                                // price
    pt: isStopLimit ? 'SL' : isStopMarket ? 'SL-M' : isLimitOrder ? 'L' : 'MKT',  // price type
    qt: String(qtyNum),                           // absolute quantity, not lots
    rt: 'DAY',                                    // retention/validity
    ts: tradingsymbol,                            // trading symbol
    tt: sideUpper === 'BUY' ? 'B' : 'S',          // transaction type
    am: 'NO',
    dq: '0',
    mp: '0',
    pf: 'N',
    tp: (isStopLimit || isStopMarket) ? (isDerivative ? snap(triggerNum) : (Math.round(triggerNum / 0.05) * 0.05).toFixed(2)) : '0',  // trigger price
    os: 'NEOTRADEAPI',
  };
  console.log('[scalper/kotak/order] payload →', JSON.stringify(orderPayload));
  const r = await placeKotakOrder(orderPayload);
  console.log('[scalper/kotak/order] outcome ←', JSON.stringify(r));
  if (r.status === 'placed') {
    invalidateBrokerCache('kotak');
    return NextResponse.json({ success: true, order_id: r.orderId, ...(r.reconciled ? { reconciled: true } : {}) });
  }
  if (r.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: r.error }, { status: 504 });
  return NextResponse.json({ success: false, error: r.error });
}
