import { NextRequest, NextResponse } from 'next/server';
import { kotakGet, kotakPost, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakOrder } from '@/lib/kotakShape';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

// Kotak's order book, shaped to the same { orderId, tradingSymbol, orderStatus,
// transactionType, quantity, price, orderType, createTime } contract as the
// Dhan route (app/api/scalper/orders/route.ts) so the Order Book UI can poll
// either broker through one interface.
export async function GET(): Promise<NextResponse> {
  try {
    const orders = await kotakGet(KOTAK_PATHS.orderBook);
    return NextResponse.json({ success: true, data: kotakRows(orders).map(shapeKotakOrder) });
  } catch (err) {
    console.error('[/api/scalper/kotak/orders] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch orders', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Modify an existing pending order (change limit price or quantity).
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const { orderId, price, quantity, orderType = 'LIMIT', triggerPrice = 0, validity = 'DAY' } = body ?? {};

    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }
    const newPrice = Number(price);
    if (isNaN(newPrice) || newPrice <= 0) {
      return NextResponse.json({ success: false, error: `Invalid price: ${price}` }, { status: 400 });
    }
    const qty = Number(quantity);
    if (isNaN(qty) || qty <= 0) {
      return NextResponse.json({ success: false, error: `Invalid quantity: ${quantity}` }, { status: 400 });
    }

    // Field names per neo_api_client's ModifyOrder.quick_modification — same
    // "os"/"am" conventions as placing an order (see lib/kotakToken.ts's
    // authHeaders() comment on why Authorization is required here too).
    const res = await kotakPost(KOTAK_PATHS.modifyOrder, {
      no: String(orderId),
      pr: newPrice.toFixed(2),
      pt: String(orderType).toUpperCase() === 'MARKET' ? 'MKT' : 'L',
      qt: String(Math.round(qty)),
      vd: String(validity).toUpperCase(),
      tp: String(Number(triggerPrice) || 0),
      dq: '0',
      mp: '0',
      am: 'NO',
      os: 'NEOTRADEAPI',
    });

    invalidateBrokerCache('kotak');
    return NextResponse.json({ success: true, data: res });
  } catch (err) {
    console.error('[/api/scalper/kotak/orders PATCH] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to modify order', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Cancel a pending order by ID.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json().catch(() => ({}));
    const orderId = body?.orderId || req.nextUrl.searchParams.get('orderId');

    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }

    const res = await kotakPost(KOTAK_PATHS.cancelOrder, { on: String(orderId), am: 'NO' });
    invalidateBrokerCache('kotak');
    return NextResponse.json({ success: true, data: res });
  } catch (err) {
    console.error('[/api/scalper/kotak/orders DELETE] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to cancel order', detail: String((err as Error).message) }, { status: 500 });
  }
}
