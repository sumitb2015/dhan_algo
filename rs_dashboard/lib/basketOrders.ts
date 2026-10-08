import type { LegSide, OptionType } from './basketStrategies';
import type { Broker } from '@/hooks/useBrokerSelector';

export interface OrderLeg {
  side: LegSide;
  option: OptionType;
  strike: number;
  qty: number;
  /** SL / SLM (Dhan stop-loss entry, rests until `triggerPrice` prints) are Dhan only. */
  type: 'MARKET' | 'LIMIT' | 'SL' | 'SLM';
  price?: number;
  triggerPrice?: number;
  underlying: string;
  productType: 'INTRADAY' | 'MARGIN';
  securityId?: string;
  tradingsymbol?: string;
}

/** Unified strike->identifier shape, matching what every broker's
 *  /api/scalper[/<broker>]/lookup populates into the same strikeMap state
 *  (see components/Scalper.tsx's strikeMap type for precedent). */
export interface StrikeIdentifier {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

export interface ResolvedOrder {
  broker: Broker;
  url: string;
  body: Record<string, unknown>;
}

/** BUY legs first, then SELL legs — margin-friendly ordering for a multi-leg basket. */
export function sortLegsForPlacement<T extends { side: LegSide }>(legs: T[]): T[] {
  return [...legs.filter(l => l.side === 'B'), ...legs.filter(l => l.side === 'S')];
}

/** Resolves one leg into a ready-to-fetch order request for the given broker, or
 *  null if the strike/option combination has no known order identifier yet. */
export function resolveOrderRequest(
  broker: Broker,
  leg: OrderLeg,
  strikeMap: Record<string, StrikeIdentifier>,
  /** Dhan only: correlationId prefix tagging the order as this caller's (see fast-order). */
  source?: string,
): ResolvedOrder | null {
  const ident = strikeMap[String(leg.strike)];
  const side = leg.side === 'B' ? 'BUY' : 'SELL';
  const snap = (v: number) => Math.round(v * 20) / 20;   // snap to 0.05 tick
  const limitPrice = leg.type === 'LIMIT' && leg.price != null ? snap(leg.price) : undefined;

  const isStop = leg.type === 'SL' || leg.type === 'SLM';
  if (isStop && broker !== 'dhan') return null;
  const triggerPrice = isStop && leg.triggerPrice != null && leg.triggerPrice > 0 ? snap(leg.triggerPrice) : undefined;
  if (isStop && triggerPrice == null) return null;
  const stopLimit = leg.type === 'SL' && leg.price != null && leg.price > 0 ? snap(leg.price) : undefined;
  if (leg.type === 'SL' && stopLimit == null) return null;

  const isSensex = leg.underlying === 'SENSEX';
  const isCrude = leg.underlying === 'CRUDEOIL' || leg.underlying === 'CRUDEOILM';

  if (broker === 'dhan') {
    const securityId = leg.securityId || (leg.option === 'CE' ? ident?.ceId : ident?.peId);
    if (!securityId) return null;
    const exchangeSegment = isSensex ? 'BSE_FNO' : (isCrude ? 'MCX_COMM' : 'NSE_FNO');
    return {
      broker, url: '/api/scalper/fast-order',
      body: {
        securityId, quantity: leg.qty, side,
        orderType: leg.type === 'SL' ? 'STOP_LOSS' : leg.type === 'SLM' ? 'STOP_LOSS_MARKET' : leg.type,
        exchangeSegment,
        productType: leg.productType,
        ...(limitPrice != null ? { price: limitPrice } : {}),
        ...(stopLimit != null ? { price: stopLimit } : {}),
        ...(triggerPrice != null ? { triggerPrice } : {}),
        ...(source ? { source } : {}),
      },
    };
  }

  // Every non-Dhan broker orders by trading symbol and shares this request
  // shape; only the exchange spelling differs (Kotak uses lowercase segments).
  const tradingsymbol = leg.tradingsymbol || (leg.option === 'CE' ? ident?.ceSymbol : ident?.peSymbol);
  if (!tradingsymbol) return null;
  const exchange = broker === 'kotak'
    ? (isSensex ? 'bse_fo' : (isCrude ? 'mcx_fo' : 'nse_fo'))
    : (isSensex ? 'BFO' : (isCrude ? 'MCX' : 'NFO'));
  return {
    broker, url: `/api/scalper/${broker}/order`,
    body: {
      tradingsymbol, quantity: leg.qty, side, orderType: leg.type,
      exchange,
      product: leg.productType === 'MARGIN' ? 'NRML' : 'MIS',
      ...(limitPrice != null ? { price: limitPrice } : {}),
    },
  };
}
