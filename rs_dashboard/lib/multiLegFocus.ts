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

  // ── Leg-wise Stop Loss, Take Profit, and Trailing SL ─────────────
  sl?: number;                 // Stop Loss (points or absolute price)
  slType?: 'pts' | 'price';    // Default: 'pts'
  tp?: number;                 // Take Profit (points or absolute price)
  tpType?: 'pts' | 'price';    // Default: 'pts'
  trail?: boolean;             // Trailing SL enabled (1 rupee trailing step)
  bestPrice?: number;          // Peak favorable price tracked for trailing SL
}

export interface StrategyRiskConfig {
  targetValue?: number;
  targetUnit: 'pts' | 'pct';   // Points or Percentage
  slValue?: number;
  slUnit: 'pts' | 'pct';       // Points or Percentage
  armed: boolean;              // Whether strategy-level auto-exit is armed
}

export interface MultiLegBasket {
  id: string;
  name?: string;
  underlying: string;
  expiry: string;
  broker: string;
  presetKey?: string;
  legs: MultiLegLeg[];
  riskConfig?: StrategyRiskConfig;
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

export interface LegTrailingEvaluation {
  initialSLPrice: number | null;
  effectiveSL: number | null;
  tpPrice: number | null;
  newBestPrice: number | null;
  triggered: 'SL' | 'TRAIL_SL' | 'TP' | null;
}

/**
 * Computes the effective Stop Loss (with 1-rupee trailing step if enabled)
 * and Take Profit price for an open option leg, and determines if either threshold is breached.
 */
export function computeLegTrailingSL(
  leg: MultiLegLeg,
  ltp: number,
): LegTrailingEvaluation {
  const result: LegTrailingEvaluation = {
    initialSLPrice: null,
    effectiveSL: null,
    tpPrice: null,
    newBestPrice: leg.bestPrice ?? null,
    triggered: null,
  };

  if (!leg.fill || leg.fill.avgPrice <= 0 || ltp <= 0) {
    return result;
  }

  const entry = leg.fill.avgPrice;
  const isBuy = leg.side === 'B';

  // 1. Initial SL Price
  if (leg.sl != null && leg.sl > 0) {
    const slType = leg.slType ?? 'pts';
    result.initialSLPrice = slType === 'price' ? leg.sl : (isBuy ? entry - leg.sl : entry + leg.sl);
  }

  // 2. TP Price
  if (leg.tp != null && leg.tp > 0) {
    const tpType = leg.tpType ?? 'pts';
    result.tpPrice = tpType === 'price' ? leg.tp : (isBuy ? entry + leg.tp : entry - leg.tp);
  }

  // 3. Trailing SL (1:1 trail for every 1 rupee favorable move)
  if (result.initialSLPrice != null) {
    let effectiveSL = result.initialSLPrice;

    if (leg.trail) {
      const initialRisk = Math.abs(result.initialSLPrice - entry);
      const prevBest = leg.bestPrice ?? entry;
      // For buy: favorable is higher LTP. For sell: favorable is lower LTP.
      const currentBest = isBuy ? Math.max(prevBest, ltp) : Math.min(prevBest, ltp);
      result.newBestPrice = currentBest;

      // Trailing SL price: 1 rupee trail per 1 rupee favorable movement
      const trailSL = isBuy ? currentBest - initialRisk : currentBest + initialRisk;

      // Only tighten the stop, never widen
      effectiveSL = isBuy ? Math.max(result.initialSLPrice, trailSL) : Math.min(result.initialSLPrice, trailSL);
    }

    result.effectiveSL = effectiveSL;

    // Check SL breach
    const slHit = isBuy ? ltp <= effectiveSL : ltp >= effectiveSL;
    if (slHit) {
      const trailActive = !!leg.trail && (isBuy ? effectiveSL > result.initialSLPrice : effectiveSL < result.initialSLPrice);
      result.triggered = trailActive ? 'TRAIL_SL' : 'SL';
      return result;
    }
  }

  // 4. Check TP breach
  if (result.tpPrice != null) {
    const tpHit = isBuy ? ltp >= result.tpPrice : ltp <= result.tpPrice;
    if (tpHit) {
      result.triggered = 'TP';
      return result;
    }
  }

  return result;
}

export interface StrategyMetrics {
  combinedEntryPts: number;
  combinedCurrentPts: number;
  pnlPts: number;
  pnlPct: number;
  totalPnlRupees: number;
}

/**
 * Computes combined strategy metrics (points, percentage, and total rupee P&L).
 * Sells contribute positive credit (profit on decay), Buys contribute debit (profit on rise).
 */
export function computeStrategyMetrics(
  legs: MultiLegLeg[],
  ltpFor: (leg: MultiLegLeg) => number,
): StrategyMetrics {
  let combinedEntryPts = 0;
  let combinedCurrentPts = 0;
  let pnlPts = 0;
  let totalPnlRupees = 0;
  let netCreditDebit = 0;

  for (const leg of legs) {
    const ltp = ltpFor(leg);
    const entry = leg.fill?.avgPrice ?? (leg.price && leg.price > 0 ? leg.price : ltp);
    const isBuy = leg.side === 'B';
    const lots = leg.lots || 1;

    combinedEntryPts += entry * lots;
    combinedCurrentPts += ltp * lots;
    netCreditDebit += (isBuy ? -entry : entry) * lots;

    const legPoints = isBuy ? (ltp - entry) * lots : (entry - ltp) * lots;
    pnlPts += legPoints;

    if (leg.fill && leg.fill.qty > 0) {
      const perUnit = isBuy ? ltp - leg.fill.avgPrice : leg.fill.avgPrice - ltp;
      totalPnlRupees += perUnit * leg.fill.qty;
    }
  }

  const capitalPts = Math.abs(netCreditDebit) > 0 ? Math.abs(netCreditDebit) : combinedEntryPts;
  const pnlPct = capitalPts > 0 ? (pnlPts / capitalPts) * 100 : 0;

  return {
    combinedEntryPts: Math.round(combinedEntryPts * 100) / 100,
    combinedCurrentPts: Math.round(combinedCurrentPts * 100) / 100,
    pnlPts: Math.round(pnlPts * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    totalPnlRupees: Math.round(totalPnlRupees * 100) / 100,
  };
}

/**
 * Evaluates whether the strategy-level Target or Stop Loss has been reached.
 * Supports thresholds configured in either points or percentage terms.
 */
export function checkStrategyRisk(
  metrics: StrategyMetrics,
  config?: StrategyRiskConfig | null,
): 'TARGET' | 'SL' | null {
  if (!config || !config.armed) return null;

  // 1. Check Target
  if (config.targetValue != null && config.targetValue > 0) {
    if (config.targetUnit === 'pts' && metrics.pnlPts >= config.targetValue) {
      return 'TARGET';
    }
    if (config.targetUnit === 'pct' && metrics.pnlPct >= config.targetValue) {
      return 'TARGET';
    }
  }

  // 2. Check Stop Loss
  if (config.slValue != null && config.slValue > 0) {
    if (config.slUnit === 'pts' && metrics.pnlPts <= -config.slValue) {
      return 'SL';
    }
    if (config.slUnit === 'pct' && metrics.pnlPct <= -config.slValue) {
      return 'SL';
    }
  }

  return null;
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

