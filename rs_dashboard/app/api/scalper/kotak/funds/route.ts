import { NextResponse } from 'next/server';
import { isKotakTokenValid, kotakLimits } from '@/lib/kotakToken';
import { shapeKotakFunds } from '@/lib/kotakShape';
import { getCachedFunds } from '@/lib/brokerPositionsCache';

// Display-only (same rationale as scalper/funds) — shares the exact same
// `getCachedFunds('kotak', ...)` cache key Dashboard/Margin Allocator already
// populate, so this route often serves a cache hit with zero Kotak call.
export async function GET(): Promise<NextResponse> {
  if (!isKotakTokenValid()) {
    return NextResponse.json({
      success: true,
      data: { availabelBalance: 0, availableBalance: 0 },
      error: 'Kotak not connected — run kotak_autologin.py',
    });
  }

  try {
    const json = await getCachedFunds('kotak', () => kotakLimits());
    const funds = shapeKotakFunds(json);
    // `availabelBalance` (sic) is the key the scalper's FundsView reads — it
    // matches Dhan's own misspelling, so keep it rather than "fixing" it here.
    return NextResponse.json({ success: true, data: { availabelBalance: funds.availableBalance, ...funds } });
  } catch (err) {
    const msg = (err as Error).message || String(err);
    console.error('[scalper/kotak/funds] error:', msg);
    return NextResponse.json({ success: false, error: 'Failed to fetch funds', detail: msg }, { status: 500 });
  }
}
