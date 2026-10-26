import { NextRequest, NextResponse } from 'next/server';
import { getDhanFutures } from '@/lib/dhanFuturesLookup';
import { isMcxUnderlying } from '@/lib/priceLadder';

// The futures months the Price Ladder's Futures instrument can trade (MCX only). Read-only: Dhan's master list.
export async function GET(req: NextRequest) {
  const u = (req.nextUrl.searchParams.get('underlying') ?? '').toUpperCase();
  if (!isMcxUnderlying(u)) return NextResponse.json({ success: false, error: `${u || 'underlying'} has no futures on the ladder` }, { status: 400 });
  const list = await getDhanFutures(u);
  if (!list) return NextResponse.json({ success: false, error: `Could not read the ${u} futures list` }, { status: 502 });
  return NextResponse.json({ success: true, data: list.map(f => f.expiry) });
}
