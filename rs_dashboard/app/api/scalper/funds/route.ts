import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { getCachedFunds } from '@/lib/brokerPositionsCache';

// Direct Dhan REST call — replaces the scalper_api.py subprocess and its
// ~10s Python cold-start. Funds only change on order fills (display-only
// here, same as Scalper's own header chip — nothing gates order placement
// on this response's freshness), so the fetch goes through the same shared
// 2s cache Dashboard/Margin Allocator use — every order route already
// invalidates it on fill, so this never shows a stale balance after a trade.
export async function GET(): Promise<NextResponse> {
  try {
    const data = await getCachedFunds('dhan', () => dhanGet('/fundlimit'));
    return NextResponse.json({ success: true, data: data ?? {} });
  } catch (err) {
    console.error('[/api/scalper/funds] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch funds', detail: String((err as Error).message) }, { status: 500 });
  }
}
