import { NextResponse } from 'next/server';
import { kotakGetShared, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition } from '@/lib/kotakShape';
import { getCachedPositions } from '@/lib/brokerPositionsCache';

// Read-only, DISPLAY reads only: /index-scalper's Kotak positions through the shared Kotak positions cache (the same key
// the Dashboard / Margin Allocator / Covered Call use), so its 3 s poll does not add live Kotak calls of its own.
// Placements evict that cache (invalidateBrokerCache). Exit sizing never uses this: it reads /api/scalper/kotak/positions live.
export async function GET(): Promise<NextResponse> {
  try {
    const json = await getCachedPositions('kotak', () => kotakGetShared(KOTAK_PATHS.positions));
    return NextResponse.json({ success: true, data: kotakRows(json).map(shapeKotakPosition) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err) {
    return NextResponse.json({ success: false, error: 'Failed to fetch Kotak positions', detail: String((err as Error).message ?? err) }, { status: 500 });
  }
}
