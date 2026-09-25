// Data model, preset resolution, and pure ledger/P&L math for the Multi-Leg
// Focus terminal. Order placement itself reuses lib/basketOrders.ts unchanged;
// this module only owns what's new — an N-leg fill ledger and its own
// broker-position matching (Dhan's scalper lookup route returns securityId,
// not a trading symbol, so lib/positionProduct.ts's symbol-only matcher can't
// be used for Dhan legs as-is).

import { nearestStrike, type LegSide, type OptionType, type StrategyTemplate } from './basketStrategies.ts';
import { positionProduct, findLivePosition } from './positionProduct.ts';
import { computeBsGreeks, type OptType } from './optionsMonitorMath.ts';
import { classifyStructure, type GroupLeg } from './positionStructure.ts';

export type MultiLegStatus = 'DRAFT' | 'PLACING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'FAILED';

export interface MultiLegLeg {
  id: string;
  side: LegSide;
  option: OptionType;
  strike: number;
  /** Which expiry this leg trades on. Equal to the basket's `expiry` (the
   *  front/main month) for every ordinary strategy; a Calendar/Diagonal
   *  template's far leg carries the basket's `farExpiry` instead — see
   *  resolveTemplateLegs and MultiLegBasket.farExpiry. Optional only for
   *  backward compatibility with legs persisted before this field existed —
   *  every caller must read it as `leg.expiry || basket.expiry`, never bare. */
  expiry?: string;
  lots: number;
  /** Base ratio for strategy-level multiplier scaling. */
  ratio?: number;
  type: 'MARKET' | 'LIMIT';
  price?: number;              // manual override, only used when type === 'LIMIT'
  /** This basket's own fill ledger for this leg — never derived from broker net qty. */
  fill?: { qty: number; avgPrice: number; orderId?: string };
  /** Captured once the broker reports this leg flat, from the closing side's
   *  average price (buyAvg/sellAvg) and the matched qty on that round trip.
   *  `fill.qty` zeroes on close (it sizes further exits), so P&L math for a
   *  CLOSED leg reads this instead of drifting off live LTP against a
   *  zeroed quantity — see reconcileLegWithBroker and legPnl. */
  closedFill?: { qty: number; exitPrice: number };
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

/** Fallback lot size used only until `/api/scalper/lookup` populates the real
 *  broker value — must stay in sync with each underlying's actual contract
 *  size (and, for CRUDEOIL/CRUDEOILM, Dhan's qty semantics which differ 100x
 *  from other brokers). Single source of truth shared by MultiLegFocus.tsx,
 *  AddLotsModal.tsx, and AddNewLegModal.tsx. */
export function fallbackLotSize(underlying: string, broker: string): number {
  if (underlying === 'NIFTY') return 65;
  if (underlying === 'BANKNIFTY') return 15;
  if (underlying === 'SENSEX') return 20;
  if (broker === 'dhan') return 1;
  return underlying === 'CRUDEOIL' ? 100 : 10;
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
  /** Secondary expiry for a Calendar/Diagonal template's far leg(s). Unset
   *  for every ordinary single-expiry strategy. */
  farExpiry?: string;
  broker: string;
  presetKey?: string;
  /** Strategy-level lot multiplier (default 1). */
  multiplier?: number;
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
  frontExpiry: string = '',
  farExpiry?: string,
  multiplier: number = 1,
): MultiLegLeg[] {
  const safe = isNaN(multiplier) || !multiplier ? 1 : multiplier;
  const m = Math.max(1, Math.min(50, Math.round(safe)));
  return template.legs.map(tl => {
    const baseRatio = Math.max(1, Math.round(tl.ratio || 1));
    return {
      id: newLegId(),
      side: tl.side,
      option: tl.option,
      strike: nearestStrike(allStrikes, atmStrike + tl.offset * step) ?? atmStrike,
      expiry: tl.expiryRole === 'far' ? (farExpiry || frontExpiry) : frontExpiry,
      ratio: baseRatio,
      lots: Math.max(1, Math.round(baseRatio * m)),
      type: 'MARKET' as const,
      status: 'DRAFT' as const,
    };
  });
}

/**
 * Scales a basket's multiplier and updates every leg's lots according to its ratio.
 * Clamps multiplier between 1 and 50.
 */
export function scaleBasketMultiplier(basket: MultiLegBasket, newMultiplier: number): MultiLegBasket {
  const safe = isNaN(newMultiplier) || !newMultiplier ? 1 : newMultiplier;
  const clampedMultiplier = Math.max(1, Math.min(50, Math.round(safe)));
  const currentBasketMultiplier = Math.max(1, basket.multiplier && !isNaN(basket.multiplier) ? basket.multiplier : 1);

  const updatedLegs = basket.legs.map(leg => {
    const rawRatio = leg.ratio ?? (leg.lots ? leg.lots / currentBasketMultiplier : 1);
    const baseRatio = Math.max(1, Math.round(isNaN(rawRatio) ? 1 : rawRatio));
    return {
      ...leg,
      ratio: baseRatio,
      lots: Math.max(1, Math.round(baseRatio * clampedMultiplier)),
    };
  });

  return {
    ...basket,
    multiplier: clampedMultiplier,
    legs: updatedLegs,
    updatedAt: new Date().toISOString(),
  };
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

/**
 * This leg's own P&L against `ltp`, sized off its own fill ledger only.
 * A CLOSED leg ignores `ltp` (it's no longer a live position) and instead
 * uses the frozen `closedFill` captured at reconciliation time — `fill.qty`
 * is zeroed on close, so sizing off it here would read 0 P&L for a leg that
 * banked a real profit or loss.
 */
export function legPnl(leg: MultiLegLeg, ltp: number, multiplier: number = 1): number {
  if (leg.status === 'CLOSED') {
    if (!leg.closedFill || !leg.fill) return 0;
    const perUnit = leg.side === 'B'
      ? leg.closedFill.exitPrice - leg.fill.avgPrice
      : leg.fill.avgPrice - leg.closedFill.exitPrice;
    return perUnit * leg.closedFill.qty * multiplier;
  }
  if (!leg.fill || leg.fill.qty <= 0) return 0;
  const perUnit = leg.side === 'B' ? ltp - leg.fill.avgPrice : leg.fill.avgPrice - ltp;
  return perUnit * leg.fill.qty * multiplier;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** '2026-10-27' -> '27 Oct 26'. Parsed by hand (no Date) so the day never shifts with the time zone;
 *  anything that is not a plain ISO date is returned unchanged. */
export function formatExpiryLabel(iso: string | undefined | null): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso ?? '');
  if (!m) return iso ?? '';
  const month = MONTHS[Number(m[2]) - 1];
  if (!month) return iso ?? '';
  return `${Number(m[3])} ${month} ${m[1].slice(2)}`;
}

// ── Per-leg display helpers for the legs table columns ──────────────────
// All read the leg's own fill ledger (never broker net qty) and return null when a
// value does not exist yet, so the UI renders a dash instead of a misleading 0.

/** Average entry price; null for a leg with no recorded fill (e.g. DRAFT). */
export function legAvgPrice(leg: MultiLegLeg): number | null {
  const a = leg.fill?.avgPrice;
  return a != null && a > 0 ? a : null;
}

/** Closing fill price; only exists for a CLOSED leg. */
export function legExitPrice(leg: MultiLegLeg): number | null {
  if (leg.status !== 'CLOSED') return null;
  const e = leg.closedFill?.exitPrice;
  return e != null && e > 0 ? e : null;
}

/** Ledger quantity in units (lots x lot size): closed qty for CLOSED, live fill qty otherwise. */
export function legQtyUnits(leg: MultiLegLeg): number | null {
  const q = leg.status === 'CLOSED' ? leg.closedFill?.qty : leg.fill?.qty;
  return q != null && q > 0 ? q : null;
}

/** Leg P&L as a percentage of the entry premium it was opened for. */
export function legPnlPct(leg: MultiLegLeg, ltp: number, multiplier: number = 1): number | null {
  const avg = legAvgPrice(leg);
  const qty = legQtyUnits(leg);
  if (avg == null || qty == null) return null;
  // A live leg with no price yet would read as a full-premium gain (avg - 0); show nothing instead.
  if (leg.status !== 'CLOSED' && !(ltp > 0)) return null;
  const premium = avg * qty * multiplier;
  if (premium <= 0) return null;
  return (legPnl(leg, ltp, multiplier) / premium) * 100;
}

/** Distance of the strike from spot in %: positive = OTM, negative = ITM. */
export function legOtmPct(leg: MultiLegLeg, spot: number): number | null {
  if (!(spot > 0)) return null;
  const diff = leg.option === 'CE' ? leg.strike - spot : spot - leg.strike;
  return (diff / spot) * 100;
}

export function basketTotalPnl(legs: MultiLegLeg[], ltpFor: (leg: MultiLegLeg) => number, multiplier: number = 1): number {
  return legs.reduce((sum, l) => sum + legPnl(l, ltpFor(l), multiplier), 0);
}

/**
 * Re-derives the actual options structure from a basket's live legs, using
 * the same classifier the Margin Allocator uses on broker positions
 * (lib/positionStructure.ts). `presetKey`/`name` are captured once at basket
 * creation and never re-synced — if the legs are later edited (strike moved,
 * a Batman's 1:2 ratio dialed in over what started as an Iron Condor, an
 * extra leg added), the stored label goes stale while the legs themselves
 * are ground truth. Callers should prefer this over `basket.presetKey` for
 * display, falling back to the stored label only when this returns null
 * (a shape `classifyStructure` doesn't recognize as one specific thing, or a
 * Calendar/Diagonal — its strike-only classifier has no notion of `expiry`,
 * so a same-strike different-expiry calendar can't be told from a naked
 * position; callers must exclude multi-expiry baskets themselves).
 */
export function classifyBasketStructure(legs: MultiLegLeg[]): { structure: string; riskType: 'defined' | 'undefined' } | null {
  const active = legs.filter(l => l.status !== 'CLOSED' && l.status !== 'FAILED' && l.lots > 0);
  if (active.length === 0) return null;
  const merged = new Map<string, GroupLeg>();
  for (const l of active) {
    const key = `${l.strike}:${l.option}:${l.side}`;
    const existing = merged.get(key);
    if (existing) {
      existing.qty += l.lots;
    } else {
      merged.set(key, {
        strike: l.strike,
        type: l.option,
        side: l.side === 'B' ? 'BUY' : 'SELL',
        qty: l.lots,
        avgPrice: l.fill?.avgPrice ?? l.price ?? 0,
        securityId: l.orderRef?.securityId ?? null,
        symbol: l.orderRef?.symbol ?? null,
      });
    }
  }
  const result = classifyStructure([...merged.values()]);
  return result.structure === 'Custom Combo' ? null : result;
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
  hasUnpricedLegs: boolean;
}

/**
 * Computes combined strategy metrics (points, percentage, and total rupee P&L).
 * Sells contribute positive credit (profit on decay), Buys contribute debit (profit on rise).
 */
export function computeStrategyMetrics(
  legs: MultiLegLeg[],
  ltpFor: (leg: MultiLegLeg) => number,
  multiplier: number = 1,
): StrategyMetrics {
  let combinedEntryPts = 0;
  let combinedCurrentPts = 0;
  let pnlPts = 0;
  let totalPnlRupees = 0;
  let netCreditDebit = 0;
  let unpricedCount = 0;

  for (const leg of legs) {
    const isBuy = leg.side === 'B';
    const lots = leg.lots || 1;
    const entry = leg.fill?.avgPrice ?? (leg.price && leg.price > 0 ? leg.price : ltpFor(leg));

    // A CLOSED leg is no longer live — pricing it off ltpFor() would drift
    // the points/percentage figures against a live market the position no
    // longer has exposure to, while the rupee total (below, via legPnl)
    // correctly freezes at the realized close. Freeze "current" here too:
    // the actual exit price once known, entry (i.e. zero movement) until it is.
    const isClosed = leg.status === 'CLOSED';
    const rawLtp = ltpFor(leg);

    // CRITICAL GUARD: If an OPEN/PLACING leg has no valid quote (rawLtp <= 0),
    // NEVER treat current price as 0.00! Doing so fabricates phantom 100% gains on SELL legs
    // or -100% losses on BUY legs, falsely triggering automated Targets or Stop Losses.
    // Instead, freeze 'current' at 'entry' (0 movement) and flag hasUnpricedLegs.
    if (!isClosed && (rawLtp == null || rawLtp <= 0 || isNaN(rawLtp))) {
      unpricedCount++;
    }
    const current = isClosed
      ? (leg.closedFill ? leg.closedFill.exitPrice : entry)
      : (rawLtp > 0 ? rawLtp : entry);

    combinedEntryPts += entry * lots;
    combinedCurrentPts += current * lots;
    netCreditDebit += (isBuy ? -entry : entry) * lots;

    const legPoints = isBuy ? (current - entry) * lots : (entry - current) * lots;
    pnlPts += legPoints;

    totalPnlRupees += legPnl(leg, current, multiplier);
  }

  // Capital basis for percentage: use combined gross entry points across all legs (total premium in play).
  // Never prioritize Math.abs(netCreditDebit) because ratio spreads, butterflies, calendars, and near-zero cost
  // combos have a net credit/debit near zero (e.g. 1.3 pts), which causes wild, distorted percentages (e.g. +54.3%, -84.6%).
  const capitalPts = combinedEntryPts > 0 ? combinedEntryPts : Math.abs(netCreditDebit);
  const pnlPct = capitalPts > 0 ? (pnlPts / capitalPts) * 100 : 0;

  return {
    combinedEntryPts: Math.round(combinedEntryPts * 100) / 100,
    combinedCurrentPts: Math.round(combinedCurrentPts * 100) / 100,
    pnlPts: Math.round(pnlPts * 100) / 100,
    pnlPct: Math.round(pnlPct * 100) / 100,
    totalPnlRupees: Math.round(totalPnlRupees * 100) / 100,
    hasUnpricedLegs: unpricedCount > 0,
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

  // CRITICAL GUARD: Never trigger strategy Target or Stop Loss if any open leg is unpriced / missing market data
  if (metrics.hasUnpricedLegs) return null;

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
  | { kind: 'flat'; row?: Record<string, unknown> }
  | { kind: 'not_found' }
  | { kind: 'ambiguous'; count: number };

/**
 * Derives a leg's realized closing fill from a flat/closed broker position
 * row's `buyQty`/`sellQty`/`buyAvg`/`sellAvg`. On a fully round-tripped
 * position both sides are populated: this leg's entry was booked on its own
 * `leg.side`, so the close happened on the opposite side — a BUY leg's exit
 * price is the row's `sellAvg` (what it was sold back at), a SELL leg's is
 * `buyAvg` (what it was bought back at). Same field family Scalper.tsx already
 * reads for its realizedProfit-on-flat-position fix (components/Scalper.tsx).
 */
export function closedFillFromRow(
  row: Record<string, unknown> | undefined,
  isBuy: boolean,
): { qty: number; exitPrice: number } | undefined {
  if (!row) return undefined;
  const buyQty = Number(row.buyQty) || 0;
  const sellQty = Number(row.sellQty) || 0;
  const qty = Math.min(buyQty, sellQty);
  if (qty <= 0) return undefined;
  const exitPrice = Number(isBuy ? row.sellAvg : row.buyAvg) || 0;
  if (exitPrice <= 0) return undefined;
  return { qty, exitPrice };
}

/**
 * Reconciles a leg against broker positions.
 *
 * Dhan nets every position by securityId, not by strategy — two baskets that
 * both sell the same strike/expiry share ONE broker position. So the broker's
 * netQty is a POOLED total that can include a sibling basket's contribution,
 * never just this leg's own. This function must never let that pooled number
 * overwrite this leg's own entitlement upward — only ever clamp it DOWN, when
 * the broker shows less than this leg expects (a genuine partial fill, or
 * something outside this basket reduced the shared position, e.g. a sibling's
 * exit or manual intervention). Getting this backwards is exactly how one
 * basket's leg silently inherits another basket's quantity and P&L.
 *
 * - A leg already CLOSED is left untouched — never resurrected back to OPEN
 *   just because the broker still shows a live (pooled) position, since that
 *   liveness may now belong entirely to a sibling basket sharing the strike.
 * - If broker has a live matching row (netQty != 0):
 *   Ensures status is 'OPEN'. Quantity is this leg's own last-known fill (or
 *   `ownQtyHint`, e.g. lots × lot size, if it has none yet), clamped down to
 *   whatever the broker actually shows — never inflated up to the broker's
 *   pooled total.
 * - If broker explicitly reports the position closed/flat:
 *   Marks status as 'CLOSED', zeroes fill quantity, and — when the row is
 *   available — captures `closedFill` (see closedFillFromRow) so P&L stays
 *   at the realized number.
 * - If broker position is not found or ambiguous:
 *   Leaves the leg untouched (handles API propagation lag after order placement).
 */
export function reconcileLegWithBroker(
  leg: MultiLegLeg,
  match: MultiLegMatch,
  ownQtyHint?: number | null,
  lotSize?: number | null,
): MultiLegLeg {
  if (leg.status === 'CLOSED') return leg;

  if (match.kind === 'match') {
    const brokerQty = Math.abs(Number(match.row.netQty) || 0);
    if (brokerQty > 0) {
      const brokerAvg = Number(match.row.sellAvg || match.row.buyAvg || match.row.costPrice || 0);
      const avgPrice = brokerAvg > 0 ? brokerAvg : (leg.fill?.avgPrice ?? 0);

      const ownQty = (leg.fill?.qty && leg.fill.qty > 0) ? leg.fill.qty : (ownQtyHint ?? brokerQty);
      const qty = Math.min(ownQty, brokerQty);
      const lots = (lotSize && lotSize > 0) ? Math.max(1, Math.round(qty / lotSize)) : leg.lots;
      return {
        ...leg,
        lots,
        status: 'OPEN',
        fill: { qty, avgPrice },
      };
    }
    return {
      ...leg,
      status: 'CLOSED',
      fill: { qty: 0, avgPrice: leg.fill?.avgPrice ?? 0 },
      closedFill: closedFillFromRow(match.row, leg.side === 'B') ?? leg.closedFill,
    };
  }

  if (match.kind === 'flat') {
    return {
      ...leg,
      status: 'CLOSED',
      fill: { qty: 0, avgPrice: leg.fill?.avgPrice ?? 0 },
      closedFill: closedFillFromRow(match.row, leg.side === 'B') ?? leg.closedFill,
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
  // Falls back to a freshly-resolved securityId (from the strike/expiry chain
  // lookup, independent of whatever this leg's orderRef captured at placement
  // time) when orderRef.securityId is missing — a leg that only ever recorded
  // a symbol (or lost its securityId to a bug) would otherwise be permanently
  // unmatchable, since Dhan positions carry no trading symbol to fall back to.
  fallbackSecurityId?: string,
): MultiLegMatch {
  const dhanSecId = leg.orderRef?.securityId || (broker === 'dhan' ? fallbackSecurityId : undefined);
  if (!leg.orderRef && !dhanSecId) return { kind: 'not_found' };

  if (broker === 'dhan' && dhanSecId) {
    const matchingSecId = rows.filter(r => String(r.securityId ?? '') === dhanSecId);
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
    // Not live — but the row itself (buyQty/sellQty/buyAvg/sellAvg) is still
    // the only place the realized close price can come from; hand it back
    // rather than discarding it, so reconcileLegWithBroker can capture it.
    if (live.length === 0) return { kind: 'flat', row: matchingSecId[0] };
    if (live.length > 1) return { kind: 'ambiguous', count: live.length };
    return { kind: 'match', row: live[0] };
  }

  if (leg.orderRef?.symbol) {
    const live = findLivePosition(rows, { tradingSymbol: leg.orderRef.symbol });
    if (live.kind === 'flat') {
      const flatRow = rows.find(r => String(r.tradingSymbol ?? '') === leg.orderRef!.symbol);
      return flatRow ? { kind: 'flat', row: flatRow } : { kind: 'not_found' };
    }
    return live;
  }
  return { kind: 'not_found' };
}

/** Aggregate status for a whole basket from its legs' individual statuses, in
 *  priority order — PLACING/CLOSING/OPEN outrank a stray leftover DRAFT leg
 *  alongside them, and CLOSED only wins when every leg agrees. Shared by
 *  MultiLegStrategyRow (row header badge) and MultiLegFocus (grouping open
 *  vs. exited rows) so the two can't drift apart. */
export function computeBasketStatus(legs: MultiLegLeg[]): MultiLegStatus {
  if (legs.length === 0) return 'DRAFT';
  if (legs.some(l => l.status === 'PLACING')) return 'PLACING';
  if (legs.some(l => l.status === 'CLOSING')) return 'CLOSING';
  if (legs.some(l => l.status === 'OPEN')) return 'OPEN';
  if (legs.every(l => l.status === 'CLOSED')) return 'CLOSED';
  if (legs.some(l => l.status === 'FAILED')) return 'FAILED';
  return 'DRAFT';
}

// Re-exported for callers that only need to inspect a matched row's product
// without importing lib/positionProduct.ts separately.
export { positionProduct };

// ─── Calendar/Diagonal payoff curve ─────────────────────────────────────

/** Whole calendar days between two 'YYYY-MM-DD' dates, floored at 0 (never negative). */
function daysBetweenDates(fromISO: string, toISO: string): number {
  const from = fromISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const to = toISO.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!from || !to) return 0;
  const fromMs = Date.UTC(Number(from[1]), Number(from[2]) - 1, Number(from[3]));
  const toMs = Date.UTC(Number(to[1]), Number(to[2]) - 1, Number(to[3]));
  return Math.max(0, Math.round((toMs - fromMs) / 86_400_000));
}

export interface CalendarPayoffLeg {
  side: LegSide;
  option: OptionType;
  strike: number;
  qty: number;          // lot-scaled units
  entryPrice: number;
  iv: number;            // fraction, e.g. 0.13 — only used for the far leg
  expiry: string;
}

export interface CalendarPayoffResult {
  points: { x: number; y: number }[];
  minPnl: number;
  maxPnl: number;
  breakevens: number[];
  /** Calendar days between the two expiries — the far leg's remaining time
   *  value at the point this curve is drawn (the front leg's expiry date). */
  daysBetweenExpiries: number;
}

/**
 * A Calendar/Diagonal spread's two legs don't share an expiry, so there is
 * no single "at expiry, both legs at intrinsic value" curve (see
 * dhan-payoff-diagrams skill / Baskets.tsx's hasMixedExpiry gate). The
 * economically meaningful curve instead — and what every broker platform
 * actually draws for a calendar spread — is the strategy's value AS OF THE
 * NEAR (front) LEG'S EXPIRY: at that date the front leg has genuinely
 * expired (priced at pure intrinsic value) while the far leg still carries
 * (farExpiry - frontExpiry) days of time value, priced via Black-76/
 * Black-Scholes at that residual time using computeBsGreeks — the same
 * pricing primitive the rest of the dashboard's payoff charts use.
 */
export function computeCalendarPayoffCurve(
  legs: CalendarPayoffLeg[],
  spot: number,
  frontExpiry: string,
  farExpiry: string,
  strikeStep: number,
  futurePrice?: number,
  samples = 121,
): CalendarPayoffResult {
  const daysBetweenExpiries = daysBetweenDates(frontExpiry, farExpiry);
  const tFar = Math.max(daysBetweenExpiries, 0.25) / 365;
  const hasFutures = typeof futurePrice === 'number' && futurePrice > 0;
  const basis = hasFutures ? (futurePrice as number) - spot : 0;

  const strikes = legs.map(l => l.strike);
  const minStrike = strikes.length ? Math.min(...strikes, spot) : spot;
  const maxStrike = strikes.length ? Math.max(...strikes, spot) : spot;
  const wingPad = strikeStep * 6;
  const pctSpan = spot * 0.04;
  const lo = Math.min(spot - pctSpan, minStrike - wingPad);
  const hi = Math.max(spot + pctSpan, maxStrike + wingPad);
  const maxDiff = Math.max(spot - lo, hi - spot, strikeStep);
  const symLo = Math.round((spot - maxDiff) / strikeStep) * strikeStep;
  const symHi = Math.round((spot + maxDiff) / strikeStep) * strikeStep;

  const sampleSpots = new Set<number>();
  for (let i = 0; i < samples; i++) {
    sampleSpots.add(Math.round(symLo + ((symHi - symLo) * i) / Math.max(1, samples - 1)));
  }
  sampleSpots.add(Math.round(spot));
  for (const s of strikes) sampleSpots.add(s);

  const sortedSpots = Array.from(sampleSpots).sort((a, b) => a - b);
  const points: { x: number; y: number }[] = [];
  let minPnl = Infinity;
  let maxPnl = -Infinity;

  for (const s of sortedSpots) {
    let pnl = 0;
    for (const leg of legs) {
      const isSell = leg.side === 'S';
      if (leg.expiry === frontExpiry) {
        const intrinsic = leg.option === 'CE' ? Math.max(0, s - leg.strike) : Math.max(0, leg.strike - s);
        pnl += (isSell ? leg.entryPrice - intrinsic : intrinsic - leg.entryPrice) * leg.qty;
      } else {
        const evalUnderlying = s + basis;
        const type: OptType = leg.option;
        const g = computeBsGreeks(type, evalUnderlying, leg.strike, tFar, leg.iv, 1, 0.065, hasFutures);
        pnl += (isSell ? leg.entryPrice - g.price : g.price - leg.entryPrice) * leg.qty;
      }
    }
    const rounded = Math.round(pnl);
    if (rounded < minPnl) minPnl = rounded;
    if (rounded > maxPnl) maxPnl = rounded;
    points.push({ x: s, y: rounded });
  }

  const rawBreakevens: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    if (a.y === 0) { rawBreakevens.push(a.x); continue; }
    if ((a.y < 0 && b.y > 0) || (a.y > 0 && b.y < 0)) {
      const t = -a.y / (b.y - a.y);
      rawBreakevens.push(Math.round(a.x + t * (b.x - a.x)));
    }
  }

  return {
    points,
    minPnl: minPnl === Infinity ? 0 : minPnl,
    maxPnl: maxPnl === -Infinity ? 0 : maxPnl,
    breakevens: Array.from(new Set(rawBreakevens)).sort((a, b) => a - b),
    daysBetweenExpiries,
  };
}


export interface SiblingLegCollision {
  basketId: string;
  basketName: string;
  side: 'B' | 'S';
  option: 'CE' | 'PE';
  strike: number;
  expiry: string;
  lots: number;
  /** true when the sibling leg is on the opposite side, i.e. the broker's
   *  netted row will carry one sign that matches only one of the two baskets. */
  opposite: boolean;
}

/**
 * Finds live (OPEN/CLOSING/in-flight PLACING) legs in OTHER baskets that resolve to the same contract as any of
 * `candidates` (same broker/underlying/expiry/strike/option). Dhan nets by
 * security id, so two baskets on one contract share a single broker row —
 * exits and reconciliation for both then read the pooled quantity. Identity is
 * matched on contract fields rather than securityId so draft legs (no orderRef
 * yet) and symbol-keyed brokers are covered too. Same-basket legs and
 * CLOSED/FAILED/DRAFT legs are ignored.
 */
export function findSiblingLegCollisions(
  baskets: MultiLegBasket[],
  basketId: string,
  candidates: { side: 'B' | 'S'; option: 'CE' | 'PE'; strike: number; expiry: string }[],
): SiblingLegCollision[] {
  const self = baskets.find(b => b.id === basketId);
  if (!self) return [];
  const out: SiblingLegCollision[] = [];
  for (const b of baskets) {
    if (b.id === basketId || b.broker !== self.broker || b.underlying !== self.underlying) continue;
    for (const l of b.legs) {
      if (l.status !== 'OPEN' && l.status !== 'CLOSING' && l.status !== 'PLACING') continue;
      const legExpiry = l.expiry || b.expiry;
      for (const c of candidates) {
        if (c.option === l.option && c.strike === l.strike && c.expiry === legExpiry) {
          out.push({
            basketId: b.id, basketName: b.name || b.presetKey || 'Unnamed basket',
            side: l.side, option: l.option, strike: l.strike, expiry: legExpiry, lots: l.lots,
            opposite: c.side !== l.side,
          });
        }
      }
    }
  }
  return out;
}

/** Human-readable confirm text for the collisions above. */
export function describeSiblingCollisions(collisions: SiblingLegCollision[]): string {
  const lines = collisions.map(c =>
    `• ${c.basketName}: ${c.side === 'B' ? 'BUY' : 'SELL'} ${c.strike} ${c.option} (${c.lots} lots)${c.opposite ? ' — OPPOSITE side' : ''}`);
  return `This contract is already held by another basket:\n${lines.join('\n')}\n\n`
    + 'Dhan nets positions by security id, so both baskets will share one broker position. '
    + 'Exits and quantity reconciliation for either basket can then read the pooled total'
    + (collisions.some(c => c.opposite) ? ', and an exit on an opposite-side leg may be refused (sign mismatch)' : '')
    + '.\n\nPlace anyway?';
}
