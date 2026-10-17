import { NextResponse } from 'next/server';
import { kiteGet, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { shapeZerodhaTrade } from '@/lib/zerodhaShape';

// Zerodha's trade book in the Dhan route's shape (app/api/scalper/trades/route.ts), for scalperRoute(broker, 'trades').
export async function GET(): Promise<NextResponse> {
  if (!isZerodhaTokenValid()) {
    return NextResponse.json({ success: false, error: 'Zerodha not connected — run scripts/tools/zerodha_autologin.py' }, { status: 401 });
  }
  try {
    const trades = await kiteGet('/trades') as unknown;
    return NextResponse.json({ success: true, data: (Array.isArray(trades) ? trades : []).map(shapeZerodhaTrade) });
  } catch (err) {
    console.error('[/api/scalper/zerodha/trades] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch trades', detail: String((err as Error).message) }, { status: 500 });
  }
}
