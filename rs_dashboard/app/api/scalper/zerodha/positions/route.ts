import { NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';
import { shapeZerodhaPosition } from '@/lib/zerodhaShape';

export async function GET(): Promise<NextResponse> {
  try {
    const positions = await kiteGet('/portfolio/positions') as { net: any[] };
    return NextResponse.json({ success: true, data: (positions.net ?? []).map(shapeZerodhaPosition) });
  } catch (err) {
    console.error('[scalper/zerodha/positions] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch positions', detail: String((err as Error).message) }, { status: 500 });
  }
}
