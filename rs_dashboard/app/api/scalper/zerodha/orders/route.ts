import { NextRequest, NextResponse } from 'next/server';
import { kiteGet, kiteDelete, kitePut, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { shapeZerodhaOrder } from '@/lib/zerodhaShape';
import { cachedZerodhaContract } from '@/lib/zerodhaContracts';
import { zerodhaSnapPrice } from '@/lib/zerodhaOrderRules';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

// Zerodha's order book in the Dhan route's shape (app/api/scalper/orders/route.ts), for scalperRoute(broker, 'orders').
// GET reads; DELETE cancels and PATCH re-prices a resting LIMIT (every Zerodha order here is variety 'regular').
export async function GET(): Promise<NextResponse> {
  if (!isZerodhaTokenValid()) {
    return NextResponse.json({ success: false, error: 'Zerodha not connected — run scripts/tools/zerodha_autologin.py' }, { status: 401 });
  }
  try {
    const orders = await kiteGet('/orders') as unknown;
    return NextResponse.json({ success: true, data: (Array.isArray(orders) ? orders : []).map(shapeZerodhaOrder) });
  } catch (err) {
    console.error('[/api/scalper/zerodha/orders] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch orders', detail: String((err as Error).message) }, { status: 500 });
  }
}

const notConnected = () => NextResponse.json({ success: false, error: 'Zerodha not connected — run scripts/tools/zerodha_autologin.py' }, { status: 401 });

// Cancel a resting order by id.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  if (!isZerodhaTokenValid()) return notConnected();
  try {
    const body = await req.json().catch(() => ({}));
    const orderId = String(body?.orderId ?? req.nextUrl.searchParams.get('orderId') ?? '');
    if (!/^[A-Za-z0-9-]+$/.test(orderId)) return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    const res = await kiteDelete(`/orders/regular/${encodeURIComponent(orderId)}`);
    invalidateBrokerCache('zerodha');
    return NextResponse.json({ success: true, data: res });
  } catch (err) {
    console.error('[/api/scalper/zerodha/orders DELETE] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to cancel order', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Modify a resting LIMIT order's price / quantity. The order is read first: its own symbol sets the tick the price snaps
// to, and anything that is not a LIMIT order is refused rather than turned into one.
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  if (!isZerodhaTokenValid()) return notConnected();
  try {
    const { orderId, price, quantity } = await req.json().catch(() => ({})) as { orderId?: string; price?: number; quantity?: number };
    const id = String(orderId ?? '');
    if (!/^[A-Za-z0-9-]+$/.test(id)) return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    const newPrice = Number(price);
    if (!(newPrice > 0)) return NextResponse.json({ success: false, error: `Invalid price: ${price}` }, { status: 400 });
    const qty = Number(quantity);
    if (!Number.isInteger(qty) || qty <= 0) return NextResponse.json({ success: false, error: `Invalid quantity: ${quantity}` }, { status: 400 });

    const book = await kiteGet('/orders') as Record<string, unknown>[];
    const order = (Array.isArray(book) ? book : []).find((o) => String(o.order_id) === id);
    if (!order) return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
    if (String(order.order_type).toUpperCase() !== 'LIMIT') {
      return NextResponse.json({ success: false, error: `Only a resting LIMIT order can be modified (this one is ${order.order_type})` }, { status: 400 });
    }
    const res = await kitePut(`/orders/regular/${encodeURIComponent(id)}`, {
      quantity: qty,
      price: zerodhaSnapPrice(newPrice, cachedZerodhaContract(String(order.tradingsymbol))),
      order_type: 'LIMIT',
      validity: 'DAY',
    });
    invalidateBrokerCache('zerodha');
    return NextResponse.json({ success: true, data: res });
  } catch (err) {
    console.error('[/api/scalper/zerodha/orders PATCH] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to modify order', detail: String((err as Error).message) }, { status: 500 });
  }
}
