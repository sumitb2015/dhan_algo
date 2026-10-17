import { snapToTick, sourceLotCapError } from './kotakOrderRules.ts';

/**
 * Kotak Neo's place-order body from a dashboard order, with every check that refuses an order before it is sent.
 * Shared by /api/scalper/kotak/order (one order) and /api/options/order (a basket, broker 'kotak') so both book
 * identically. Pure: the contract (lot size, tick) is looked up by the caller (lib/kotakContracts.ts).
 */

/** Products these routes book. CO/BO are excluded — Neo holds its own exit order against them, which a plain market
 *  order would leave dangling. */
export const NEO_PRODUCTS = new Set(['MIS', 'NRML', 'CNC']);

export interface KotakOrderInput {
  tradingsymbol: string;
  quantity: number;
  side: string;
  orderType?: string;
  price?: number;
  /** Stop orders (orderType SL / SLM): the trigger the exchange watches. */
  triggerPrice?: number;
  exchange?: string;
  /** Absent = MIS (callers that never sent the field keep their old behaviour). */
  product?: string;
  /** Calling terminal, for SOURCE_LOT_CAPS. Absent = uncapped (closes, other desks). */
  source?: string;
}

export interface KotakContractInfo { lotSize: number | null; tick: number | null }

export function buildKotakOrderPayload(
  input: KotakOrderInput,
  contract: KotakContractInfo | null,
): { payload: Record<string, string> } | { error: string } {
  const { tradingsymbol, quantity, side, orderType = 'MARKET', price = 0, exchange = 'nse_fo', product: productRaw } = input;

  // Reject an unrecognised product rather than coercing it to MIS. A close order booked under the wrong product does
  // not reduce the position — Neo opens a fresh intraday one on the other side instead.
  const product = productRaw === undefined ? 'MIS' : String(productRaw).toUpperCase();
  if (!NEO_PRODUCTS.has(product)) {
    return { error: `Unsupported product: ${productRaw} (expected ${[...NEO_PRODUCTS].join(' / ')})` };
  }
  if (!tradingsymbol || !quantity || !side) return { error: 'Missing required fields: tradingsymbol, quantity, side' };

  const qtyNum = Number(quantity);
  if (!Number.isInteger(qtyNum) || qtyNum <= 0) return { error: `Invalid quantity: ${quantity} (must be a positive integer)` };

  const sideUpper = String(side).toUpperCase();
  if (sideUpper !== 'BUY' && sideUpper !== 'SELL') return { error: `Invalid side: ${side} (must be BUY or SELL)` };

  const orderTypeUpper = String(orderType).toUpperCase();
  const isStopLimit = orderTypeUpper === 'SL' || orderTypeUpper === 'STOP_LOSS';
  const isStopMarket = orderTypeUpper === 'SLM' || orderTypeUpper === 'SL-M' || orderTypeUpper === 'STOP_LOSS_MARKET';
  const isLimitOrder = orderTypeUpper === 'LIMIT' || isStopLimit;
  if (isLimitOrder && !(Number(price) > 0)) return { error: `Invalid price for ${orderTypeUpper} order: ${price}` };
  // A stop with no positive trigger must never fall through as a market order.
  const triggerNum = Number(input.triggerPrice) || 0;
  if ((isStopLimit || isStopMarket) && !(triggerNum > 0)) {
    return { error: `Invalid triggerPrice for ${orderTypeUpper} order: ${input.triggerPrice}` };
  }
  if (isStopLimit && (sideUpper === 'BUY' ? Number(price) < triggerNum : Number(price) > triggerNum)) {
    return { error: `${sideUpper} ${orderTypeUpper} limit ${price} must be ${sideUpper === 'BUY' ? '>=' : '<='} its trigger ${triggerNum}` };
  }

  const isDerivative = /_fo$/i.test(String(exchange));
  // Per-source lot cap (lib/kotakOrderRules): only callers that name a source, on opening orders.
  const capError = sourceLotCapError(qtyNum, input.source, String(tradingsymbol), contract?.lotSize ?? null);
  if (capError) return { error: capError };

  // Snap derivative prices to the contract's own tick so the exchange never rejects an otherwise-valid price (an MCX
  // future ticks at 1.00). A cash-equity price (nse_cm, ticks down to 0.01) is the caller's own and is only rounded.
  const snap = (v: number) => snapToTick(v, contract?.tick);
  const tickPrice = !isLimitOrder ? '0'
    : isDerivative ? snap(Number(price))
    : (Math.round(Number(price) * 100) / 100).toFixed(2);

  return {
    payload: {
      es: String(exchange).toLowerCase(),          // exchange segment
      pc: product,                                  // product code
      pr: tickPrice,                                // price
      pt: isStopLimit ? 'SL' : isStopMarket ? 'SL-M' : isLimitOrder ? 'L' : 'MKT',  // price type
      qt: String(qtyNum),                           // absolute quantity, not lots
      rt: 'DAY',                                    // retention/validity
      ts: tradingsymbol,                            // trading symbol
      tt: sideUpper === 'BUY' ? 'B' : 'S',          // transaction type
      am: 'NO',
      dq: '0',
      mp: '0',
      pf: 'N',
      tp: (isStopLimit || isStopMarket) ? (isDerivative ? snap(triggerNum) : (Math.round(triggerNum / 0.05) * 0.05).toFixed(2)) : '0',  // trigger price
      os: 'NEOTRADEAPI',
    },
  };
}
