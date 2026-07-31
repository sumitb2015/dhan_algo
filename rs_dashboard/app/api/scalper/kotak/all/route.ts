import { NextResponse } from 'next/server';
import { kotakGet, kotakLimits, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition, shapeKotakOrder, shapeKotakTrade, shapeKotakFunds } from '@/lib/kotakShape';

export async function GET(): Promise<NextResponse> {
  try {
    let positionsError: string | null = null;
    const [positions, orders, trades, limits] = await Promise.all([
      // Only the positions failure is surfaced: it is the one the trader acts
      // on, and silently rendering an empty book would look like being flat.
      kotakGet(KOTAK_PATHS.positions).catch(err => {
        positionsError = String(err?.message ?? err);
        console.error('[scalper/kotak/all] positions fetch failed:', err);
        return {} as Record<string, unknown>;
      }),
      kotakGet(KOTAK_PATHS.orderBook).catch(() => ({} as Record<string, unknown>)),
      kotakGet(KOTAK_PATHS.tradeBook).catch(() => ({} as Record<string, unknown>)),
      kotakLimits().catch(() => ({} as Record<string, unknown>)),
    ]);

    const funds = shapeKotakFunds(limits);
    return NextResponse.json({
      success: true,
      positions: kotakRows(positions).map(shapeKotakPosition),
      positionsError,
      orders: kotakRows(orders).map(shapeKotakOrder),
      trades: kotakRows(trades).map(shapeKotakTrade),
      funds: { availabelBalance: funds.availableBalance, ...funds },
      // The P&L guard is a Dhan-side mechanism; there is no Kotak equivalent.
      pnl_guard: null,
    });
  } catch (err) {
    console.error('[scalper/kotak/all] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch tab data', detail: String((err as Error).message) }, { status: 500 });
  }
}
