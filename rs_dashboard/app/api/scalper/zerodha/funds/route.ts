import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';

export async function GET(): Promise<NextResponse> {
  try {
    const margins = await kiteGet('/user/margins') as Record<string, any>;
    return NextResponse.json({ success: true, data: { availabelBalance: margins?.equity?.net ?? 0 } });
  } catch (err) {
    console.error('[scalper/zerodha/funds] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch funds', detail: String((err as Error).message) }, { status: 500 });
  }
}
