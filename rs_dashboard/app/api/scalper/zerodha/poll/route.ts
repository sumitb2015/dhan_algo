import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition, shapeZerodhaOrder, shapeZerodhaTrade } from '@/lib/zerodhaShape';

export async function GET(): Promise<NextResponse> {
  try {
    const [positions, orders, trades] = await Promise.all([
      kiteGet('/portfolio/positions').catch(() => ({ net: [] })) as Promise<{ net: any[] }>,
      kiteGet('/orders').catch(() => []) as Promise<any[]>,
      kiteGet('/trades').catch(() => []) as Promise<any[]>,
    ]);

    return NextResponse.json({
      success: true,
      positions: (positions.net ?? []).map(shapeZerodhaPosition),
      orders: (Array.isArray(orders) ? orders : []).map(shapeZerodhaOrder),
      trades: (Array.isArray(trades) ? trades : []).map(shapeZerodhaTrade),
    });
  } catch (err) {
    console.error('[scalper/zerodha/poll] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to poll data', detail: String((err as Error).message) }, { status: 500 });
  }
}
