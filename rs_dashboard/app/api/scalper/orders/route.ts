import { NextRequest, NextResponse } from 'next/server';
import { dhanGet, dhanPut, dhanDelete } from '@/lib/dhanToken';
import { kotakGet, kotakPost, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakOrderStatus } from '@/lib/kotakShape';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

// Kotak has no single-order endpoint, so every status read is a whole order-book call. Several confirm loops poll at
// once (one per leg, ~2.5/s each): share one in-flight/just-finished read so they cost the broker one call per window.
const KOTAK_BOOK_TTL_MS = 350;
let kotakBook: { at: number; p: Promise<Record<string, unknown>[]> } | null = null;
function sharedKotakOrderBook(): Promise<Record<string, unknown>[]> {
  if (kotakBook && Date.now() - kotakBook.at < KOTAK_BOOK_TTL_MS) return kotakBook.p;
  const p = kotakGet(KOTAK_PATHS.orderBook).then(kotakRows);
  kotakBook = { at: Date.now(), p };
  // A failed read must not be served to the next caller.
  p.catch(() => { if (kotakBook?.p === p) kotakBook = null; });
  return p;
}

// Direct Dhan REST call for fetching orders. With ?orderId= returns that one
// order's live status (used to confirm a fill before counting a leg as placed).
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const orderId = req.nextUrl.searchParams.get('orderId');
    const getBroker = req.nextUrl.searchParams.get('broker') || 'dhan';
    if (orderId) {
      if (!/^[A-Za-z0-9-]+$/.test(orderId)) {
        return NextResponse.json({ success: false, error: 'Invalid orderId' }, { status: 400 });
      }
      if (getBroker === 'kotak') {
        // Kotak has no single-order endpoint: find it in the order book. Same payload as Dhan's below.
        const book = await sharedKotakOrderBook();
        const o = book.find(r => String(r.nOrdNo ?? r.orderId ?? '') === orderId);
        if (!o) return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
        return NextResponse.json({ success: true, data: shapeKotakOrderStatus(o, orderId) });
      }
      if (getBroker !== 'dhan') {
        return NextResponse.json({ success: false, error: `Broker ${getBroker} order lookup not supported` }, { status: 400 });
      }
      const raw = await dhanGet(`/orders/${orderId}`, 5_000);
      // Dhan returns either the order object or a one-element array.
      const o = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
      if (!o || typeof o !== 'object') {
        return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
      }
      return NextResponse.json({
        success: true,
        data: {
          orderId: String(o.orderId ?? orderId),
          orderStatus: String(o.orderStatus ?? '').toUpperCase(),
          quantity: Number(o.quantity) || 0,
          filledQty: Number(o.filledQty) || 0,
          averageTradedPrice: Number(o.averageTradedPrice) || 0,
          reason: String(o.omsErrorDescription ?? o.omsErrorCode ?? ''),
        },
      });
    }
    const data = await dhanGet('/orders');
    return NextResponse.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    console.error('[/api/scalper/orders] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch orders', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Modify an existing pending order (e.g. change limit price or quantity).
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const {
      orderId,
      price,
      quantity,
      orderType = 'LIMIT',
      triggerPrice = 0,
      validity = 'DAY',
      legName = 'ENTRY_LEG',
      broker = 'dhan',
    } = body ?? {};

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

    if (broker === 'dhan') {
      const payload = {
        orderId: String(orderId),
        orderType: String(orderType).toUpperCase(),
        legName: String(legName).toUpperCase(),
        quantity: Math.round(qty),
        price: Number(newPrice.toFixed(2)),
        disclosedQuantity: 0,
        triggerPrice: Number(triggerPrice) || 0,
        validity: String(validity).toUpperCase(),
      };
      const res = await dhanPut(`/orders/${orderId}`, payload);
      return NextResponse.json({ success: true, data: res });
    }

    if (broker === 'kotak') {
      const res = await kotakPost(KOTAK_PATHS.modifyOrder, {
        no: String(orderId),
        pr: newPrice.toFixed(2),
        pt: String(orderType).toUpperCase() === 'MARKET' ? 'MKT' : String(orderType).toUpperCase().startsWith('SL') ? 'SL' : 'L',
        qt: String(Math.round(qty)),
        vd: String(validity).toUpperCase(),
        tp: String(Number(triggerPrice) || 0),
        dq: '0', mp: '0', am: 'NO', os: 'NEOTRADEAPI',
      });
      invalidateBrokerCache('kotak');
      return NextResponse.json({ success: true, data: res });
    }

    return NextResponse.json({ success: false, error: `Broker ${broker} order modification not yet supported` }, { status: 400 });
  } catch (err) {
    console.error('[/api/scalper/orders PATCH] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to modify order', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Cancel a pending order by ID.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json().catch(() => ({}));
    const searchParams = req.nextUrl.searchParams;
    const orderId = body?.orderId || searchParams.get('orderId');
    const broker = body?.broker || searchParams.get('broker') || 'dhan';

    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }

    if (broker === 'dhan') {
      const res = await dhanDelete(`/orders/${orderId}`);
      return NextResponse.json({ success: true, data: res });
    }

    if (broker === 'kotak') {
      const res = await kotakPost(KOTAK_PATHS.cancelOrder, { on: String(orderId), am: 'NO' });
      invalidateBrokerCache('kotak');
      return NextResponse.json({ success: true, data: res });
    }

    return NextResponse.json({ success: false, error: `Broker ${broker} order cancellation not yet supported` }, { status: 400 });
  } catch (err) {
    console.error('[/api/scalper/orders DELETE] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to cancel order', detail: String((err as Error).message) }, { status: 500 });
  }
}

