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
): LiveMatch {
  if (!leg.orderRef) return { kind: 'flat' };

  if (broker === 'dhan' && leg.orderRef.securityId) {
    // A CLOSED/zero-qty row can legitimately sit alongside a freshly reopened
    // row for the same securityId within one session (close-then-reopen at
    // the same strike is a documented workflow on this page). Only rows
    // representing a genuinely live position should count toward the
    // match/ambiguous decision — see lib/positionProduct.ts's positionKey
    // doc comment for the same Dhan quirk in the scalper terminals.
    const live = rows.filter(r => {
      if (String(r.securityId ?? '') !== leg.orderRef!.securityId) return false;
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
    return findLivePosition(rows, { tradingSymbol: leg.orderRef.symbol });
  }
  return { kind: 'flat' };
}

// Re-exported for callers that only need to inspect a matched row's product
// without importing lib/positionProduct.ts separately.
export { positionProduct };
