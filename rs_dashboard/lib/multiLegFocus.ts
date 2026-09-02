// Data model, preset resolution, and pure ledger/P&L math for the Multi-Leg
// Focus terminal. Order placement itself reuses lib/basketOrders.ts unchanged;
// this module only owns what's new — an N-leg fill ledger and its own
// broker-position matching (Dhan's scalper lookup route returns securityId,
// not a trading symbol, so lib/positionProduct.ts's symbol-only matcher can't
// be used for Dhan legs as-is).

import { nearestStrike, type LegSide, type OptionType, type StrategyTemplate } from './basketStrategies.ts';
import { positionProduct, findLivePosition, type LiveMatch } from './positionProduct.ts';

export type MultiLegStatus = 'DRAFT' | 'PLACING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'FAILED';

export interface MultiLegLeg {
  id: string;
  side: LegSide;
  option: OptionType;
  strike: number;
  lots: number;
  type: 'MARKET' | 'LIMIT';
  price?: number;              // manual override, only used when type === 'LIMIT'
  /** This basket's own fill ledger for this leg — never derived from broker net qty. */
  fill?: { qty: number; avgPrice: number };
  /** Captured from the order response at placement time; used to match this
   *  leg's own broker position row on every monitoring poll. */
  orderRef?: { securityId?: string; symbol?: string };
  status: MultiLegStatus;
}

export interface MultiLegBasket {
  id: string;
  underlying: string;
  expiry: string;
  broker: string;
  presetKey?: string;
  legs: MultiLegLeg[];
  createdAt: string;
  updatedAt: string;
}

let _legSeq = 0;
function newLegId(): string {
  _legSeq += 1;
  return `mll_${Date.now().toString(36)}_${_legSeq.toString(36)}`;
}

/** Resolves a preset template's ATM-relative legs to real strikes, producing a
 *  fresh draft leg list. Does not place any orders. */
export function resolveTemplateLegs(
  template: StrategyTemplate,
  atmStrike: number,
  allStrikes: number[],
  step: number,
): MultiLegLeg[] {
  return template.legs.map(tl => ({
    id: newLegId(),
    side: tl.side,
    option: tl.option,
    strike: nearestStrike(allStrikes, atmStrike + tl.offset * step) ?? atmStrike,
    lots: tl.ratio,
    type: 'MARKET' as const,
    status: 'DRAFT' as const,
  }));
}

/**
 * Reconciles a leg's own fill ledger against the broker's live position,
 * strictly downward — same rule as FocusRowFill in lib/focusToolRows.ts.
 * `brokerAbsQty` of `null` means the broker position couldn't be resolved
 * this tick; the ledger is left untouched rather than guessed at.
 */
export function reconcileLegFillDown(leg: MultiLegLeg, brokerAbsQty: number | null): MultiLegLeg {
  if (brokerAbsQty == null || !leg.fill) return leg;
  if (brokerAbsQty >= leg.fill.qty) return leg;
  return {
    ...leg,
    fill: { ...leg.fill, qty: brokerAbsQty },
    status: brokerAbsQty === 0 ? 'CLOSED' : leg.status,
  };
}

/** This leg's own P&L against `ltp`, sized off its own fill ledger only. */
export function legPnl(leg: MultiLegLeg, ltp: number): number {
  if (!leg.fill || leg.fill.qty <= 0) return 0;
  const perUnit = leg.side === 'B' ? ltp - leg.fill.avgPrice : leg.fill.avgPrice - ltp;
  return perUnit * leg.fill.qty;
}

export function basketTotalPnl(legs: MultiLegLeg[], ltpFor: (leg: MultiLegLeg) => number): number {
  return legs.reduce((sum, l) => sum + legPnl(l, ltpFor(l)), 0);
}

/** SELL legs first, then BUY legs — closing a SELL leg is a risk-reducing BUY,
 *  so this exits the higher-margin-risk side first, mirroring the intent of
 *  basketOrders.sortLegsForPlacement's BUY-first entry ordering in reverse. */
export function sortLegsForExit<T extends { side: LegSide }>(legs: T[]): T[] {
  return [...legs.filter(l => l.side === 'S'), ...legs.filter(l => l.side === 'B')];
}

export type MultiLegMatch =
  | { kind: 'match'; row: Record<string, unknown> }
  | { kind: 'flat' }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; count: number };

/**
 * Reconciles a leg against broker positions.
 * - If broker has a live matching row (netQty != 0):
 *   Ensures status is 'OPEN' and updates fill quantity and average price from broker truth.
 * - If broker explicitly reports the position closed/flat:
 *   Marks status as 'CLOSED' and zeroes fill quantity.
 * - If broker position is not found or ambiguous:
 *   Leaves the leg untouched (handles API propagation lag after order placement).
 */
export function reconcileLegWithBroker(
  leg: MultiLegLeg,
  match: MultiLegMatch,
  maxQty?: number | null,
): MultiLegLeg {
  if (match.kind === 'match') {
    const brokerQty = Math.abs(Number(match.row.netQty) || 0);
    if (brokerQty > 0) {
      const brokerAvg = Number(match.row.sellAvg || match.row.buyAvg || match.row.costPrice || 0);
      const avgPrice = brokerAvg > 0 ? brokerAvg : (leg.fill?.avgPrice ?? 0);
      const cap = maxQty ?? (leg.fill?.qty && leg.fill.qty > 0 ? leg.fill.qty : 0);
      const qty = cap > 0 ? Math.min(brokerQty, cap) : brokerQty;
      return {
        ...leg,
        status: 'OPEN',
        fill: { qty, avgPrice },
      };
    }
    return {
      ...leg,
      status: 'CLOSED',
      fill: { qty: 0, avgPrice: leg.fill?.avgPrice ?? 0 },
    };
  }

  if (match.kind === 'flat') {
    return {
      ...leg,
      status: 'CLOSED',
      fill: { qty: 0, avgPrice: leg.fill?.avgPrice ?? 0 },
    };
  }

  // 'not_found' or 'ambiguous' -> leave untouched
  return leg;
}

/**
 * Locates a leg's own live broker position row.
 *
 * Dhan legs carry only `orderRef.securityId` (the scalper lookup route never
 * returns a trading symbol for Dhan), so they're matched directly by
 * securityId rather than through lib/positionProduct's symbol-based
 * findLivePosition. Every other broker carries `orderRef.symbol` and is
 * matched via findLivePosition exactly as Scalper.tsx already does.
 */
export function findLegPosition(
  broker: string,
  leg: MultiLegLeg,
  rows: Record<string, unknown>[],
): MultiLegMatch {
  if (!leg.orderRef) return { kind: 'not_found' };

  if (broker === 'dhan' && leg.orderRef.securityId) {
    const matchingSecId = rows.filter(r => String(r.securityId ?? '') === leg.orderRef!.securityId);
    if (matchingSecId.length === 0) {
      // Row not in positions array at all — broker hasn't booked it yet or API omitted it
      return { kind: 'not_found' };
    }
    const live = matchingSecId.filter(r => {
      const positionType = String(r.positionType ?? '').trim().toUpperCase();
      if (positionType === 'CLOSED') return false;
      if ((Number(r.netQty) || 0) === 0) return false;
      return true;
    });
    if (live.length === 0) return { kind: 'flat' };
    if (live.length > 1) return { kind: 'ambiguous', count: live.length };
    return { kind: 'match', row: live[0] };
  }

  if (leg.orderRef.symbol) {
    const live = findLivePosition(rows, { tradingSymbol: leg.orderRef.symbol });
    if (live.kind === 'flat') {
      const anyMatch = rows.some(r => String(r.tradingSymbol ?? '') === leg.orderRef!.symbol);
      return anyMatch ? { kind: 'flat' } : { kind: 'not_found' };
    }
    return live;
  }
  return { kind: 'not_found' };
}

// Re-exported for callers that only need to inspect a matched row's product
// without importing lib/positionProduct.ts separately.
export { positionProduct };

