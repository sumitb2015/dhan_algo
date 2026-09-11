import { NextResponse } from 'next/server';
import { kiteGet, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition, shapeZerodhaOrder, shapeZerodhaTrade } from '@/lib/zerodhaShape';

export async function GET(): Promise<NextResponse> {
  // See the matching guard in scalper/zerodha/poll/route.ts — this route is
  // polled unconditionally regardless of whether Zerodha is actually linked.
  if (!isZerodhaTokenValid()) {
    return NextResponse.json({
      success: true,
      positions: [],
      positionsError: 'Zerodha not connected — run scripts/tools/zerodha_autologin.py',
      orders: [],
      trades: [],
      funds: { availabelBalance: 0 },
      pnl_guard: null,
    });
  }

  try {
    let positionsError: string | null = null;
    const [positions, orders, trades, margins] = await Promise.all([
      kiteGet('/portfolio/positions').catch(err => {
        positionsError = String(err?.message ?? err);
        console.error('[scalper/zerodha/all] positions fetch failed:', err);
        return { net: [] };
      }) as Promise<{ net: any[] }>,
      kiteGet('/orders').catch(() => []) as Promise<any[]>,
      kiteGet('/trades').catch(() => []) as Promise<any[]>,
      kiteGet('/user/margins').catch(() => ({})) as Promise<Record<string, any>>,
    ]);

    return NextResponse.json({
      success: true,
      positions: (positions.net ?? []).map(shapeZerodhaPosition),
      positionsError,
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
