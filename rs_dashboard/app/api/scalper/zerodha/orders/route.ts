import { NextResponse } from 'next/server';
import { kiteGet, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { shapeZerodhaOrder } from '@/lib/zerodhaShape';

// Zerodha's order book in the Dhan route's shape (app/api/scalper/orders/route.ts), for scalperRoute(broker, 'orders').
// Read-only: modify / cancel stay unsupported for Zerodha (the shared /api/scalper/orders route refuses them).
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
