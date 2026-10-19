import { NextRequest, NextResponse } from 'next/server';
import { kiteGet, kiteDelete, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { modifyZerodhaLimitOrder } from '@/lib/zerodhaModifyOrder';
import { shapeZerodhaOrder } from '@/lib/zerodhaShape';
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

// Modify a resting LIMIT order's price / quantity (rules in lib/zerodhaModifyOrder.ts).
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  if (!isZerodhaTokenValid()) return notConnected();
  try {
    const r = await modifyZerodhaLimitOrder(await req.json().catch(() => ({})));
    return r.ok ? NextResponse.json({ success: true, data: r.data }) : NextResponse.json({ success: false, error: r.error }, { status: r.status });
  } catch (err) {
    console.error('[/api/scalper/zerodha/orders PATCH] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to modify order', detail: String((err as Error).message) }, { status: 500 });
  }
}
