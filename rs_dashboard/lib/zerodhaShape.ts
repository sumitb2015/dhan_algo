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
  return {
    tradingSymbol: String(p.tradingsymbol ?? ''),
    securityId: String(p.instrument_token ?? ''),
    netQty: Number(p.quantity) || 0,
    buyQty: Number(p.buy_quantity) || 0,
    sellQty: Number(p.sell_quantity) || 0,
    buyAvg: Number(p.buy_price) || 0,
    sellAvg: Number(p.sell_price) || 0,
    lastTradedPrice: Number(p.last_price) || 0,
    realizedProfit: Number(p.realised) || 0,
    unrealizedProfit: Number(p.unrealised) || 0,
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
