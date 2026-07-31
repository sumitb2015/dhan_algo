import { NextResponse } from 'next/server';
import { kotakLimits } from '@/lib/kotakToken';
import { shapeKotakFunds } from '@/lib/kotakShape';

export async function GET(): Promise<NextResponse> {
  try {
    const json = await kotakLimits();
    const funds = shapeKotakFunds(json);
    // `availabelBalance` (sic) is the key the scalper's FundsView reads — it
    // matches Dhan's own misspelling, so keep it rather than "fixing" it here.
    return NextResponse.json({ success: true, data: { availabelBalance: funds.availableBalance, ...funds } });
  } catch (err) {
    console.error('[scalper/kotak/funds] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch funds', detail: String((err as Error).message) }, { status: 500 });
  }
}
