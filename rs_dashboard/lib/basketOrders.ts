import type { LegSide, OptionType } from './basketStrategies';
import type { Broker } from '@/hooks/useBrokerSelector';

export interface OrderLeg {
  side: LegSide;
  option: OptionType;
  strike: number;
  qty: number;
  type: 'MARKET' | 'LIMIT';
  price?: number;
  underlying: string;
  productType: 'INTRADAY' | 'MARGIN';
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
): ResolvedOrder | null {
  const ident = strikeMap[String(leg.strike)];
  if (!ident) return null;

  const side = leg.side === 'B' ? 'BUY' : 'SELL';
  const limitPrice = leg.type === 'LIMIT' && leg.price != null
    ? Math.round(leg.price * 20) / 20   // snap to 0.05 tick
    : undefined;

  const isSensex = leg.underlying === 'SENSEX';
  const isCrude = leg.underlying === 'CRUDEOIL' || leg.underlying === 'CRUDEOILM';

  if (broker === 'dhan') {
    const securityId = leg.option === 'CE' ? ident.ceId : ident.peId;
    if (!securityId) return null;
    const exchangeSegment = isSensex ? 'BSE_FNO' : (isCrude ? 'MCX_COMM' : 'NSE_FNO');
    return {
      broker, url: '/api/scalper/fast-order',
      body: {
        securityId, quantity: leg.qty, side, orderType: leg.type,
        exchangeSegment,
        productType: leg.productType,
        ...(limitPrice != null ? { price: limitPrice } : {}),
      },
    };
  }

  // Every non-Dhan broker orders by trading symbol and shares this request
  // shape; only the exchange spelling differs (Kotak uses lowercase segments).
  const tradingsymbol = leg.option === 'CE' ? ident.ceSymbol : ident.peSymbol;
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
