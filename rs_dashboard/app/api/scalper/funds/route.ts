import { NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';

// Direct Dhan REST call — replaces the scalper_api.py subprocess and its
// ~10s Python cold-start.
export async function GET(): Promise<NextResponse> {
  try {
    const data = await dhanGet('/fundlimit');
    return NextResponse.json({ success: true, data: data ?? {} });
  } catch (err) {
    console.error('[/api/scalper/funds] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch funds', detail: String((err as Error).message) }, { status: 500 });
  }
}
