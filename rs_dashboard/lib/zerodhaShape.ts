export interface ScalperPosition {
  tradingSymbol: string;
  securityId: string;
  netQty: number;
  buyQty: number;
  sellQty: number;
  buyAvg: number;
  sellAvg: number;
  lastTradedPrice: number;
  realizedProfit: number;
  unrealizedProfit: number;
  productType: string;
}

export interface ScalperOrder {
  tradingSymbol: string;
  orderStatus: string;
  transactionType: string;
  quantity: number;
  price: number;
  orderType: string;
  createTime: string;
}

export interface ScalperTrade {
  tradingSymbol: string;
  transactionType: string;
  tradedQuantity: number;
  tradedPrice: number;
  createTime: string;
}

export function shapeZerodhaPosition(p: Record<string, any>): ScalperPosition {
  const netQty = Number(p.quantity) || 0;
  const lastPrice = Number(p.last_price) || 0;
  const buyAvg = Number(p.buy_price) || 0;
  const sellAvg = Number(p.sell_price) || 0;
  // Do NOT map Kite's `realised`/`unrealised` fields directly: on a closed
  // intraday position both can carry the full day P&L, and the UI (which sums
  // realized + unrealized) then shows exactly double. Kite's authoritative
  // number is `pnl` (= sell_value - buy_value + netQty * last_price); derive
  // the split from it — the open quantity's mark-to-market is unrealized,
  // everything else is realized (0/full-pnl respectively when flat).
  const totalPnl = Number(p.pnl) || 0;
  const unrealized = netQty === 0 ? 0 : netQty * (lastPrice - (netQty > 0 ? buyAvg : sellAvg));
  return {
    tradingSymbol: String(p.tradingsymbol ?? ''),
    securityId: String(p.instrument_token ?? ''),
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
}

export function shapeZerodhaOrder(o: Record<string, any>): ScalperOrder {
  return {
    tradingSymbol: String(o.tradingsymbol ?? ''),
    orderStatus: String(o.status ?? ''),
    transactionType: String(o.transaction_type ?? ''),
    quantity: Number(o.quantity) || 0,
    price: Number(o.price) || 0,
    orderType: String(o.order_type ?? ''),
    createTime: String(o.order_timestamp ?? ''),
  };
}

export function shapeZerodhaTrade(t: Record<string, any>): ScalperTrade {
  return {
    tradingSymbol: String(t.tradingsymbol ?? ''),
    transactionType: String(t.transaction_type ?? ''),
    tradedQuantity: Number(t.quantity) || 0,
    tradedPrice: Number(t.average_price) || 0,
    createTime: String(t.fill_timestamp ?? ''),
  };
}
