import { NextRequest, NextResponse } from 'next/server';
import { dhanGet, dhanPut, dhanDelete } from '@/lib/dhanToken';
import { kotakPriceType, modifyPriceError } from '@/lib/orderModifyRules';
import { dhanSourceCapError } from '@/lib/dhanSourceCaps';
import { sourceLotCapError } from '@/lib/kotakOrderRules';
import { kotakDerivativeBySymbol } from '@/lib/kotakContracts';
import { kotakPost, KOTAK_PATHS } from '@/lib/kotakToken';
import { kiteDelete } from '@/lib/zerodhaToken';
import { forgetZerodhaBook, readBrokerOrder } from '@/lib/brokerOrderStatus';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { modifyZerodhaLimitOrder } from '@/lib/zerodhaModifyOrder';

// Direct Dhan REST call for fetching orders. With ?orderId= returns that one
// order's live status (used to confirm a fill before counting a leg as placed).
export async function GET(req: NextRequest): Promise<NextResponse> {
  try {
    const orderId = req.nextUrl.searchParams.get('orderId');
    const getBroker = req.nextUrl.searchParams.get('broker') || 'dhan';
    if (orderId) {
      if (!/^[A-Za-z0-9-]+$/.test(orderId)) {
        return NextResponse.json({ success: false, error: 'Invalid orderId' }, { status: 400 });
      }
      if (getBroker !== 'dhan' && getBroker !== 'kotak' && getBroker !== 'zerodha') {
        return NextResponse.json({ success: false, error: `Broker ${getBroker} order lookup not supported` }, { status: 400 });
      }
      // lib/brokerOrderStatus.ts (Kotak / Kite from a shared order-book read): the same payload for every broker.
      const o = await readBrokerOrder(orderId, getBroker);
      if (!o) return NextResponse.json({ success: false, error: 'Order not found' }, { status: 404 });
      return NextResponse.json({ success: true, data: o });
    }
    const data = await dhanGet('/orders');
    return NextResponse.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    console.error('[/api/scalper/orders] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch orders', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Modify an existing pending order (e.g. change limit price or quantity).
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const {
      orderId,
      price,
      quantity,
      orderType = 'LIMIT',
      triggerPrice = 0,
      validity = 'DAY',
      legName = 'ENTRY_LEG',
      broker = 'dhan',
      // Optional: a caller that names its source gets that source's per-order cap, as when it places (Index Scalper: isx).
      source,
      exchangeSegment,
      tradingSymbol,
      underlying,
    } = body ?? {};

    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }
    // An SL-M has no limit price (0) but needs a trigger; every other type needs a price (lib/orderModifyRules).
    const priceErr = modifyPriceError(String(orderType), price, triggerPrice);
    if (priceErr) {
      return NextResponse.json({ success: false, error: priceErr }, { status: 400 });
    }
    const newPrice = Number(price) || 0;
    const qty = Number(quantity);
    if (isNaN(qty) || qty <= 0) {
      return NextResponse.json({ success: false, error: `Invalid quantity: ${quantity}` }, { status: 400 });
    }
    // The per-source cap, exactly as on placement: a modify can grow an order past it otherwise.
    if (source && broker === 'dhan') {
      const capErr = dhanSourceCapError(Math.round(qty), String(source), String(exchangeSegment ?? ''));
      if (capErr) return NextResponse.json({ success: false, error: capErr }, { status: 400 });
    }
    if (source && broker === 'kotak') {
      const sym = String(tradingSymbol ?? '');
      const contract = sym ? kotakDerivativeBySymbol(sym, String(underlying ?? 'NIFTY')) : null;
      const capErr = sourceLotCapError(Math.round(qty), String(source), sym || String(orderId), contract?.lotSize ?? null);
      if (capErr) return NextResponse.json({ success: false, error: capErr }, { status: 400 });
    }

    if (broker === 'dhan') {
      const payload = {
        orderId: String(orderId),
        orderType: String(orderType).toUpperCase(),
        legName: String(legName).toUpperCase(),
        quantity: Math.round(qty),
        price: Number(newPrice.toFixed(2)),
        disclosedQuantity: 0,
        triggerPrice: Number(triggerPrice) || 0,
        validity: String(validity).toUpperCase(),
      };
      const res = await dhanPut(`/orders/${orderId}`, payload);
      return NextResponse.json({ success: true, data: res });
    }

    if (broker === 'kotak') {
      const res = await kotakPost(KOTAK_PATHS.modifyOrder, {
        no: String(orderId),
        pr: newPrice.toFixed(2),
        pt: kotakPriceType(String(orderType)),
        qt: String(Math.round(qty)),
        vd: String(validity).toUpperCase(),
        tp: String(Number(triggerPrice) || 0),
        dq: '0', mp: '0', am: 'NO', os: 'NEOTRADEAPI',
      });
      invalidateBrokerCache('kotak');
      return NextResponse.json({ success: true, data: res });
    }

    if (broker === 'zerodha') {
      const r = await modifyZerodhaLimitOrder({ orderId, price, quantity });
      forgetZerodhaBook();
      return r.ok ? NextResponse.json({ success: true, data: r.data }) : NextResponse.json({ success: false, error: r.error }, { status: r.status });
    }

    return NextResponse.json({ success: false, error: `Broker ${broker} order modification not yet supported` }, { status: 400 });
  } catch (err) {
    console.error('[/api/scalper/orders PATCH] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to modify order', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Cancel a pending order by ID.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json().catch(() => ({}));
    const searchParams = req.nextUrl.searchParams;
    const orderId = body?.orderId || searchParams.get('orderId');
    const broker = body?.broker || searchParams.get('broker') || 'dhan';

    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }

    if (broker === 'dhan') {
      const res = await dhanDelete(`/orders/${orderId}`);
      return NextResponse.json({ success: true, data: res });
    }

    if (broker === 'kotak') {
      const res = await kotakPost(KOTAK_PATHS.cancelOrder, { on: String(orderId), am: 'NO' });
      invalidateBrokerCache('kotak');
      return NextResponse.json({ success: true, data: res });
    }

    if (broker === 'zerodha') {
      // The Focus Tool and every other Zerodha order are variety 'regular' (CO/BO are refused by the order route).
      const res = await kiteDelete(`/orders/regular/${encodeURIComponent(String(orderId))}`);
      forgetZerodhaBook();
      invalidateBrokerCache('zerodha');
      return NextResponse.json({ success: true, data: res });
    }

    return NextResponse.json({ success: false, error: `Broker ${broker} order cancellation not yet supported` }, { status: 400 });
  } catch (err) {
    console.error('[/api/scalper/orders DELETE] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to cancel order', detail: String((err as Error).message) }, { status: 500 });
  }
}

