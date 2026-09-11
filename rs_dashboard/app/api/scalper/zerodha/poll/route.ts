import { NextResponse } from 'next/server';
import { kiteGet, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition, shapeZerodhaOrder, shapeZerodhaTrade } from '@/lib/zerodhaShape';

export async function GET(): Promise<NextResponse> {
  // Zerodha is an optional broker — this route is polled unconditionally by
  // whatever's on screen regardless of whether Zerodha is actually linked,
  // so a not-connected session must not attempt a request (or log an
  // error) on every single poll. Not connected is reported the same way a
  // request failure is (positionsError), just without ever calling kiteGet.
  if (!isZerodhaTokenValid()) {
    return NextResponse.json({
      success: true,
      positions: [],
      positionsError: 'Zerodha not connected — run scripts/tools/zerodha_autologin.py',
      orders: [],
      trades: [],
    });
  }

  try {
    let positionsError: string | null = null;
    const [positions, orders, trades] = await Promise.all([
      kiteGet('/portfolio/positions').catch(err => {
        positionsError = String(err?.message ?? err);
        console.error('[scalper/zerodha/poll] positions fetch failed:', err);
        return { net: [] };
      }) as Promise<{ net: any[] }>,
      kiteGet('/orders').catch(() => []) as Promise<any[]>,
      kiteGet('/trades').catch(() => []) as Promise<any[]>,
    ]);

    return NextResponse.json({
      success: true,
      positions: (positions.net ?? []).map(shapeZerodhaPosition),
      positionsError,
      orders: (Array.isArray(orders) ? orders : []).map(shapeZerodhaOrder),
      trades: (Array.isArray(trades) ? trades : []).map(shapeZerodhaTrade),
    });
  } catch (err) {
    console.error('[scalper/zerodha/poll] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to poll data', detail: String((err as Error).message) }, { status: 500 });
  }
}
