import { NextRequest, NextResponse } from 'next/server';
import { dhanGet } from '@/lib/dhanToken';
import { kotakGetShared, kotakRows, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { shapeKotakTrade } from '@/lib/kotakShape';
import { kiteGet, isZerodhaTokenValid } from '@/lib/zerodhaToken';
import { shapeZerodhaTrade } from '@/lib/zerodhaShape';
import { computeCharges, BROKERAGE_PER_ORDER, type ChargeBroker, type TradeRow } from '@/lib/tradeCharges';
import { isDhanTokenValid } from '@/lib/session';

// Estimated charges on today's executed orders for one broker (the Price Ladder's Net P&L chip = account P&L - these).
// Read-only: the broker's own trade book, never an order. Cached 10 s per broker (the page polls it with the header).
const CACHE_MS = 10_000;
const cache = new Map<string, { at: number; body: Record<string, unknown> }>();

export async function GET(req: NextRequest): Promise<NextResponse> {
  const broker = req.nextUrl.searchParams.get('broker');
  if (broker !== 'dhan' && broker !== 'kotak' && broker !== 'zerodha') return NextResponse.json({ success: false, error: 'broker must be dhan, kotak or zerodha' }, { status: 400 });
  const hit = cache.get(broker);
  if (hit && Date.now() - hit.at < CACHE_MS) return NextResponse.json(hit.body);
  try {
    let rows: TradeRow[];
    if (broker === 'dhan') {
      if (!isDhanTokenValid()) return NextResponse.json({ success: false, error: 'Dhan is not logged in' }, { status: 401 });
      const t = await dhanGet('/trades');
      rows = Array.isArray(t) ? t as TradeRow[] : [];
    } else if (broker === 'kotak') {
      if (!isKotakTokenValid()) return NextResponse.json({ success: false, error: 'Kotak is not logged in' }, { status: 401 });
      rows = kotakRows(await kotakGetShared(KOTAK_PATHS.tradeBook)).map(shapeKotakTrade);
    } else {
      if (!isZerodhaTokenValid()) return NextResponse.json({ success: false, error: 'Zerodha is not logged in' }, { status: 401 });
      const t = await kiteGet('/trades') as unknown;
      rows = (Array.isArray(t) ? t : []).map(shapeZerodhaTrade);
    }
    // Dhan and Zerodha quote MCX quantity in lots, Kotak in barrels.
    const r = computeCharges(rows, broker as ChargeBroker, broker !== 'kotak');
    const body = { success: true, charges: r.total, orders: r.orders, breakdown: r.breakdown, brokeragePerOrder: BROKERAGE_PER_ORDER[broker] };
    cache.set(broker, { at: Date.now(), body });
    return NextResponse.json(body);
  } catch (err) {
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 502 });
  }
}
