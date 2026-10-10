import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { dedupePositions } from '@/lib/positionProduct';

// Direct Dhan REST calls (same pattern as scalper/poll) — replaces the
// scalper_api.py subprocess and its ~10s Python cold-start per request.
export async function GET(): Promise<NextResponse> {
  try {
    let positionsError: string | null = null;
    let pnlGuardUnknown = false;
    const [positions, orders, trades, funds, pnlGuard] = await Promise.all([
      dhanGet('/positions').catch(err => {
        positionsError = String(err?.message ?? err);
        console.error('[/api/scalper/all] positions fetch failed:', err);
        return null;
      }),
      dhanGet('/orders').catch(() => []),
      dhanGet('/trades').catch(() => []),
      dhanGet('/fundlimit').catch(() => ({})),
      // 4xx when no P&L guard is configured. Anything else (5xx, timeout, expired token) means the
      // state is UNKNOWN — reported as such so the UI never claims "NOT SET" on a failed lookup.
      dhanGet('/pnlExit').catch((err: unknown) => {
        const msg = String((err as Error)?.message ?? err);
        if (/\b5\d\d\b|abort|timeout|fetch failed|ENOENT|access_token|\b40[13]\b|unauthor/i.test(msg)) pnlGuardUnknown = true;
        return null;
      }),
    ]);

    return NextResponse.json({
      success: true,
      positions: dedupePositions(Array.isArray(positions) ? positions as Record<string, unknown>[] : []),
      positionsError,
      orders: Array.isArray(orders) ? orders : [],
      trades: Array.isArray(trades) ? trades : [],
      funds: funds ?? {},
      pnl_guard: pnlGuard,
      pnl_guard_unknown: pnlGuardUnknown,
    });
  } catch (err) {
    console.error('[/api/scalper/all] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch tab data', detail: String((err as Error).message) }, { status: 500 });
  }
}
