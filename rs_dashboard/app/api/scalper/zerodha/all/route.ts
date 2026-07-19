import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition, shapeZerodhaOrder, shapeZerodhaTrade } from '@/lib/zerodhaShape';

export async function GET(): Promise<NextResponse> {
  try {
    const [positions, orders, trades, margins] = await Promise.all([
      kiteGet('/portfolio/positions').catch(() => ({ net: [] })) as Promise<{ net: any[] }>,
      kiteGet('/orders').catch(() => []) as Promise<any[]>,
      kiteGet('/trades').catch(() => []) as Promise<any[]>,
      kiteGet('/user/margins').catch(() => ({})) as Promise<Record<string, any>>,
    ]);

    return NextResponse.json({
      success: true,
      positions: (positions.net ?? []).map(shapeZerodhaPosition),
      orders: (Array.isArray(orders) ? orders : []).map(shapeZerodhaOrder),
      trades: (Array.isArray(trades) ? trades : []).map(shapeZerodhaTrade),
      funds: { availabelBalance: margins?.equity?.net ?? 0 },
      pnl_guard: null,
    });
  } catch (err) {
    console.error('[scalper/zerodha/all] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch tab data', detail: String((err as Error).message) }, { status: 500 });
  }
}
