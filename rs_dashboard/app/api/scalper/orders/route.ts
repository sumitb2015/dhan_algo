import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';

// Direct Dhan REST call — replaces the scalper_api.py subprocess and its
// ~10s Python cold-start.
export async function GET(): Promise<NextResponse> {
  try {
    const data = await dhanGet('/orders');
    return NextResponse.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    console.error('[/api/scalper/orders] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch orders', detail: String((err as Error).message) }, { status: 500 });
  }
}
