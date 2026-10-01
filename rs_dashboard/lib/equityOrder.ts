// Pure order rules for the NSE cash-equity ticket (RS Strategy page and any future equity desk).
// No fs / fetch here so `node --test` can load it; the route does the I/O and hands the facts in.
// REAL MONEY: every limit below is enforced again on the server, never only in the modal.

export type Side = 'BUY' | 'SELL';
export type Product = 'CNC' | 'INTRADAY';
export type OrderType = 'MARKET' | 'LIMIT';

/** Hard ceilings per single order. Split bigger orders; raise deliberately, not casually. */
export const MAX_QTY_PER_ORDER = 10_000;
export const MAX_ORDER_VALUE = 500_000; // INR
/** A LIMIT price further than this from the live price is almost certainly a typo. */
export const LIMIT_BAND = 0.2;

export interface OrderRequest {
  side?: unknown;
  product?: unknown;
  orderType?: unknown;
  quantity?: unknown;
  price?: unknown;
  amo?: unknown;
}

export interface OrderFacts {
  ltp: number; // live price from Dhan, > 0
  tick: number; // INR, e.g. 0.05
  availableQty: number; // sellable delivery quantity from Dhan holdings
  intradayLongQty: number; // today's open long Intraday (MIS) net quantity from Dhan positions
  pendingSellQty: number; // shares already committed to OPEN sell orders in the same product
}

export interface ValidOrder {
  side: Side;
  product: Product;
  orderType: OrderType;
  quantity: number;
  price: number; // 0 for MARKET
  amo: boolean;
  value: number; // INR notional used for the cap (limit price, or LTP for market)
}

export type Validation = { ok: true; order: ValidOrder } | { ok: false; error: string };

export function roundToTick(price: number, tick: number): number {
  return Number((Math.round(price / tick) * tick).toFixed(2));
}

export function validateOrder(req: OrderRequest, facts: OrderFacts): Validation {
  const side = req.side === 'BUY' || req.side === 'SELL' ? req.side : null;
  const product = req.product === 'CNC' || req.product === 'INTRADAY' ? req.product : null;
  const orderType = req.orderType === 'MARKET' || req.orderType === 'LIMIT' ? req.orderType : null;
  if (!side || !product || !orderType) {
    return { ok: false, error: 'side, product and orderType are required' };
  }

  const quantity = Number(req.quantity);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return { ok: false, error: 'Quantity must be a positive whole number' };
  }
  if (quantity > MAX_QTY_PER_ORDER) {
    return { ok: false, error: `Order exceeds max allowed quantity (${MAX_QTY_PER_ORDER}). Please split the order.` };
  }

  if (!(facts.ltp > 0)) return { ok: false, error: 'No live price available — try again in a moment' };
  if (!(facts.tick > 0 && facts.tick <= 1)) return { ok: false, error: `Implausible tick size ${facts.tick}` };

  let price = 0;
  if (orderType === 'LIMIT') {
    const p = Number(req.price);
    if (!Number.isFinite(p) || p <= 0) return { ok: false, error: 'LIMIT order requires a valid price' };
    price = roundToTick(p, facts.tick);
    if (price < facts.ltp * (1 - LIMIT_BAND) || price > facts.ltp * (1 + LIMIT_BAND)) {
      return { ok: false, error: `Limit ${price} is more than ${LIMIT_BAND * 100}% from the live price ${facts.ltp} — check the price` };
    }
  }

  const value = quantity * (orderType === 'LIMIT' ? price : facts.ltp);
  if (value > MAX_ORDER_VALUE) {
    return { ok: false, error: `Order value ₹${Math.round(value).toLocaleString('en-IN')} exceeds the ₹${MAX_ORDER_VALUE.toLocaleString('en-IN')} per-order limit. Please split the order.` };
  }

  // A SELL may only close something you own. Short-selling is never allowed from this ticket:
  // Delivery sells draw on holdings, Intraday sells only on today's open long Intraday position.
  if (side === 'SELL') {
    const owned = product === 'CNC' ? facts.availableQty : facts.intradayLongQty;
    const pending = Math.max(0, facts.pendingSellQty);
    const own = owned - pending; // an open sell order has already claimed these shares
    const what = product === 'CNC' ? 'Delivery holding' : 'open Intraday position';
    if (owned <= 0) {
      return { ok: false, error: `You have no ${what} in this stock, so there is nothing to sell. Short-selling is not allowed from this ticket.` };
    }
    if (own <= 0) {
      return { ok: false, error: `All ${owned} of your ${what} is already committed to open sell orders. Cancel one first, or wait for it to fill.` };
    }
    if (quantity > own) {
      return { ok: false, error: `You can sell at most ${own} (${owned} owned${pending > 0 ? `, ${pending} already in open sell orders` : ''}). Reduce the quantity.` };
    }
  }

  return { ok: true, order: { side, product, orderType, quantity, price, amo: req.amo === true, value } };
}

const OPEN_STATUSES = new Set(['TRANSIT', 'PENDING', 'PART_TRADED', 'CONFIRM']);

/**
 * Shares already committed to OPEN sell orders for one NSE equity security + product, from Dhan's
 * /orders rows. Counts only the unfilled remainder of live orders; filled, rejected and cancelled
 * orders have already been reflected in holdings/positions or never existed.
 */
export function pendingSellQty(
  orders: Record<string, unknown>[],
  securityId: string,
  product: Product,
): number {
  const n = (v: unknown) => Number(v ?? 0) || 0;
  return orders
    .filter((o) =>
      String(o.securityId) === String(securityId) &&
      String(o.exchangeSegment) === 'NSE_EQ' &&
      String(o.transactionType) === 'SELL' &&
      String(o.productType) === product &&
      OPEN_STATUSES.has(String(o.orderStatus)))
    .reduce((sum, o) => sum + Math.max(0, o.remainingQuantity !== undefined ? n(o.remainingQuantity) : n(o.quantity) - n(o.filledQty)), 0);
}
