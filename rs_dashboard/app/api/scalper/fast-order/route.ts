import { NextRequest, NextResponse } from 'next/server';
import { getDhanCredentials } from '@/lib/dhanToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';
const ORDER_TIMEOUT_MS = 10_000;
const RECONCILE_TIMEOUT_MS = 8_000;
const RECONCILE_ATTEMPTS = 3;
const RECONCILE_GAP_MS = 2_000;

/** Products this route will book. CNC is included so a delivery position can be
 *  closed under its own product; CO/BO are excluded because the broker holds its
 *  own exit order against them. */
const DHAN_PRODUCTS = new Set(['INTRADAY', 'MARGIN', 'CNC']);

/**
 * The initial place-order call timed out or errored before we got a clean
 * HTTP response — we genuinely don't know whether Dhan received and booked
 * it. Look it up by the correlationId we tagged it with rather than assuming
 * failure: a delayed-but-successful order must never be reported as failed,
 * since that invites a dangerous duplicate exit/entry. Dhan can take a few
 * seconds to make a fresh order visible on this lookup, so retry briefly.
 */
async function reconcileByCorrelationId(correlationId: string, clientId: string, token: string): Promise<string | null> {
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RECONCILE_GAP_MS));
    try {
      const res = await fetch(`${DHAN_ORDERS}/external/${correlationId}`, {
        headers: { 'access-token': token, 'client-id': clientId, Accept: 'application/json' },
        signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const json = await res.json() as Record<string, unknown> | Record<string, unknown>[];
      const row = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
      // Only trust this row if it actually echoes back the correlationId we
      // sent — never adopt an order_id from a mismatched/unrelated row.
      if (row && String(row.correlationId ?? '') === correlationId) {
        const orderId = String(row.orderId ?? '');
        if (orderId) return orderId;
      }
    } catch {
      // Dhan may still be catching up — keep trying within the attempt budget.
    }
  }
  return null;
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ready: true });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json() as {
    securityId: string;
    quantity: number;
    side: string;
    orderType?: string;
    price?: number;
    exchangeSegment?: string;
    productType?: string;
  };

  const { securityId, quantity, side, orderType = 'MARKET', price = 0, exchangeSegment = 'NSE_FNO', productType: productTypeRaw } = body;

  // Reject an unrecognised product rather than coercing it to INTRADAY. A close
  // order booked under the wrong product does not reduce the position — the
  // broker opens a fresh intraday one on the other side instead. Absent still
  // defaults to INTRADAY so callers that never sent the field are unaffected.
  const productType = productTypeRaw === undefined
    ? 'INTRADAY'
    : String(productTypeRaw).toUpperCase();
  if (!DHAN_PRODUCTS.has(productType)) {
    return NextResponse.json(
      { success: false, error: `Unsupported productType: ${productTypeRaw} (expected ${[...DHAN_PRODUCTS].join(' / ')})` },
      { status: 400 },
    );
  }

  if (!securityId || !quantity || !side) {
    return NextResponse.json({ success: false, error: 'Missing required fields: securityId, quantity, side' }, { status: 400 });
  }

  const qtyNum = Number(quantity);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
    return NextResponse.json({ success: false, error: `Invalid quantity: ${quantity} (must be a positive integer)` }, { status: 400 });
  }

  const sideUpper = String(side).toUpperCase();
  if (sideUpper !== 'BUY' && sideUpper !== 'SELL') {
    return NextResponse.json({ success: false, error: `Invalid side: ${side} (must be BUY or SELL)` }, { status: 400 });
  }

  const isLimitOrder = String(orderType).toUpperCase() === 'LIMIT';
  if (isLimitOrder && !(Number(price) > 0)) {
    return NextResponse.json({ success: false, error: `Invalid price for LIMIT order: ${price}` }, { status: 400 });
  }

  const correlationId = `wr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

  // Resolved outside the reconcile-on-failure try/catch below: a credentials
  // failure (missing/expired access_token.json — routine, since the token
  // expires every ~24h per CLAUDE.md) means no request was ever sent to
  // Dhan, so it must surface its own real error, not the generic
  // "order status unknown, check Positions" message meant for an ambiguous
  // network timeout.
  let clientId: string;
  let token: string;
  try {
    ({ clientId, token } = getDhanCredentials());
  } catch (err) {
    console.error('[scalper/fast-order] failed to load Dhan credentials:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }

  try {
    const payload = {
      dhanClientId:     clientId,
      correlationId,
      transactionType:  sideUpper,
      exchangeSegment,
      productType,
      orderType:        isLimitOrder ? 'LIMIT' : 'MARKET',
      validity:         'DAY',
      securityId:       String(securityId),
      quantity:         qtyNum,
      disclosedQuantity: 0,
      price:            isLimitOrder ? Number(price) : 0,
      afterMarketOrder: false,
      boProfitValue:    0,
      boStopLossValue:  0,
      triggerPrice:     0,
    };

    const res = await fetch(DHAN_ORDERS, {
      method:  'POST',
      headers: {
        'access-token':  token,
        'client-id':     clientId,
        'Content-Type':  'application/json',
        'Accept':        'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(ORDER_TIMEOUT_MS),
    });

    const json = await res.json() as Record<string, unknown>;

    // Dhan order API returns {orderId, orderStatus:"TRANSIT"} on success — no "status" field
    const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
    if (orderId) {
      invalidateBrokerCache('dhan');
      return NextResponse.json({ success: true, order_id: orderId });
    }

    const errMsg = String(json.remarks ?? json.message ?? JSON.stringify(json));
    console.error('[scalper/fast-order] Dhan API error:', errMsg, 'HTTP', res.status);
    return NextResponse.json({ success: false, error: errMsg });

  } catch (err) {
    // The place-order call itself timed out or errored — we never got a clean
    // HTTP response, so we don't actually know whether Dhan booked it. Do not
    // report a flat failure (a retry on a real fill would double-exit/enter);
    // reconcile by correlationId first.
    console.error('[scalper/fast-order] request failed, reconciling by correlationId:', correlationId, err);

    const recoveredOrderId = await reconcileByCorrelationId(correlationId, clientId, token);
    if (recoveredOrderId) {
      invalidateBrokerCache('dhan');
      return NextResponse.json({ success: true, order_id: recoveredOrderId });
    }

    return NextResponse.json(
      { success: false, error: 'Order status unknown — Dhan did not confirm in time. Check Positions/Orders before retrying.' },
      { status: 504 },
    );
  }
}
