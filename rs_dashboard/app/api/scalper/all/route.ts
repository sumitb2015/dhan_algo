import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';

// Direct Dhan REST calls (same pattern as scalper/poll) — replaces the
// scalper_api.py subprocess and its ~10s Python cold-start per request.
export async function GET(): Promise<NextResponse> {
  try {
    let positionsError: string | null = null;
    const [positions, orders, trades, funds, pnlGuard] = await Promise.all([
      dhanGet('/positions').catch(err => {
        positionsError = String(err?.message ?? err);
        console.error('[/api/scalper/all] positions fetch failed:', err);
        return null;
      }),
      dhanGet('/orders').catch(() => []),
      dhanGet('/trades').catch(() => []),
      dhanGet('/fundlimit').catch(() => ({})),
      dhanGet('/pnlExit').catch(() => null), // 4xx when no P&L guard is configured
    ]);

    return NextResponse.json({
      success: true,
      positions: Array.isArray(positions) ? positions : [],
      positionsError,
      orders: Array.isArray(orders) ? orders : [],
      trades: Array.isArray(trades) ? trades : [],
      funds: funds ?? {},
      pnl_guard: pnlGuard,
    });
  } catch (err) {
    console.error('[/api/scalper/all] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch tab data', detail: String((err as Error).message) }, { status: 500 });
  }
}
