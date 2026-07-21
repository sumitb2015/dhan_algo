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
}

/** Unified strike->identifier shape, matching what /api/scalper/lookup and
 *  /api/scalper/zerodha/lookup both populate into the same strikeMap state
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

  if (broker === 'dhan') {
    const securityId = leg.option === 'CE' ? ident.ceId : ident.peId;
    if (!securityId) return null;
    return {
      broker, url: '/api/scalper/fast-order',
      body: {
        securityId, quantity: leg.qty, side, orderType: leg.type,
        exchangeSegment: leg.underlying === 'SENSEX' ? 'BSE_FNO' : 'NSE_FNO',
        ...(limitPrice != null ? { price: limitPrice } : {}),
      },
    };
  }

  const tradingsymbol = leg.option === 'CE' ? ident.ceSymbol : ident.peSymbol;
  if (!tradingsymbol) return null;
  return {
    broker, url: '/api/scalper/zerodha/order',
    body: {
      tradingsymbol, quantity: leg.qty, side, orderType: leg.type,
      exchange: leg.underlying === 'SENSEX' ? 'BFO' : 'NFO',
      ...(limitPrice != null ? { price: limitPrice } : {}),
    },
  };
}
