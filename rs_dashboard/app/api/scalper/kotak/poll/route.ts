import { NextResponse } from 'next/server';
import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition, shapeKotakOrder, shapeKotakTrade } from '@/lib/kotakShape';

export async function GET(): Promise<NextResponse> {
  try {
    let positionsError: string | null = null;
    const [positions, orders, trades] = await Promise.all([
      kotakGet(KOTAK_PATHS.positions).catch(err => {
        positionsError = String(err?.message ?? err);
        console.error('[scalper/kotak/poll] positions fetch failed:', err);
        return {} as Record<string, unknown>;
      }),
      kotakGet(KOTAK_PATHS.orderBook).catch(() => ({} as Record<string, unknown>)),
      kotakGet(KOTAK_PATHS.tradeBook).catch(() => ({} as Record<string, unknown>)),
    ]);

    return NextResponse.json({
      success: true,
      positions: kotakRows(positions).map(shapeKotakPosition),
      positionsError,
      orders: kotakRows(orders).map(shapeKotakOrder),
      trades: kotakRows(trades).map(shapeKotakTrade),
    });
  } catch (err) {
    console.error('[scalper/kotak/poll] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to poll data', detail: String((err as Error).message) }, { status: 500 });
  }
}
