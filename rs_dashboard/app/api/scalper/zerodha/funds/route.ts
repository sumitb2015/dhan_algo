import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';
import { getCachedFunds } from '@/lib/brokerPositionsCache';

// Display-only (same rationale as scalper/funds) — shares the 2s cache with
// Dashboard/Margin Allocator/Scalper instead of each poller hitting Kite
// independently.
export async function GET(): Promise<NextResponse> {
  try {
    const margins = await getCachedFunds('zerodha', () => kiteGet('/user/margins')) as Record<string, any>;
    return NextResponse.json({ success: true, data: {
      availabelBalance: margins?.equity?.net ?? 0,
      utilizedAmount: margins?.equity?.utilised?.debits ?? 0,
    } });
  } catch (err) {
    console.error('[scalper/zerodha/funds] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch funds', detail: String((err as Error).message) }, { status: 500 });
  }
}
