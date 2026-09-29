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
const RECONCILE_ATTEMPTS = 4;
const RECONCILE_GAP_MS = 1_500;

/**
 * The place call timed out, errored, or came back as a 5xx: we don't know whether Dhan
 * booked it. Look it up by our correlationId instead of reporting a failure, since a
 * "failed" order that actually went through invites a duplicate on retry. Same approach
 * as app/api/scalper/fast-order.
 */
async function reconcileByCorrelationId(correlationId: string, clientId: string, token: string) {
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, RECONCILE_GAP_MS));
    try {
      const res = await fetch(`${DHAN_ORDERS}/external/${correlationId}`, {
        headers: { 'access-token': token, 'client-id': clientId, Accept: 'application/json' },
        signal: AbortSignal.timeout(5_000),
      });
      if (!res.ok) continue;
      const json = (await res.json()) as Record<string, unknown> | Record<string, unknown>[];
      const r = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
      // Only adopt a row that echoes our own correlationId.
      if (r && String(r.correlationId ?? '') === correlationId && r.orderId) {
        return { orderId: String(r.orderId), orderStatus: r.orderStatus ?? null };
      }
    } catch { /* Dhan may still be catching up */ }
  }
  return null;
}

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

  const correlationId = `os${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const label = `${side} ${lots} lot${lots === 1 ? '' : 's'} ${row.u} ${row.e} ${row.s} ${row.t}`;
  const summary = `${label} · qty ${qty} · ${product} · ${orderType}${orderType === 'LIMIT' ? ` @ ${price}` : ''}`;

  const payload = {
    dhanClientId: creds.clientId,
    correlationId,
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

  const unknownOutcome = async (why: string) => {
    const found = await reconcileByCorrelationId(correlationId, creds.clientId, creds.token);
    invalidateBrokerCache('dhan');
    if (found) {
      return NextResponse.json({ success: true, orderId: found.orderId, orderStatus: found.orderStatus, summary });
    }
    return NextResponse.json(
      {
        success: false,
        unknown: true,
        error: `Order status unknown (${why}). Dhan did not confirm ${label} — check the Dhan order book before placing it again.`,
      },
      { status: 504 },
    );
  };

  let res: Response;
  try {
    res = await fetch(DHAN_ORDERS, {
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
  } catch (e) {
    return unknownOutcome(String(e));
  }
  // A gateway error can arrive after the order was booked; a 4xx/429 is a pre-booking rejection.
  if (res.status >= 500) return unknownOutcome(`HTTP ${res.status}`);

  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
  if (!orderId) {
    const err = String(json.errorMessage ?? json.remarks ?? json.message ?? JSON.stringify(json));
    return NextResponse.json({ success: false, error: `Dhan rejected ${label}: ${err}` }, { status: 502 });
  }
  invalidateBrokerCache('dhan');
  return NextResponse.json({ success: true, orderId, orderStatus: json.orderStatus ?? null, summary });
}
