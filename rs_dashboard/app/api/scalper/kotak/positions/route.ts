import { NextResponse } from 'next/server';
import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition } from '@/lib/kotakShape';

export async function GET(): Promise<NextResponse> {
  try {
    const json = await kotakGet(KOTAK_PATHS.positions);
    return NextResponse.json({ success: true, data: kotakRows(json).map(shapeKotakPosition) });
  } catch (err) {
    console.error('[scalper/kotak/positions] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch positions', detail: String((err as Error).message) }, { status: 500 });
  }
}
