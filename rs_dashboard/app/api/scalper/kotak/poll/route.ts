import { NextRequest, NextResponse } from 'next/server';
import { kotakGetShared, kotakRows, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';
import { shapeKotakPosition, shapeKotakOrder, shapeKotakTrade } from '@/lib/kotakShape';
import { joinKotakLtp } from '@/lib/kotakLtpJoin';

export async function GET(req: NextRequest): Promise<NextResponse> {
  // `?only=positions`: the Focus Tool's 2 s poll reads only the position book, so skip the order and trade books
  // (two of the three Kotak calls per poll, which is what tripped stCode 100025).
  const positionsOnly = req.nextUrl.searchParams.get('only') === 'positions';
  // Kotak is an optional broker — this route is polled unconditionally by
  // whatever's on screen regardless of whether Kotak is actually linked, so
  // a not-connected session must not attempt a request (or log an error) on
  // every single poll. See the matching guard in scalper/zerodha/poll.
  if (!isKotakTokenValid()) {
    return NextResponse.json({
      success: true,
      positions: [],
      positionsError: 'Kotak not connected — run kotak_autologin.py',
      orders: [],
      trades: [],
    });
  }

  try {
    let positionsError: string | null = null;
    let ordersError: string | null = null;
    let tradesError: string | null = null;
    const [positions, orders, trades] = await Promise.all([
      kotakGetShared(KOTAK_PATHS.positions).catch(err => {
        positionsError = String(err?.message ?? err);
        console.error('[scalper/kotak/poll] positions fetch failed:', err);
        return {} as Record<string, unknown>;
      }),
      (positionsOnly ? Promise.resolve({}) : kotakGetShared(KOTAK_PATHS.orderBook)).catch(err => { ordersError = String(err?.message ?? err); return {} as Record<string, unknown>; }),
      (positionsOnly ? Promise.resolve({}) : kotakGetShared(KOTAK_PATHS.tradeBook)).catch(err => { tradesError = String(err?.message ?? err); return {} as Record<string, unknown>; }),
    ]);

    const shaped = kotakRows(positions).map(shapeKotakPosition);
    // `?ltp=1` (Cyber Scalper): price the open OPTION legs from Dhan's chain. Opt-in because it can start a chain fetch, and
    // the other terminals join prices their own way. A leg that cannot be priced keeps lastTradedPrice 0 = unknown.
    if (req.nextUrl.searchParams.get('ltp') === '1') {
      const joinable = shaped
        .filter(p => p.netQty !== 0 && /(CE|PE)$/.test(p.tradingSymbol.toUpperCase()))
        .map(p => ({ row: p, j: { tradingSymbol: p.tradingSymbol, netQty: p.netQty, buyAvg: p.buyAvg, sellAvg: p.sellAvg, lastPrice: 0,
          unrealizedPnl: 0, realizedPnl: p.realizedProfit, totalPnl: 0, isOpen: true } }));
      try { await joinKotakLtp(joinable.map(x => x.j)); } catch { /* unpriced stays 0 */ }
      for (const { row, j } of joinable) if (j.lastPrice > 0) { row.lastTradedPrice = j.lastPrice; row.unrealizedProfit = j.unrealizedPnl; }
    }

    return NextResponse.json({
      success: true,
      positions: shaped,
      positionsError,
      ordersError,
      tradesError,
      orders: kotakRows(orders).map(shapeKotakOrder),
      trades: kotakRows(trades).map(shapeKotakTrade),
    });
  } catch (err) {
    console.error('[scalper/kotak/poll] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to poll data', detail: String((err as Error).message) }, { status: 500 });
  }
}
