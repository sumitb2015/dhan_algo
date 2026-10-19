import { NextRequest, NextResponse } from 'next/server';
import { kiteGet } from '@/lib/zerodhaToken';
import { placeZerodhaOrderSliced } from '@/lib/zerodhaPlaceOrder';
import { slicesFor } from '@/lib/zerodhaContracts';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

/** Kite's derivative exchanges. NSE / BSE are cash equity, which the F&O terminals' Exit All must never sell. */
const KITE_FNO_EXCHANGES = new Set(['NFO', 'BFO', 'MCX', 'CDS', 'BCD']);

/**
 * Square off Zerodha positions: F&O only by default (same scope as Dhan's scalper Exit All and Kotak's), shorts bought back
 * before longs are sold. `{ scope: 'all' }` opts into everything.
 */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const closed: string[] = [];
  const errors: string[] = [];
  const skipped: string[] = [];
  const body = await req.json().catch(() => ({})) as { scope?: string };
  const all = body?.scope === 'all';

  try {
    const positions = await kiteGet('/portfolio/positions') as { net: any[] };
    const open = (positions.net ?? [])
      .filter(p => Number(p.quantity) !== 0)
      .filter(p => {
        if (all || KITE_FNO_EXCHANGES.has(String(p.exchange ?? '').toUpperCase())) return true;
        skipped.push(String(p.tradingsymbol));
        return false;
      })
      .sort((a, b) => Number(a.quantity) - Number(b.quantity));   // most-short first

    for (const pos of open) {
      const qty = Math.abs(Number(pos.quantity));
      const side = Number(pos.quantity) > 0 ? 'SELL' : 'BUY';
      const r = await placeZerodhaOrderSliced({
        tradingsymbol: pos.tradingsymbol,
        exchange: pos.exchange ?? 'NFO',
        transaction_type: side,
        order_type: 'MARKET',
        quantity: qty,
        product: pos.product ?? 'MIS',
        validity: 'DAY',
        // Required for API market orders on options (-1 = automatic band).
        market_protection: -1,
      }, slicesFor(String(pos.tradingsymbol), qty));
      if (r.status === 'placed') closed.push(pos.tradingsymbol);
      else errors.push(`${pos.tradingsymbol}: ${r.status === 'unknown' ? 'STATUS UNKNOWN (may have closed) - ' : ''}${r.error}`);
    }

    // Invalidate even on a partial failure — some legs can close while others
    // error out, and `closed` being non-empty still means positions moved.
    if (closed.length > 0) invalidateBrokerCache('zerodha');
    return NextResponse.json({ success: errors.length === 0, closed, errors, skipped });
  } catch (err) {
    console.error('[scalper/zerodha/exit-all] error:', err);
    return NextResponse.json({ success: false, closed, errors: [String((err as Error).message ?? err)], skipped }, { status: 500 });
  }
}
