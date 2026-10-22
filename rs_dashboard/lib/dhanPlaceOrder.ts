import { getDhanCredentials } from '@/lib/dhanToken';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { reserveOrderSlot, ORDER_WINDOW_MS } from '@/lib/dhanOrderPacer';
import { reconcileByCorrelationId } from '@/lib/dhanOrderReconcile';
import { FTS_DHAN_MAX_ORDER_QTY } from '@/lib/focusToolUnderlyings';

// The one way server code places a plain Dhan order (the Dhan twin of lib/kotakPlaceOrder.ts). /api/scalper/fast-order
// is a thin HTTP wrapper over it, and the Price Ladder's server watcher (lib/priceLadderServer.ts) calls it directly.
// Outcomes, never collapsed into a boolean:
//  - placed:   Dhan returned an order id, or the order was found by correlationId after an unclean reply;
//  - invalid:  refused here before anything was sent (bad field, no credentials) - safe to fix and resend;
//  - rejected: Dhan answered without an order id - nothing was booked;
//  - unknown:  no clean reply and the correlationId lookup did not find it. It MAY be live: never retry it.

const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';
const ORDER_TIMEOUT_MS = 10_000;

/** Products this route will book. CNC is included so a delivery position can be
 *  closed under its own product; CO/BO are excluded because the broker holds its
 *  own exit order against them. */
const DHAN_PRODUCTS = new Set(['INTRADAY', 'MARGIN', 'CNC']);

/** 'ts' = Triple Straddle: 50 lots (its lot cap) x 75, the largest index lot seen (NIFTY's
 *  previous size; today 65 -> 3250), so the cap stays tight yet survives a lot-size change. */
export const SOURCE_QTY_CAPS: Record<string, number> = {
  ts: 3750,
  // 'bs' = Bearish Strikes: same bound as 'ts' (50 lots x 75 units).
  bs: 3750,
  // 'bds' = Breakdown Scalper: lots are capped at 20 on the ledger, so 20 x 75 would be 1500; same bound as 'ts'.
  bds: 3750,
  // 'alab' = Algo Lab entries (lib/algoLab/configSchema.ts MAX_LOTS_PER_TRADE = 20, also checked by its ledger).
  alab: 3750,
  // 'fts' = Focus Tool: every order (closes too) is sliced under this cap and the exchange freeze on the page.
  fts: FTS_DHAN_MAX_ORDER_QTY,
  // 'pl' = Price Ladder: MAX_LADDER_LOTS (20) x 75 (the largest index lot seen), matching Kotak's 20-lot 'pl' cap.
  pl: 1500,
};

export interface DhanOrderInput {
  securityId: string;
  quantity: number;
  side: string;
  orderType?: string;
  price?: number;
  /** Stop-loss entry trigger (orderType STOP_LOSS / STOP_LOSS_MARKET only). */
  triggerPrice?: number;
  exchangeSegment?: string;
  productType?: string;
  /** Short lowercase tag prefixed to the correlationId so a caller can tell
   *  its own orders apart in the order book (MultiLegFocus sends 'mlf'). */
  source?: string;
}

export type DhanPlaceResult =
  | { status: 'placed'; orderId: string }
  | { status: 'invalid'; error: string; http: 400 | 500 }
  | { status: 'rejected'; error: string }
  | { status: 'unknown'; error: string };

export const DHAN_UNKNOWN_MSG = 'Order status unknown — Dhan did not confirm in time. Check Positions/Orders before retrying.';

export async function placeDhanOrder(body: DhanOrderInput): Promise<DhanPlaceResult> {
  const { securityId, quantity, side, orderType = 'MARKET', price = 0, exchangeSegment = 'NSE_FNO', productType: productTypeRaw } = body;

  // Reject an unrecognised product rather than coercing it to INTRADAY. A close
  // order booked under the wrong product does not reduce the position — the
  // broker opens a fresh intraday one on the other side instead. Absent still
  // defaults to INTRADAY so callers that never sent the field are unaffected.
  const productType = productTypeRaw === undefined
    ? 'INTRADAY'
    : String(productTypeRaw).toUpperCase();
  if (!DHAN_PRODUCTS.has(productType)) {
    return { status: 'invalid', http: 400, error: `Unsupported productType: ${productTypeRaw} (expected ${[...DHAN_PRODUCTS].join(' / ')})` };
  }

  if (!securityId || !quantity || !side) {
    return { status: 'invalid', http: 400, error: 'Missing required fields: securityId, quantity, side' };
  }

  const qtyNum = Number(quantity);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) {
    return { status: 'invalid', http: 400, error: `Invalid quantity: ${quantity} (must be a positive integer)` };
  }

  // Per-source sanity cap on units per order (a backstop against a UI bug, not an auth
  // boundary: callers that send no source are uncapped, as before). Rejected, never clamped.
  const sourceCap = body.source ? SOURCE_QTY_CAPS[body.source] : undefined;
  if (sourceCap !== undefined && qtyNum > sourceCap) {
    return { status: 'invalid', http: 400, error: `Quantity ${qtyNum} exceeds the ${body.source} per-order cap of ${sourceCap}` };
  }

  const sideUpper = String(side).toUpperCase();
  if (sideUpper !== 'BUY' && sideUpper !== 'SELL') {
    return { status: 'invalid', http: 400, error: `Invalid side: ${side} (must be BUY or SELL)` };
  }

  const orderTypeUpper = String(orderType).toUpperCase();
  const isStopLimit = orderTypeUpper === 'STOP_LOSS';
  const isStopMarket = orderTypeUpper === 'STOP_LOSS_MARKET';
  const isLimitOrder = orderTypeUpper === 'LIMIT' || isStopLimit;
  if (isLimitOrder && !(Number(price) > 0)) {
    return { status: 'invalid', http: 400, error: `Invalid price for ${orderTypeUpper} order: ${price}` };
  }
  // Stop-loss entries rest at the exchange until the trigger prints. Anything but a
  // positive trigger is rejected here (never defaulted to a market order), and a limit
  // that sits on the wrong side of its trigger could never fill after triggering.
  const triggerNum = Number(body.triggerPrice) || 0;
  if (isStopLimit || isStopMarket) {
    if (!(triggerNum > 0)) {
      return { status: 'invalid', http: 400, error: `Invalid triggerPrice for ${orderTypeUpper} order: ${body.triggerPrice}` };
    }
    if (isStopLimit && (sideUpper === 'BUY' ? Number(price) < triggerNum : Number(price) > triggerNum)) {
      return { status: 'invalid', http: 400, error: `${sideUpper} STOP_LOSS limit ${price} must be ${sideUpper === 'BUY' ? '>=' : '<='} its trigger ${triggerNum}` };
    }
  }

  const prefix = typeof body.source === 'string' && /^[a-z]{2,4}$/.test(body.source) ? body.source : 'wr';
  const correlationId = `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

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
    console.error('[dhanPlaceOrder] failed to load Dhan credentials:', err);
    return { status: 'invalid', http: 500, error: String((err as Error).message ?? err) };
  }

  try {
    const payload = {
      dhanClientId:     clientId,
      correlationId,
      transactionType:  sideUpper,
      exchangeSegment,
      productType,
      orderType:        isStopLimit ? 'STOP_LOSS' : isStopMarket ? 'STOP_LOSS_MARKET' : isLimitOrder ? 'LIMIT' : 'MARKET',
      validity:         'DAY',
      securityId:       String(securityId),
      quantity:         qtyNum,
      disclosedQuantity: 0,
      price:            isLimitOrder ? Number(price) : 0,
      afterMarketOrder: false,
      boProfitValue:    0,
      boStopLossValue:  0,
      triggerPrice:     (isStopLimit || isStopMarket) ? triggerNum : 0,
    };

    const send = async () => {
      await reserveOrderSlot();
      return fetch(DHAN_ORDERS, {
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
    };
    let res = await send();
    // HTTP 429 means Dhan rejected the request before booking anything, so ONE retry
    // after the window rolls over cannot double-place (unlike a timeout, which is
    // reconciled by correlationId below). No further retries: a sustained limit
    // should surface as a rejected order, not loop.
    if (res.status === 429) {
      console.warn('[dhanPlaceOrder] Dhan 429 — retrying once after the rate window');
      await new Promise(r => setTimeout(r, ORDER_WINDOW_MS + 100));
      res = await send();
    }

    const json = await res.json() as Record<string, unknown>;

    // Dhan order API returns {orderId, orderStatus:"TRANSIT"} on success — no "status" field
    const orderId = String(json.orderId ?? (json.data as Record<string, unknown> | undefined)?.orderId ?? '');
    if (orderId) {
      invalidateBrokerCache('dhan');
      return { status: 'placed', orderId };
    }

    const errMsg = String(json.remarks ?? json.message ?? JSON.stringify(json));
    console.error('[dhanPlaceOrder] Dhan API error:', errMsg, 'HTTP', res.status);
    return { status: 'rejected', error: errMsg };

  } catch (err) {
    // The place-order call itself timed out or errored — we never got a clean
    // HTTP response, so we don't actually know whether Dhan booked it. Do not
    // report a flat failure (a retry on a real fill would double-exit/enter);
    // reconcile by correlationId first.
    console.error('[dhanPlaceOrder] request failed, reconciling by correlationId:', correlationId, err);

    const recoveredOrderId = await reconcileByCorrelationId(correlationId, clientId, token);
    if (recoveredOrderId) {
      invalidateBrokerCache('dhan');
      return { status: 'placed', orderId: recoveredOrderId };
    }
    return { status: 'unknown', error: DHAN_UNKNOWN_MSG };
  }
}
