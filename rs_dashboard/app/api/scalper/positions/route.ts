import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { dedupePositions } from '@/lib/positionProduct';

// Direct Dhan REST call — replaces the scalper_api.py subprocess and its
// ~10s Python cold-start. The per-row Close button awaits this route before
// placing its exit order, so it must be fast.
export async function GET(): Promise<NextResponse> {
  try {
    const data = await dhanGet('/positions');
    return NextResponse.json({ success: true, data: dedupePositions(Array.isArray(data) ? data as Record<string, unknown>[] : []) });
  } catch (err) {
    const detail = String((err as Error).message);
    if (detail.includes('502') || detail.includes('503') || detail.includes('504')) {
      console.warn('[/api/scalper/positions] upstream broker unavailable:', detail);
      return NextResponse.json({ success: false, error: 'Dhan API unavailable', detail }, { status: 502 });
    }
    console.error('[/api/scalper/positions] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch positions', detail }, { status: 500 });
  }
}
