import { NextResponse } from 'next/server';
import { kotakGet, kotakRows, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { shapeKotakTrade } from '@/lib/kotakShape';

// Kotak's trade book, shaped to the same { tradingSymbol, transactionType, tradedQuantity, tradedPrice, createTime }
// contract as the Dhan route (app/api/scalper/trades/route.ts) so an Order Book's Trades tab reads either broker
// through scalperRoute(broker, 'trades').
export async function GET(): Promise<NextResponse> {
  if (!isKotakTokenValid()) {
    return NextResponse.json({ success: false, error: 'Kotak not connected — run kotak_autologin.py' }, { status: 401 });
  }
  try {
    const trades = await kotakGet(KOTAK_PATHS.tradeBook);
    return NextResponse.json({ success: true, data: kotakRows(trades).map(shapeKotakTrade) });
  } catch (err) {
    console.error('[/api/scalper/kotak/trades] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch trades', detail: String((err as Error).message) }, { status: 500 });
  }
}
