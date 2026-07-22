import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';

// Direct Dhan REST calls (same pattern as scalper/fast-order). The previous
// implementation spawned scalper_api.py per poll, paying ~10s of Python
// interpreter + DhanHelper startup for three simple GET passthroughs — which
// delayed ProfitLock SL/target detection by several seconds.
export async function GET(): Promise<NextResponse> {
  try {
    let positionsError: string | null = null;
    const [positions, orders, trades] = await Promise.all([
      dhanGet('/positions').catch(err => {
        positionsError = String(err?.message ?? err);
        console.error('[/api/scalper/poll] positions fetch failed:', err);
        return null;
      }),
      dhanGet('/orders').catch(() => []),
      dhanGet('/trades').catch(() => []),
    ]);

    return NextResponse.json({
      success: true,
      positions: Array.isArray(positions) ? positions : [],
      positionsError,
      orders: Array.isArray(orders) ? orders : [],
      trades: Array.isArray(trades) ? trades : [],
    });
  } catch (err) {
    console.error('[/api/scalper/poll] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to poll data', detail: String((err as Error).message) }, { status: 500 });
  }
}
