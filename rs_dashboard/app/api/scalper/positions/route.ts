import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';

// Direct Dhan REST call — replaces the scalper_api.py subprocess and its
// ~10s Python cold-start. The per-row Close button awaits this route before
// placing its exit order, so it must be fast.
export async function GET(): Promise<NextResponse> {
  try {
    const data = await dhanGet('/positions');
    return NextResponse.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    console.error('[/api/scalper/positions] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch positions', detail: String((err as Error).message) }, { status: 500 });
  }
}
