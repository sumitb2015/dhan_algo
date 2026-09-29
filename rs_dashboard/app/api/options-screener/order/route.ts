import { NextRequest, NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { readScreenerSnapshot } from '@/lib/optionsScreenerStore';
import { roundToTick } from '@/lib/optionsScreener';

/**
 * POST — place a single-leg Dhan option order for a contract the screener is tracking.
 *
 * REAL MONEY. The client sends only the contract id, side, lots and price; the security id,
 * exchange segment, lot size and tick all come from the collector's snapshot, so the
 * page can never trade an instrument it isn't showing, and the quantity is always
 * lots × the contract's own lot (Dhan MCX quantity is lots, which the snapshot encodes
 * as lot = 1).
 */

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';
const MAX_LOTS_PER_ORDER = 25;
const MAX_QTY_PER_ORDER = 30_000;

interface OrderBody {
  id?: string;
  side?: string;
  lots?: number;
  orderType?: string;
  price?: number;
  product?: string;
}

export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as OrderBody | null;
  if (!body) return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });

  const side = body.side === 'BUY' || body.side === 'SELL' ? body.side : null;
  const orderType = body.orderType === 'LIMIT' ? 'LIMIT' : body.orderType === 'MARKET' ? 'MARKET' : null;
  const product = body.product === 'MARGIN' ? 'MARGIN' : body.product === 'INTRADAY' ? 'INTRADAY' : null;
  const lots = Number(body.lots);
  if (!side || !orderType || !product) {
    return NextResponse.json({ success: false, error: 'side, orderType and product are required' }, { status: 400 });
  }
  if (!Number.isInteger(lots) || lots <= 0) {
    return NextResponse.json({ success: false, error: 'Lots must be a positive integer' }, { status: 400 });
  }
  if (lots > MAX_LOTS_PER_ORDER) {
    return NextResponse.json(
      { success: false, error: `Order exceeds max allowed lots (${MAX_LOTS_PER_ORDER}). Please split the order.` },
      { status: 400 },
    );
  }

  const loaded = readScreenerSnapshot();
  const row = loaded?.byId.get(String(body.id ?? ''));
  if (!row) {
    return NextResponse.json(
      { success: false, error: 'Contract is not in the screener snapshot — refresh and try again' },
      { status: 400 },
    );
  }

  const qty = lots * row.lot;
  if (!Number.isFinite(qty) || qty <= 0 || qty > MAX_QTY_PER_ORDER) {
    return NextResponse.json({ success: false, error: `Quantity ${qty} outside the safety limit` }, { status: 400 });
  }

  let price = 0;
  if (orderType === 'LIMIT') {
    const p = Number(body.price);
    if (!Number.isFinite(p) || p <= 0) {
      return NextResponse.json({ success: false, error: 'LIMIT order requires a valid price' }, { status: 400 });
    }
    // Option ticks are ₹0.01–₹0.50. A larger value means a snapshot written before the
    // collector converted master_list's paise TICK_SIZE — rounding to it would move the price.
    if (!(row.tick > 0 && row.tick <= 1)) {
      return NextResponse.json(
        { success: false, error: `Implausible tick ${row.tick} in snapshot — restart the collector` },
        { status: 400 },
      );
    }
    price = roundToTick(p, row.tick);
    // A fat-fingered limit far from the market fills instantly at a terrible price on a BUY
    // (or gives the premium away on a SELL). Refuse anything wildly off the last print.
    if (row.ltp > 0 && (price > row.ltp * 3 + 5 || price < row.ltp / 3 - 5)) {
      return NextResponse.json(
        { success: false, error: `Limit ${price} is too far from LTP ${row.ltp} — check the price` },
        { status: 400 },
      );
    }
  }

  let creds: { clientId: string; token: string };
  try {
    creds = getDhanCredentials();
  } catch (e) {
    return NextResponse.json({ success: false, error: `Dhan token unavailable: ${String(e)}` }, { status: 500 });
  }

  const payload = {
    dhanClientId: creds.clientId,
    transactionType: side,
    exchangeSegment: row.xs,
    productType: product,
    orderType,
    validity: 'DAY',
    securityId: row.sid,
    quantity: qty,
    disclosedQuantity: 0,
    price,
    triggerPrice: 0,
    afterMarketOrder: false,
  };

  try {
    const res = await fetch(DHAN_ORDERS, {
      method: 'POST',
      headers: {
        'access-token': creds.token,
        'client-id': creds.clientId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15_000),
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
    const label = `${side} ${lots} lot${lots === 1 ? '' : 's'} ${row.u} ${row.e} ${row.s} ${row.t}`;
    if (!orderId) {
      const err = String(json.errorMessage ?? json.remarks ?? json.message ?? JSON.stringify(json));
      return NextResponse.json({ success: false, error: `Dhan rejected ${label}: ${err}` }, { status: 502 });
    }
    invalidateBrokerCache('dhan');
    return NextResponse.json({
      success: true,
      orderId,
      orderStatus: json.orderStatus ?? null,
      summary: `${label} · qty ${qty} · ${product} · ${orderType}${orderType === 'LIMIT' ? ` @ ${price}` : ''}`,
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: `Order request failed: ${String(e)}` }, { status: 502 });
  }
}
