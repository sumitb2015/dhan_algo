import { NextResponse } from 'next/server';
import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition, shapeKotakOrder, shapeKotakTrade } from '@/lib/kotakShape';

/**
 * Kotak Neo counterpart of /api/crudeoil-trades, feeding the Crude Oil options
 * page when the broker selector is set to Kotak.
 *
 * Two things differ from the Dhan route and both matter:
 *
 *  1. **Quantity is absolute, not lots.** Kotak reports 100 for one CRUDEOIL
 *     lot (10 for CRUDEOILM) where Dhan reports 1. The lot size is derived from
 *     the symbol so the UI can show both, and so an exit sends the quantity the
 *     broker itself reported rather than a lot count it would read as 1 barrel.
 *  2. **Orders are placed by trading symbol.** Kotak has no numeric securityId,
 *     so `tradingSymbol` is the join key and `securityId` carries the token for
 *     display only — never for order routing.
 */

/** Matches CRUDEOIL and CRUDEOILM, and nothing else. */
function isCrude(symbol: string): boolean {
  return /^CRUDEOILM?\d/.test(String(symbol).toUpperCase().trim());
}

/** Contract size per lot, from the symbol prefix. Verified against the mcx_fo master. */
function lotSizeFor(symbol: string): number {
  return String(symbol).toUpperCase().startsWith('CRUDEOILM') ? 10 : 100;
}

export async function GET(): Promise<NextResponse> {
  try {
    const [posJson, ordJson, trdJson] = await Promise.all([
      kotakGet(KOTAK_PATHS.positions),
      kotakGet(KOTAK_PATHS.orderBook),
      kotakGet(KOTAK_PATHS.tradeBook),
    ]);

    const positions = kotakRows(posJson)
      // shapeKotakPosition owns the four-leg net-qty arithmetic — Kotak never
      // reports a net quantity, and duplicating that here is how the UI and the
      // exit path drift apart.
      .map(shapeKotakPosition)
      .filter(p => isCrude(p.tradingSymbol))
      .map(p => ({
        symbol: p.tradingSymbol,
        securityId: p.securityId,
        tradingSymbol: p.tradingSymbol,
        exchangeSegment: p.exchange || 'mcx_fo',
        positionType: p.netQty > 0 ? 'LONG' : p.netQty < 0 ? 'SHORT' : 'CLOSED',
        netQty: p.netQty,
        lotSize: lotSizeFor(p.tradingSymbol),
        buyAvg: p.buyAvg,
        sellAvg: p.sellAvg,
        lastPrice: p.lastTradedPrice,
        // Already in rupees: netQty is absolute, so price deltas need no lot
        // multiplier (unlike the Dhan route, whose netQty is a lot count).
        realizedProfit: p.realizedProfit,
        unrealizedProfit: p.unrealizedProfit,
        productType: p.productType,
      }));

    const orders = kotakRows(ordJson)
      .filter(o => isCrude(String(o.trdSym ?? '')))
      .map(o => {
        const shaped = shapeKotakOrder(o);
        return {
          orderId: String(o.nOrdNo ?? ''),
          symbol: shaped.tradingSymbol,
          exchange: String(o.exSeg ?? 'mcx_fo'),
          orderType: shaped.orderType,
          transactionType: shaped.transactionType,
          // `prod` only — prcTp is the PRICE type (MKT/L) and would render as a
          // product code in the Activity table.
          productType: String(o.prod ?? ''),
          quantity: shaped.quantity,
          filledQty: Number(o.fldQty) || 0,
          price: shaped.price,
          triggerPrice: Number(o.trgPrc) || 0,
          tradedPrice: Number(o.avgPrc) || 0,
          status: shaped.orderStatus,
          validity: String(o.vldt ?? 'DAY'),
          // Kotak's order rows carry ordDtTm/ordEntTm/exCfmTm — NOT the `ordTm`
          // that lib/kotakShape's generic shaper looks for, so its createTime
          // comes back empty here and the timestamps are read directly.
          createTime: String(o.ordEntTm ?? o.ordDtTm ?? ''),
          updateTime: String(o.exCfmTm ?? o.ordDtTm ?? o.ordEntTm ?? ''),
        };
      });

    const trades = kotakRows(trdJson)
      .filter(t => isCrude(String(t.trdSym ?? '')))
      .map(t => {
        const shaped = shapeKotakTrade(t);
        return {
          orderId: String(t.nOrdNo ?? ''),
          symbol: shaped.tradingSymbol,
          exchange: String(t.exSeg ?? 'mcx_fo'),
          transactionType: shaped.transactionType,
          productType: String(t.prod ?? ''),
          tradedQuantity: shaped.tradedQuantity,
          tradedPrice: shaped.tradedPrice,
          tradeId: String(t.flId ?? t.nOrdNo ?? ''),
          createTime: shaped.createTime,
          exchangeTime: String(t.exTm ?? t.flTm ?? shaped.createTime),
        };
      });

    return NextResponse.json({ success: true, positions, orders, trades });
  } catch (err) {
    console.error('[crudeoil-trades/kotak] error:', err);
    return NextResponse.json(
      { success: false, error: `Kotak: ${String((err as Error).message ?? err)}` },
      { status: 500 },
    );
  }
}
