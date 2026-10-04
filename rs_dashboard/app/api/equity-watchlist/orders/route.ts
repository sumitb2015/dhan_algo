import { NextRequest, NextResponse } from 'next/server';
import { dhanGet, dhanPost, dhanPut, dhanDelete } from '@/lib/dhanToken';
import { findEquity } from '@/lib/equityMaster';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { fetchHoldingsLive, fetchIntradayLongQty, fetchPendingSellQty, sellableQty } from '@/lib/dhanEquityPortfolio';

const MAX_EQUITY_QTY = 10_000;

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      symbol,
      transactionType,
      quantity,
      price,
      triggerPrice,
      orderFlag = 'SINGLE',
      price1,
      triggerPrice1,
      quantity1,
      orderKind = 'FOREVER', // 'FOREVER' | 'REGULAR'
      productType = 'CNC',   // 'CNC' | 'INTRADAY'
    } = body ?? {};

    if (!symbol || !transactionType || !quantity || price == null) {
      return NextResponse.json({ success: false, error: 'Missing required fields (symbol, transactionType, quantity, price)' }, { status: 400 });
    }

    const eq = findEquity(String(symbol).trim().toUpperCase());
    if (!eq) {
      return NextResponse.json({ success: false, error: `Unknown NSE equity symbol "${symbol}"` }, { status: 400 });
    }

    const side = String(transactionType).toUpperCase();
    if (side !== 'BUY' && side !== 'SELL') {
      return NextResponse.json({ success: false, error: 'transactionType must be BUY or SELL' }, { status: 400 });
    }

    const qty = Math.floor(Number(quantity));
    if (qty <= 0) {
      return NextResponse.json({ success: false, error: 'Quantity must be a positive integer' }, { status: 400 });
    }
    if (qty > MAX_EQUITY_QTY) {
      return NextResponse.json(
        { success: false, error: `Quantity exceeds maximum allowed per order (${MAX_EQUITY_QTY}). Please split.` },
        { status: 400 }
      );
    }

    const rawPrice = Number(price);
    if (!(rawPrice > 0)) {
      return NextResponse.json({ success: false, error: 'Price must be greater than 0' }, { status: 400 });
    }

    // UI presets/steppers can land off-tick (e.g. -3% of 1035 = 1003.95); snap to the nearest tick.
    const snap = (v: number) => (eq.tick > 0 ? Number((Math.round(v / eq.tick) * eq.tick).toFixed(2)) : v);
    const limitPrice = snap(rawPrice);

    // No shorting: a sell must be covered by owned shares (same rule as /api/equity-order).
    if (side === 'SELL') {
      const prod = orderKind === 'REGULAR' && productType === 'INTRADAY' ? 'INTRADAY' : 'CNC';
      let avail: number;
      if (prod === 'INTRADAY') {
        avail = await fetchIntradayLongQty(eq.securityId);
      } else {
        avail = sellableQty(await fetchHoldingsLive(), eq.securityId).availableQty;
      }
      if (orderKind === 'REGULAR') avail -= await fetchPendingSellQty(eq.securityId, prod);
      if (qty > avail) {
        return NextResponse.json(
          { success: false, error: `Cannot sell ${qty} ${eq.symbol}: only ${Math.max(0, avail)} available (${prod}). Shorting is not allowed.` },
          { status: 400 }
        );
      }
    }

    if (orderKind === 'REGULAR') {
      // Direct Regular Day Limit Order
      const correlationId = `eq_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
      const prod = productType === 'INTRADAY' ? 'INTRADAY' : 'CNC';
      const payload: Record<string, unknown> = {
        correlationId,
        transactionType: side,
        exchangeSegment: 'NSE_EQ',
        productType: prod,
        orderType: 'LIMIT',
        validity: 'DAY',
        securityId: eq.securityId,
        quantity: qty,
        disclosedQuantity: 0,
        price: limitPrice,
        triggerPrice: 0,
        afterMarketOrder: false,
      };

      let res: Record<string, unknown>;
      try {
        res = (await dhanPost('/orders', payload)) as Record<string, unknown>;
      } catch (err) {
        // Timeout / network drop: the order may still have reached Dhan. Reconcile by
        // correlationId before reporting failure, so a retry cannot double-place.
        const e = err as Error & { status?: number };
        if (e.status !== undefined) throw err; // an HTTP rejection is a definite failure
        let found: Record<string, unknown> | null = null;
        for (const delay of [0, 1500]) {
          if (delay) await new Promise((r) => setTimeout(r, delay));
          try {
            const r = (await dhanGet(`/orders/external/${correlationId}`)) as Record<string, unknown>;
            if (r && r.orderId) { found = r; break; }
          } catch { /* not found yet */ }
        }
        if (!found) {
          return NextResponse.json({
            success: false,
            error: 'Dhan did not respond and the order could not be confirmed. Check the Orders book before retrying.',
          }, { status: 504 });
        }
        res = found;
      }
      invalidateBrokerCache('dhan');
      const orderId = String(res.orderId ?? (res.data as Record<string, unknown> | undefined)?.orderId ?? '');
      return NextResponse.json({
        success: true,
        orderId,
        orderStatus: (res.orderStatus as string) ?? 'TRANSIT',
        product: prod,
        orderKind: 'REGULAR',
      });
    }

    // Forever (GTT) Limit Order
    const trigPrice = snap(Number(triggerPrice));
    if (!(trigPrice > 0)) {
      return NextResponse.json({ success: false, error: 'Trigger price must be greater than 0 for Forever orders' }, { status: 400 });
    }

    const flag = orderFlag === 'OCO' ? 'OCO' : 'SINGLE';
    const payload: Record<string, unknown> = {
      orderFlag: flag,
      transactionType: side,
      exchangeSegment: 'NSE_EQ',
      productType: 'CNC',
      orderType: 'LIMIT',
      validity: 'DAY',
      tradingSymbol: eq.symbol,
      securityId: eq.securityId,
      quantity: qty,
      disclosedQuantity: 0,
      price: limitPrice,
      triggerPrice: trigPrice,
      // The SDK always sent the second leg (zeros for SINGLE); keep the payload identical.
      price1: 0,
      triggerPrice1: 0,
      quantity1: 0,
    };

    if (flag === 'OCO') {
      const p1 = Number(price1 ?? 0);
      const tp1 = Number(triggerPrice1 ?? 0);
      const q1 = Math.floor(Number(quantity1 ?? 0));
      if (!(p1 > 0) || !(tp1 > 0) || !(q1 > 0)) {
        return NextResponse.json({ success: false, error: 'OCO leg 2 requires price1, triggerPrice1, and quantity1 > 0' }, { status: 400 });
      }
      payload.price1 = p1;
      payload.triggerPrice1 = tp1;
      payload.quantity1 = q1;
    }

    const res = (await dhanPost('/forever/orders', payload)) as Record<string, unknown>;
    invalidateBrokerCache('dhan');
    const orderId = String(res.orderId ?? (res.data as Record<string, unknown> | undefined)?.orderId ?? '');
    return NextResponse.json({
      success: true,
      orderId,
      orderStatus: 'PENDING',
      product: 'CNC',
      orderKind: 'FOREVER',
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[equity-watchlist/orders] POST error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { orderId, orderFlag = 'SINGLE', legName = 'STOP_LOSS_LEG', quantity, price, triggerPrice } = body ?? {};

    if (!orderId || !quantity || price == null || triggerPrice == null) {
      return NextResponse.json({ success: false, error: 'Missing required fields (orderId, quantity, price, triggerPrice)' }, { status: 400 });
    }

    const qty = Math.floor(Number(quantity));
    if (qty <= 0 || qty > MAX_EQUITY_QTY) {
      return NextResponse.json({ success: false, error: `Quantity must be between 1 and ${MAX_EQUITY_QTY}` }, { status: 400 });
    }

    const limitPrice = Number(price);
    const trigPrice = Number(triggerPrice);
    if (!(limitPrice > 0) || !(trigPrice > 0)) {
      return NextResponse.json({ success: false, error: 'Price and triggerPrice must be greater than 0' }, { status: 400 });
    }

    const payload = {
      orderId: String(orderId),
      orderFlag: String(orderFlag),
      orderType: 'LIMIT',
      legName: String(legName),
      quantity: qty,
      disclosedQuantity: 0,
      price: limitPrice,
      triggerPrice: trigPrice,
      validity: 'DAY',
    };

    await dhanPut(`/forever/orders/${orderId}`, payload);
    invalidateBrokerCache('dhan');
    return NextResponse.json({ success: true, orderId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[equity-watchlist/orders] PATCH error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const orderId = body?.orderId;
    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }

    await dhanDelete(`/forever/orders/${orderId}`);
    invalidateBrokerCache('dhan');
    return NextResponse.json({ success: true, orderId });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error('[equity-watchlist/orders] DELETE error:', msg);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
