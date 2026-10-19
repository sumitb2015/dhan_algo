import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';

export interface ScalperPosition {
  tradingSymbol: string;
  securityId: string;
  exchange: string;
  netQty: number;
  buyQty: number;
  sellQty: number;
  buyAvg: number;
  sellAvg: number;
  lastTradedPrice: number;
  realizedProfit: number;
  unrealizedProfit: number;
  productType: string;
  /** Kotak only: the contract's lot in the same units as the quantities (`lotSz`; 10 for a CRUDEOILM lot of 150 = 15 lots). */
  lotSize?: number;
  carryForwardBuyQty?: number;
  carryForwardSellQty?: number;
  carryForwardBuyValue?: number;
  carryForwardSellValue?: number;
  overnightQuantity?: number;
  cfBuyQty?: number;
  cfSellQty?: number;
  cfBuyAmt?: number;
  cfSellAmt?: number;
}

export interface ScalperOrder {
  orderId: string;
  tradingSymbol: string;
  orderStatus: string;
  transactionType: string;
  quantity: number;
  price: number;
  orderType: string;
  createTime: string;
  /** Traded average; 0 until something fills. */
  averagePrice?: number;
  /** Quantity traded so far (Kotak reports it per order; lets a part-filled cancel be sized). */
  filledQty?: number;
}

export interface ScalperTrade {
  tradingSymbol: string;
  transactionType: string;
  tradedQuantity: number;
  tradedPrice: number;
  createTime: string;
  /** Broker order / fill ids — let MultiLegFocus tell its own trades from outside ones. */
  orderId?: string;
  tradeId?: string;
}

export function shapeZerodhaPosition(p: Record<string, any>): ScalperPosition {
  const netQty = Number(p.quantity) || 0;
  const lastPrice = Number(p.last_price) || 0;
  const buyAvg = Number(p.buy_price) || 0;
  const sellAvg = Number(p.sell_price) || 0;
  const overnightQty = Number(p.overnight_quantity) || 0;
  // Do NOT map Kite's `realised`/`unrealised` fields directly: on a closed
  // intraday position both can carry the full day P&L, and the UI (which sums
  // realized + unrealized) then shows exactly double. Kite's authoritative
  // number is `pnl` (= sell_value - buy_value + netQty * last_price); derive
  // the split from it — the open quantity's mark-to-market is unrealized,
  // everything else is realized (0/full-pnl respectively when flat).
  const totalPnl = Number(p.pnl) || 0;
  // MCX quantity is a count of LOTS, so the per-unit move is multiplied by barrels per lot (Kite's own `multiplier`,
  // else the repo's table). Kite's `pnl` already includes it, so `unrealized` must too or the realized split is wrong.
  const exchange = String(p.exchange ?? 'NFO');
  const root = String(p.tradingsymbol ?? '').toUpperCase().match(/^[A-Z]+/)?.[0] ?? '';
  const mult = exchange === 'MCX' ? (Number(p.multiplier) > 1 ? Number(p.multiplier) : (MCX_LOT_MULTIPLIER[root] ?? 1)) : 1;
  const unrealized = netQty === 0 ? 0 : netQty * (lastPrice - (netQty > 0 ? buyAvg : sellAvg)) * mult;
  const base: ScalperPosition = {
    tradingSymbol: String(p.tradingsymbol ?? ''),
    securityId: String(p.instrument_token ?? ''),
    exchange,
    netQty,
    buyQty: Number(p.buy_quantity) || 0,
    sellQty: Number(p.sell_quantity) || 0,
    buyAvg,
    sellAvg,
    lastTradedPrice: lastPrice,
    realizedProfit: totalPnl - unrealized,
    unrealizedProfit: unrealized,
    productType: String(p.product ?? ''),
  };
  if (overnightQty !== 0) {
    base.overnightQuantity = overnightQty;
    base.carryForwardBuyQty = overnightQty > 0 ? overnightQty : 0;
    base.carryForwardSellQty = overnightQty < 0 ? Math.abs(overnightQty) : 0;
    base.carryForwardBuyValue = overnightQty > 0 ? overnightQty * buyAvg : 0;
    base.carryForwardSellValue = overnightQty < 0 ? Math.abs(overnightQty) * sellAvg : 0;
  }
  return base;
}

export function shapeZerodhaOrder(o: Record<string, any>): ScalperOrder {
  return {
    orderId: String(o.order_id ?? ''),
    tradingSymbol: String(o.tradingsymbol ?? ''),
    orderStatus: String(o.status ?? ''),
    transactionType: String(o.transaction_type ?? ''),
    quantity: Number(o.quantity) || 0,
    price: Number(o.price) || 0,
    orderType: String(o.order_type ?? ''),
    createTime: String(o.order_timestamp ?? ''),
    averagePrice: Number(o.average_price) || 0,
  };
}

export function shapeZerodhaTrade(t: Record<string, any>): ScalperTrade {
  return {
    tradingSymbol: String(t.tradingsymbol ?? ''),
    transactionType: String(t.transaction_type ?? ''),
    tradedQuantity: Number(t.quantity) || 0,
    tradedPrice: Number(t.average_price) || 0,
    createTime: String(t.fill_timestamp ?? ''),
    ...(t.order_id != null ? { orderId: String(t.order_id) } : {}),
    ...(t.trade_id != null ? { tradeId: String(t.trade_id) } : {}),
  };
}

const KITE_REJECTED = new Set(['REJECTED']);
const KITE_CANCELLED = new Set(['CANCELLED', 'CANCELED']);

/**
 * Kite order status -> Dhan's vocabulary (the one /api/scalper/orders?orderId= answers in). EXACT matches only: Kite's
 * transient states ("CANCEL PENDING", "MODIFY PENDING", "PUT ORDER REQ RECEIVED", "VALIDATION PENDING") are orders
 * still live. COMPLETE is TRADED; a fill equal to a positive order quantity is a fill whatever the word.
 */
export function classifyZerodhaStatus(status: string, filled: number, qty: number): string {
  const st = status.trim().toUpperCase();
  if (st === 'COMPLETE') return 'TRADED';
  if (KITE_REJECTED.has(st)) return 'REJECTED';
  if (KITE_CANCELLED.has(st)) return 'CANCELLED';
  if (qty > 0 && filled >= qty) return 'TRADED';
  if (filled > 0) return 'PART_TRADED';
  return st === 'OPEN' || st === 'TRIGGER PENDING' ? 'PENDING' : 'TRANSIT';
}

/** One order-book row as the per-order status payload (same shape as Dhan's and shapeKotakOrderStatus). */
export function shapeZerodhaOrderStatus(o: Record<string, any>, fallbackId = '') {
  const qty = Number(o.quantity) || 0;
  const filled = Number(o.filled_quantity) || 0;
  return {
    orderId: String(o.order_id ?? fallbackId),
    orderStatus: classifyZerodhaStatus(String(o.status ?? ''), filled, qty),
    quantity: qty,
    filledQty: filled,
    averageTradedPrice: Number(o.average_price) || 0,
    reason: String(o.status_message ?? o.status_message_raw ?? ''),
  };
}
