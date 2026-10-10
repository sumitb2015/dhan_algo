// Data model, preset resolution, and pure ledger/P&L math for the Multi-Leg
// Focus terminal. Order placement itself reuses lib/basketOrders.ts unchanged;
// this module only owns what's new — an N-leg fill ledger and its own
// broker-position matching (Dhan's scalper lookup route returns securityId,
// not a trading symbol, so lib/positionProduct.ts's symbol-only matcher can't
// be used for Dhan legs as-is).

import { nearestStrike, type LegSide, type OptionType, type StrategyTemplate } from './basketStrategies.ts';
import { positionProduct, findLivePosition } from './positionProduct.ts';
import { classifyStructure, type GroupLeg } from './positionStructure.ts';
import { normalizeExpiry, normalizeOptType, parseTradingSymbol, symbolMatchesUnderlying } from './positionLegs.ts';

export type MultiLegStatus = 'DRAFT' | 'PLACING' | 'OPEN' | 'CLOSING' | 'CLOSED' | 'FAILED';

/** An option leg (CE/PE at a strike) or a futures leg ('FUT', strike 0). Futures legs only ever
 *  come from the broker (lib/multiLegBrokerSync.ts); orders that resolve an option strike
 *  (place, add lots, shift, scale) refuse them. Exit works off the broker row, so it covers both. */
export type LegInstrument = OptionType | 'FUT';

export interface MultiLegLeg {
  id: string;
  /** Basket-default auto re-entries already used by the chain of legs this one came from. */
  autoRolls?: number;
  /** Points OTM from spot when the leg was opened (CE: strike - spot, PE: spot - strike). Drives the
   *  "Same distance" auto re-entry; unset for legs adopted from the broker. */
  entryDist?: number;
  side: LegSide;
  option: LegInstrument;
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
   *  zeroed quantity — see reconcileLegWithBroker and legPnl. `estimated`:
   *  exitPrice is the broker row's pooled day average for the contract (or the
   *  entry when the row has none), not this slice's own fill — set on a slice
   *  split off by brokerClampSlice; the row marks it "est.". */
  closedFill?: { qty: number; exitPrice: number; estimated?: boolean };
  /** Epoch ms the leg went CLOSED — splits today's realized P&L from earlier days' (legTodayCounts). */
  closedAt?: number;
  /** Captured from the order response at placement time; used to match this
   *  leg's own broker position row on every monitoring poll. */
  orderRef?: { securityId?: string; symbol?: string };
  /** Epoch ms of the last time THIS tool's own order grew this leg's fill
   *  ledger (initial placement, add lots, scale, merge-on-reopen). The broker
   *  position book lags an acknowledged order by seconds, so a reconciliation
   *  poll inside LEG_FILL_GRACE_MS of this can still read the pre-order qty —
   *  clamping DOWN on that stale read (which can never recover, since
   *  reconciliation never grows the ledger) is how an added 5 lots vanished
   *  from a 1-lot leg. See reconcileLegWithBroker. */
  filledAt?: number;
  /** Orders this tool sent for this leg whose final outcome isn't known yet.
   *  An order ACK only means the broker accepted it — Dhan/Zerodha/Kotak can
   *  still reject it seconds later (RMS/margin/freeze). The poll matches each
   *  against the order book and undoes the ledger effect of a rejected or
   *  cancelled one — see applyOrderOutcomes. */
  pendingOrders?: PendingLegOrder[];
  /** Ids of this tool's own orders on this leg once they settle (pendingOrders
   *  drops them), so a trade-book row can always be told apart from an
   *  outside trade on the same contract — see ownOrderIds. */
  orderIds?: string[];
  /** Trade-book keys of the outside trades that priced this leg's close
   *  (repriceEstimatedCloses), so one trade is never used for two closes. */
  outsideTradeKeys?: string[];
  /** Save revision — see lib/multiLegStoreMerge.ts. */
  rev?: number;
  /** Free-text label the user attaches to this trade (e.g. "hedge", "adjustment"). Display only. */
  tag?: string;
  status: MultiLegStatus;

  // ── Leg-wise Stop Loss, Take Profit, and Trailing SL ─────────────
  sl?: number;                 // Stop Loss (points, % of entry premium, or absolute price)
  slType?: LegThresholdType;   // Default: 'pts'
  tp?: number;                 // Take Profit (points, % of entry premium, or absolute price)
  tpType?: LegThresholdType;   // Default: 'pts'
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

export interface ScalePlan {
  currentMultiplier: number;
  newMultiplier: number;
  /** Largest +N that keeps the strategy within the 50x multiplier cap. */
  maxDelta: number;
  legs: { leg: MultiLegLeg; baseRatio: number; addLots: number; newLots: number }[];
  /** True when every open leg's lots equal ratio x multiplier, so bumping the multiplier stays truthful. */
  inStep: boolean;
  totalLots: number;
  addTotalLots: number;
}

/** Stable fingerprint of a plan (leg ids and lots added). The dialog hands it to the handler so a basket that
 *  changed while the dialog was open (a leg stopped out, lots edited) is refused instead of scaled differently
 *  from what the user approved. */
export function scalePlanSignature(plan: ScalePlan): string {
  return `${plan.currentMultiplier}|${plan.legs.map(p => `${p.leg.id}:${p.leg.lots}+${p.addLots}`).join(',')}`;
}

/** What "Scale +N" would do to a placed strategy: each OPEN leg grows by its base ratio x N lots.
 *  The modal previews this and scaleStrategy executes it, so they cannot disagree. */
export function planScale(basket: MultiLegBasket, delta: number): ScalePlan {
  const cur = Math.max(1, basket.multiplier && !isNaN(basket.multiplier) ? basket.multiplier : 1);
  const legs = basket.legs.filter(l => l.status === 'OPEN').map(leg => {
    const baseRatio = leg.ratio ?? Math.max(1, Math.round(leg.lots / cur));
    const addLots = baseRatio * delta;
    return { leg, baseRatio, addLots, newLots: leg.lots + addLots };
  });
  return {
    currentMultiplier: cur,
    newMultiplier: cur + delta,
    maxDelta: Math.max(0, 50 - cur),
    legs,
    inStep: legs.every(p => p.baseRatio * cur === p.leg.lots),
    totalLots: legs.reduce((n, p) => n + p.leg.lots, 0),
    addTotalLots: legs.reduce((n, p) => n + p.addLots, 0),
  };
}

/** The name a strategy row shows: the structure its live legs form (a strangle plus wings reads as an
 *  iron condor), else the saved name, else the preset key. Multi-expiry baskets skip classification. */
export function basketLabel(basket: MultiLegBasket, fallback = 'Strategy'): string {
  if (basket.groupName?.trim()) return basket.groupName.trim();
  const mixed = basket.legs.some(l => l.status !== 'CLOSED' && l.expiry && l.expiry !== basket.expiry);
  return (mixed ? null : classifyBasketStructure(basket.legs))?.structure
    ?? basket.name
    ?? (basket.presetKey ? basket.presetKey.replace(/-/g, ' ') : fallback);
}

/** A trade that is not in any group: a row holding one traded leg and no user-given name.
 *  The page lists these in their own "Ungrouped trades" section. A one-leg DRAFT is a
 *  strategy still being built, not a loose trade. */
export function isLooseTrade(basket: MultiLegBasket): boolean {
  return basket.legs.length === 1 && basket.legs[0].status !== 'DRAFT' && !basket.groupName?.trim();
}

/** Dhan reports MCX crude quantity in lots-of-barrels differently per contract: CRUDEOIL x100,
 *  CRUDEOILM x10. Every other underlying/broker is 1. Single source for ledger-qty -> P&L scaling. */
export function crudeQtyMultiplier(underlying: string, broker: string): number {
  if (broker !== 'dhan') return 1;
  return underlying === 'CRUDEOIL' ? 100 : underlying === 'CRUDEOILM' ? 10 : 1;
}

export interface StrategyRiskConfig {
  targetValue?: number;
  targetUnit: 'pts' | 'pct';   // Points or Percentage
  slValue?: number;
  slUnit: 'pts' | 'pct';       // Points or Percentage
  armed: boolean;              // Whether strategy-level auto-exit is armed
}

/**
 * Basket-level default leg stop/target with automatic re-entry. Applies to SHORT legs only
 * (a hedge is never rolled automatically). SL/target are % of the leg's entry premium.
 * After the leg exits and is confirmed closed, a new leg of the same side/lots/option opens at
 * ATM + offset strikes (offset counted OTM: CE up, PE down; 0 = ATM, negative = ITM).
 */
/** Re-entry offset meaning: same points-from-spot as the leg that just exited, measured at its entry. */
export const SAME_DISTANCE = 'same' as const;

/** Re-entry offset meaning: strike whose premium is closest to the open opposite short leg's live premium. */
export const MATCH_OPPOSITE = 'match' as const;

export interface AutoLegRule {
  enabled: boolean;
  slPct: number;
  /** Strikes from ATM to re-enter after a stop; undefined = exit only. */
  slOffset?: number | typeof SAME_DISTANCE | typeof MATCH_OPPOSITE;
  tpPct: number;
  /** Strikes from ATM to re-enter after a target; undefined = exit only. */
  tpOffset?: number | typeof SAME_DISTANCE | typeof MATCH_OPPOSITE;
  /** Re-entries allowed per chain of legs (like Focus Tool's slRollMax). Default 2. */
  maxRolls?: number;
}

export const DEFAULT_AUTO_LEG_RULE: AutoLegRule = { enabled: false, slPct: 20, slOffset: 1, tpPct: 40, tpOffset: 0, maxRolls: 2 };

/** Re-entry allowed: under the roll cap and before the 15:17 IST intraday backstop (`istHM` = 'HH:MM'). */
export function autoRollAllowed(leg: Pick<MultiLegLeg, 'autoRolls'>, rule: AutoLegRule, istHM: string): boolean {
  return (leg.autoRolls ?? 0) < (rule.maxRolls ?? 2) && istHM < '15:17';
}

/** The leg with the basket's default SL/target filled in where the leg has none of its own. */
export function withAutoLegRisk(leg: MultiLegLeg, rule?: AutoLegRule): MultiLegLeg {
  if (!rule?.enabled || leg.side !== 'S' || leg.option === 'FUT') return leg;
  const hasSl = leg.sl != null && leg.sl > 0;
  const hasTp = leg.tp != null && leg.tp > 0;
  if (hasSl && hasTp) return leg;
  return {
    ...leg,
    ...(hasSl || !(rule.slPct > 0) ? {} : { sl: rule.slPct, slType: 'pct' as const }),
    ...(hasTp || !(rule.tpPct > 0) ? {} : { tp: rule.tpPct, tpType: 'pct' as const }),
  };
}

/** True when the leg's own SL/TP is absent, i.e. the basket default is what fired. */
export function autoRuleOwns(leg: MultiLegLeg, kind: 'SL' | 'TP'): boolean {
  const v = kind === 'SL' ? leg.sl : leg.tp;
  return !(v != null && v > 0);
}

/** Strike `offset` places OTM from ATM on the sorted strike list (CE up, PE down). Null when off the chain. */
export function autoReentryStrike(strikes: number[], spot: number, option: 'CE' | 'PE', offset: number): number | null {
  if (!strikes.length || !(spot > 0) || !Number.isFinite(offset)) return null;
  const sorted = [...strikes].sort((a, b) => a - b);
  let atm = 0;
  for (let i = 1; i < sorted.length; i++) if (Math.abs(sorted[i] - spot) < Math.abs(sorted[atm] - spot)) atm = i;
  const idx = atm + (option === 'CE' ? 1 : -1) * Math.round(offset);
  return idx >= 0 && idx < sorted.length ? sorted[idx] : null;
}

/** Strike the same OTM `dist` points from the current spot (CE above, PE below), snapped to the chain. Null when off it. */
export function autoReentryStrikeByDistance(strikes: number[], spot: number, option: 'CE' | 'PE', dist: number): number | null {
  if (!strikes.length || !(spot > 0) || !Number.isFinite(dist)) return null;
  const target = spot + (option === 'CE' ? dist : -dist);
  if (target < Math.min(...strikes) || target > Math.max(...strikes)) return null;
  return strikes.reduce((a, b) => (Math.abs(b - target) < Math.abs(a - target) ? b : a));
}

/** Strike (ATM or further OTM, CE up / PE down) whose live premium is closest to `target`. Null with no priced strike. */
export function autoReentryStrikeByPremium(quotes: Record<string, { ce?: number; pe?: number }>, spot: number, option: 'CE' | 'PE', target: number): number | null {
  if (!(spot > 0) || !(target > 0)) return null;
  const strikes = Object.keys(quotes).map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  let atm = strikes[0];
  for (const k of strikes) if (Math.abs(k - spot) < Math.abs(atm - spot)) atm = k;
  let best: number | null = null, bestDiff = Infinity;
  for (const k of strikes) {
    if (option === 'CE' ? k < atm : k > atm) continue;
    const q = quotes[String(k)]?.[option === 'CE' ? 'ce' : 'pe'];
    if (!(q != null && q > 0)) continue;
    const d = Math.abs(q - target);
    if (d < bestDiff) { bestDiff = d; best = k; }
  }
  return best;
}

/** `strike` itself, or the next strike OTM (CE up / PE down) when it equals the strike that just exited. Null when that is off the chain. */
export function avoidSameStrike(strikes: number[], strike: number, exited: number, option: 'CE' | 'PE'): number | null {
  if (strike !== exited) return strike;
  const sorted = [...strikes].sort((a, b) => a - b);
  const i = sorted.indexOf(strike);
  const j = i < 0 ? -1 : i + (option === 'CE' ? 1 : -1);
  return j >= 0 && j < sorted.length ? sorted[j] : null;
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
  /** Name the user gave this group of trades. Wins over the derived structure name. */
  groupName?: string;
  /** Strategy-level lot multiplier (default 1). */
  multiplier?: number;
  legs: MultiLegLeg[];
  riskConfig?: StrategyRiskConfig;
  /** Default leg SL/target + auto re-entry (see AutoLegRule). */
  autoLegRule?: AutoLegRule;
  /** Dhan stop-loss ENTRY orders resting at the exchange until their trigger prints.
   *  Not legs: nothing is open until one trades, so no exit, stop, P&L or payoff rule
   *  can see them (see WaitingEntry). */
  waitingEntries?: WaitingEntry[];
  createdAt: string;
  updatedAt: string;
  /** Save revision — see lib/multiLegStoreMerge.ts. */
  rev?: number;
}

/**
 * A stop-loss entry order that has been ACKed but has not triggered. It lives beside the
 * legs, never among them: a leg means "this tool holds that position", and a resting
 * trigger order holds nothing. Putting it in `legs` would let exits, SL/target rules and
 * reconciliation act on a position that does not exist (an exit would OPEN the opposite
 * side). When the order trades the poll turns it into a real OPEN leg at the traded qty
 * and average; if it dies it is simply dropped.
 */
export interface WaitingEntry {
  /** Dhan order id of the resting order. */
  orderId: string;
  side: LegSide;
  option: 'CE' | 'PE';
  strike: number;
  expiry: string;
  lots: number;
  /** Contracts (lots x lot size) the order was sent for. */
  qty: number;
  /** SL = stop-limit, SLM = stop-market. */
  orderType: 'SL' | 'SLM';
  triggerPrice: number;
  /** Stop-limit price (SL only). */
  limitPrice?: number;
  /** Dhan security id the order was sent against — also what the broker row is matched on. */
  securityId: string;
  symbol?: string;
  /** Epoch ms the order was placed. */
  at: number;
}

/**
 * Adds a triggered waiting entry to a basket's legs: a new OPEN leg, or — when this basket
 * already holds an OPEN leg on the same contract (Dhan nets by security id, so it is the
 * same position) — a weighted-average merge into it. `filledAt` is stamped so the
 * position book's lag cannot clamp the new qty away (LEG_FILL_GRACE_MS).
 */
export function applyTriggeredEntry(
  legs: MultiLegLeg[],
  entry: WaitingEntry,
  qty: number,
  avgPrice: number,
  lotSize: number,
  now: number = Date.now(),
  newLegId: string = `mll_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
): MultiLegLeg[] {
  const lotsOf = (q: number) => (lotSize > 0 ? Math.max(1, Math.round(q / lotSize)) : entry.lots);
  const same = legs.find(l => l.status === 'OPEN' && l.side === entry.side && l.option === entry.option
    && l.strike === entry.strike && l.expiry === entry.expiry);
  if (same) {
    const oldQty = same.fill?.qty && same.fill.qty > 0 ? same.fill.qty : same.lots * lotSize;
    const oldAvg = same.fill?.avgPrice && same.fill.avgPrice > 0 ? same.fill.avgPrice : (same.price ?? avgPrice);
    const total = oldQty + qty;
    const avg = (oldAvg * oldQty + avgPrice * qty) / total;
    return legs.map(l => (l.id === same.id ? {
      ...l, lots: lotsOf(total), price: avg, filledAt: now,
      fill: { ...l.fill, qty: total, avgPrice: avg, orderId: entry.orderId },
      orderIds: Array.from(new Set([...(l.orderIds ?? []), entry.orderId])),
    } : l));
  }
  return [...legs, {
    id: newLegId,
    side: entry.side,
    option: entry.option,
    strike: entry.strike,
    expiry: entry.expiry,
    lots: lotsOf(qty),
    type: 'MARKET',
    price: avgPrice,
    status: 'OPEN',
    filledAt: now,
    fill: { qty, avgPrice, orderId: entry.orderId },
    orderRef: { securityId: entry.securityId, ...(entry.symbol ? { symbol: entry.symbol } : {}) },
    orderIds: [entry.orderId],
  }];
}

/** What the order book says about a waiting entry. */
export type WaitingEntryOutcome =
  | { kind: 'wait' }
  /** Traded (fully, or the order died after a partial fill): open a leg for `qty` at `avgPrice`. */
  | { kind: 'open'; qty: number; avgPrice: number; partial: boolean }
  | { kind: 'dead'; status: string }
  /** DAY order from an earlier IST day, or absent from the book: stop tracking, never guess a fill. */
  | { kind: 'gone' };

/**
 * Decides one waiting entry from this tick's order book (`order` undefined = not in it).
 * A partly filled order that is still live keeps waiting — the leg opens once for the
 * whole traded qty when it settles, never per slice.
 */
export function settleWaitingEntry(
  entry: WaitingEntry,
  order: NormalizedOrder | undefined,
  now: number = Date.now(),
): WaitingEntryOutcome {
  if (!order) {
    // A DAY order does not outlive its IST day; within the day an order the book has not
    // shown yet (lag after the ACK) is simply not settled.
    return istDay(entry.at) < istDay(now) ? { kind: 'gone' } : { kind: 'wait' };
  }
  if (FILLED_STATUSES.has(order.status)) {
    // No traded average yet (a row read the instant it traded): wait a tick rather than book the
    // trigger/limit as the entry price, which would misstate P&L, SL % and trails with no flag.
    if (order.avgPrice == null) return { kind: 'wait' };
    const qty = order.filled != null && order.filled > 0 ? Math.min(order.filled, entry.qty) : entry.qty;
    return { kind: 'open', qty, avgPrice: order.avgPrice, partial: qty < entry.qty };
  }
  if (DEAD_STATUSES.has(order.status)) {
    const filled = order.status === 'REJECTED' ? 0 : (order.filled ?? 0);
    if (filled > 0) {
      // Part of it traded before it died: that qty is a live position. Wait for the traded average
      // rather than declare "never traded" or book a guessed price.
      if (order.avgPrice == null) return { kind: 'wait' };
      return { kind: 'open', qty: Math.min(filled, entry.qty), avgPrice: order.avgPrice, partial: filled < entry.qty };
    }
    return { kind: 'dead', status: order.status };
  }
  return { kind: 'wait' };
}

export type OptionLeg = MultiLegLeg & { option: OptionType };
export function isOptionLeg(l: MultiLegLeg): l is OptionLeg { return l.option !== 'FUT'; }
export function isFutLeg(l: MultiLegLeg): boolean { return l.option === 'FUT'; }
/** "23150 CE", or "FUT" for a futures leg. */
export function legName(l: Pick<MultiLegLeg, 'option' | 'strike'>): string {
  return l.option === 'FUT' ? 'FUT' : `${l.strike} ${l.option}`;
}

/**
 * A futures leg for the options payoff library: a synthetic call minus put at strike = entry, which
 * pays exactly (F - entry) per unit at expiry and ~e^-rT (F - entry) before it (same IV on both
 * sides, so gamma, vega and theta cancel). `qty` is signed units; `futPrice` is the live futures price.
 */
export function futuresAsSyntheticPayoffLegs(qty: number, entry: number, expiry: string, futPrice?: number) {
  // Both sides "entered" at 1: the 1s cancel, so the P&L is exactly qty x (C - P). (The library needs entry > 0.)
  const common = { strike: entry, expiry, entryPrice: 1, iv: 0.2, ...(futPrice && futPrice > 0 ? { forward: futPrice } : {}) };
  return [{ ...common, type: 'CE' as const, qty }, { ...common, type: 'PE' as const, qty: -qty }];
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
  // No live price: no P&L. Valuing against 0 showed a CRUDEOILM future short at +8,57,570 (2026-10-07).
  if (!(ltp > 0)) return 0;
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
  if (!(spot > 0) || leg.option === 'FUT') return null;
  const diff = leg.option === 'CE' ? leg.strike - spot : spot - leg.strike;
  return (diff / spot) * 100;
}

/** 'YYYY-MM-DD' of an epoch ms in IST (the exchange's calendar day). */
function istDay(ts: number): string {
  return new Date(ts + 5.5 * 3_600_000).toISOString().slice(0, 10);
}

/**
 * Whether a leg's P&L belongs in TODAY's figure — the same scope as the
 * broker's positions MTM: every live leg in full (a carried position's MTM is
 * from its entry), plus legs closed today. A CLOSED leg without `closedAt`
 * (closed before the stamp existed) is treated as an earlier day.
 */
export function legCountsToday(leg: MultiLegLeg, now: number = Date.now()): boolean {
  if (leg.status !== 'CLOSED') return true;
  return leg.closedAt != null && istDay(leg.closedAt) === istDay(now);
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
  const live = legs.filter(l => l.status !== 'CLOSED' && l.status !== 'FAILED' && l.lots > 0);
  // The structure classifier knows option shapes only; a group with futures keeps its own name.
  if (live.length === 0 || !live.every(isOptionLeg)) return null;
  const active = live as OptionLeg[];
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

/** Leg SL/TP unit: points, % of the leg's entry premium, or an absolute option price. */
export type LegThresholdType = 'pts' | 'pct' | 'price';

/** Next unit when the user clicks the toggle: pts -> % -> price -> pts. */
export function nextLegThresholdType(t?: LegThresholdType): LegThresholdType {
  return t === 'pct' ? 'price' : t === 'price' ? 'pts' : 'pct';
}

function adverseSLPrice(entry: number, sl: number, type: LegThresholdType, isBuy: boolean): number {
  const pts = type === 'pct' ? (entry * sl) / 100 : sl;
  return isBuy ? entry - pts : entry + pts;
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
    result.initialSLPrice = slType === 'price' ? leg.sl : adverseSLPrice(entry, leg.sl, slType, isBuy);
  }

  // 2. TP Price
  if (leg.tp != null && leg.tp > 0) {
    const tpType = leg.tpType ?? 'pts';
    const tpPts = tpType === 'pct' ? (entry * leg.tp) / 100 : leg.tp;
    result.tpPrice = tpType === 'price' ? leg.tp : (isBuy ? entry + tpPts : entry - tpPts);
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
  /** A futures leg is in the group: points and % do not add up across futures and options, so
   *  only the rupee P&L means anything (the row shows that, and strategy Target/SL stay off). */
  hasFutures: boolean;
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
    hasFutures: legs.some(l => l.option === 'FUT'),
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
  // Points / % thresholds mean nothing once futures and options are summed together.
  if (metrics.hasFutures) return null;

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
  ownQty?: number | null,
): { qty: number; exitPrice: number; estimated: true } | undefined {
  if (!row) return undefined;
  const buyQty = Number(row.buyQty) || 0;
  const sellQty = Number(row.sellQty) || 0;
  const roundTrip = Math.min(buyQty, sellQty);
  if (roundTrip <= 0) return undefined;
  // The row's round trip is POOLED across every leg (and outside trade) on this
  // securityId. Sizing a leg's realized P&L off it credited each of two 2-lot
  // legs on one contract with all 4 lots, and a 2-lot leg with an 8-lot day
  // round trip (2026-10-01). The leg's own ledger qty is what it closed.
  const qty = ownQty != null && ownQty > 0 ? ownQty : roundTrip;
  const exitPrice = Number(isBuy ? row.sellAvg : row.buyAvg) || 0;
  if (exitPrice <= 0) return undefined;
  // Pooled too, so only an estimate until repriceEstimatedCloses finds the
  // outside trade(s) that actually closed it in the trade book.
  return { qty, exitPrice, estimated: true };
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
 * - If broker position is not found:
 *   Leaves the leg untouched (handles API propagation lag after order placement)
 *   — unless the leg was opened on an EARLIER IST day (`openedSince`). Dhan drops
 *   a flat row when the day rolls, and a still-open overnight position stays in
 *   the book, so a missing row then means it was closed; without this a leg
 *   closed while the page was shut stayed OPEN forever (Crude basket, 2026-10-08).
 *   No exit price is recoverable from a missing row, so no closedFill is set.
 * - If broker position is ambiguous: leaves the leg untouched.
 */
/** How long after this tool grows a leg's ledger that a smaller/flat broker
 *  read is treated as position-book lag rather than a real reduction. */
export const LEG_FILL_GRACE_MS = 20_000;

/** A grow order not yet confirmed filled also holds the ledger (up to this
 *  long): if it's then rejected, applyOrderOutcomes takes its qty back off —
 *  which would double-count if reconciliation had already clamped it away. */
export const PENDING_GROW_GRACE_MS = 120_000;

export function isLegInFillGrace(leg: MultiLegLeg, now: number = Date.now()): boolean {
  if (leg.filledAt != null && now - leg.filledAt >= 0 && now - leg.filledAt < LEG_FILL_GRACE_MS) return true;
  return (leg.pendingOrders ?? []).some(p => p.kind === 'grow' && now - p.at >= 0 && now - p.at < PENDING_GROW_GRACE_MS);
}

export function reconcileLegWithBroker(
  leg: MultiLegLeg,
  match: MultiLegMatch,
  ownQtyHint?: number | null,
  lotSize?: number | null,
  now: number = Date.now(),
  openedSince?: number | null,
): MultiLegLeg {
  const next = reconcileLegWithBrokerRaw(leg, match, ownQtyHint, lotSize, now, openedSince);
  // Propagation grace (skill invariant 6): right after this tool's own order
  // grew the leg, the broker can still show the OLD (smaller) qty, or flat.
  // Reconciliation only ever moves DOWN, so acting on that stale read would
  // permanently drop the just-placed lots. Hold the ledger until the window
  // passes; a real reduction still lands on the first poll after it.
  if (next !== leg && isLegInFillGrace(leg, now)) {
    const ownQty = leg.fill?.qty ?? 0;
    const shrinks = next.status === 'CLOSED' || (next.fill?.qty ?? 0) < ownQty || next.lots < leg.lots;
    if (shrinks) return leg;
  }
  return next;
}

/**
 * The CLOSED slice for qty reconcileLegWithBroker just clamped off an OPEN leg
 * (broker holds less than the leg tracked: something closed it outside this
 * tool). Without it the clamp only shrank `fill.qty`, and that qty's realized
 * P&L vanished — 2026-10-01: 130 of a 390 23400 CE short bought back @ 64
 * dropped ₹4,270 from the page. Same shape as recordOutsideReduction's slice,
 * but automatic, so the exit price is only an estimate: the broker row's
 * closing-side average is pooled across the day's trades on the contract.
 * Returns null when nothing was clamped (including a full close, which
 * reconcileLegWithBroker already records on the leg itself).
 */
export function brokerClampSlice(
  prev: MultiLegLeg,
  next: MultiLegLeg,
  row: Record<string, unknown>,
  lotSize: number,
  now: number = Date.now(),
): MultiLegLeg | null {
  if (prev.status !== 'OPEN' || next.status !== 'OPEN') return null;
  const cut = (prev.fill?.qty ?? 0) - (next.fill?.qty ?? 0);
  if (cut <= 0) return null;
  const entry = prev.fill?.avgPrice ?? 0;
  const rowPrice = Number(prev.side === 'B' ? row.sellAvg : row.buyAvg) || 0;
  return {
    id: newLegId(), side: prev.side, option: prev.option, strike: prev.strike, expiry: prev.expiry,
    lots: lotSize > 0 ? Math.max(1, Math.round(cut / lotSize)) : 1,
    type: prev.type, price: prev.price, orderRef: prev.orderRef,
    status: 'CLOSED', closedAt: now, fill: { qty: 0, avgPrice: entry },
    closedFill: { qty: cut, exitPrice: rowPrice > 0 ? rowPrice : entry, estimated: true },
  };
}

function reconcileLegWithBrokerRaw(
  leg: MultiLegLeg,
  match: MultiLegMatch,
  ownQtyHint?: number | null,
  lotSize?: number | null,
  now: number = Date.now(),
  openedSince?: number | null,
): MultiLegLeg {
  if (leg.status === 'CLOSED') return leg;

  if (match.kind === 'match') {
    const brokerQty = Math.abs(Number(match.row.netQty) || 0);
    if (brokerQty > 0) {
      // The broker average is pooled across every leg and trade on this
      // contract (22300 PE: two legs both read 125.13; 22500 CE: a leg's entry
      // blended with another basket's sell, 2026-10-01). A leg's own average —
      // its fill price, settled to the order's traded average by
      // applyOrderOutcomes — wins; the broker's only fills a leg that has none.
      const brokerAvg = Number(match.row.sellAvg || match.row.buyAvg || match.row.costPrice || 0);
      const ownAvg = leg.fill?.avgPrice ?? 0;
      const avgPrice = ownAvg > 0 ? ownAvg : brokerAvg;

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
      closedAt: now,
      fill: { qty: 0, avgPrice: leg.fill?.avgPrice ?? 0 },
      closedFill: closedFillFromRow(match.row, leg.side === 'B', leg.fill?.qty) ?? leg.closedFill,
    };
  }

  if (match.kind === 'flat') {
    return {
      ...leg,
      status: 'CLOSED',
      closedAt: now,
      fill: { qty: 0, avgPrice: leg.fill?.avgPrice ?? 0 },
      closedFill: closedFillFromRow(match.row, leg.side === 'B', leg.fill?.qty) ?? leg.closedFill,
    };
  }

  if (match.kind === 'not_found' && leg.status === 'OPEN' && !(leg.pendingOrders?.length)
      && (leg.fill?.qty ?? 0) > 0 && openedSince != null && Number.isFinite(openedSince)
      && istDay(openedSince) < istDay(now)) {
    return {
      ...leg,
      status: 'CLOSED',
      closedAt: now,
      fill: { qty: 0, avgPrice: leg.fill?.avgPrice ?? 0 },
    };
  }

  // 'not_found' (same day) or 'ambiguous' -> leave untouched
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
export interface SiblingLegCollision {
  basketId: string;
  basketName: string;
  side: 'B' | 'S';
  option: LegInstrument;
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
  candidates: { side: 'B' | 'S'; option: LegInstrument; strike: number; expiry: string }[],
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
            basketId: b.id, basketName: basketLabel(b, 'Unnamed group'),
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

/**
 * How much of a pooled broker position a leg may claim as its own when the
 * user explicitly attributes an under-tracked gap to it (the "Claim" action on
 * the Broker-qty warning). Never automatic — reconcileLegWithBroker still only
 * ever clamps down. The claim is the broker's net qty MINUS every other OPEN /
 * CLOSING / PLACING leg (any basket on the same broker, including this
 * basket's own other legs) tracking the same contract, so a sibling
 * strategy's share can never be absorbed. Returns null when the broker row's
 * sign disagrees with the leg's side (that position isn't this leg's shape).
 */
export function claimableLegQty(
  baskets: MultiLegBasket[],
  basketId: string,
  legId: string,
  brokerNetQty: number,
): { claimQty: number; othersQty: number } | null {
  const self = baskets.find(b => b.id === basketId);
  const leg = self?.legs.find(l => l.id === legId);
  if (!self || !leg) return null;
  const expectedSign = leg.side === 'B' ? 1 : -1;
  if (brokerNetQty === 0 || Math.sign(brokerNetQty) !== expectedSign) return null;
  const legExpiry = leg.expiry || self.expiry;
  let othersQty = 0;
  for (const b of baskets) {
    if (b.broker !== self.broker || b.underlying !== self.underlying) continue;
    for (const l of b.legs) {
      if (b.id === basketId && l.id === legId) continue;
      if (l.status !== 'OPEN' && l.status !== 'CLOSING' && l.status !== 'PLACING') continue;
      if (l.option !== leg.option || l.strike !== leg.strike || (l.expiry || b.expiry) !== legExpiry) continue;
      const q = l.fill?.qty ?? 0;
      othersQty += l.side === leg.side ? q : -q;
    }
  }
  return { claimQty: Math.max(0, Math.abs(brokerNetQty) - othersQty), othersQty };
}

// ─── Cross-leg allocation: every leg on a contract vs the broker ─────────

export interface LegQtyWarning {
  /** 'under': the broker holds more than every tracked leg together (Claim);
   *  'over': less — something closed quantity outside this tool (Reduce). */
  kind: 'under' | 'over';
  ownQty: number;
  brokerQty: number;
  /** Sum of every live leg, in any basket on the same broker, on this contract. */
  trackedQty: number;
  gap: number;
}

function contractKey(basket: MultiLegBasket, leg: MultiLegLeg): string {
  return `${basket.broker}|${basket.underlying}|${leg.option}|${leg.strike}|${leg.expiry || basket.expiry}`;
}

/**
 * reconcileLegWithBroker clamps each leg against the pooled broker row on its
 * own, so legs of 130 and 390 on a 390 position both pass while together they
 * over-track by 130 (a buy placed outside the tool). This compares the SUM per
 * contract. It only reports: which leg absorbs a gap is the user's call.
 * `brokerNetQty` is keyed `${basketId}:${legId}` -> the signed netQty of that
 * leg's matched live row. Groups in flux (an order in flight, fill grace) or
 * with mixed sides are skipped.
 */
export function legQtyWarningsFor(
  baskets: MultiLegBasket[],
  brokerNetQty: Map<string, number>,
  now: number = Date.now(),
): Record<string, LegQtyWarning> {
  const groups = new Map<string, { basket: MultiLegBasket; leg: MultiLegLeg }[]>();
  for (const b of baskets) {
    for (const l of b.legs) {
      if (l.status !== 'OPEN' && l.status !== 'CLOSING' && l.status !== 'PLACING') continue;
      const k = contractKey(b, l);
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k)!.push({ basket: b, leg: l });
    }
  }
  const out: Record<string, LegQtyWarning> = {};
  for (const members of groups.values()) {
    if (members.some(({ leg }) => leg.status !== 'OPEN' || isLegInFillGrace(leg, now) || (leg.pendingOrders?.length ?? 0) > 0)) continue;
    const side = members[0].leg.side;
    if (members.some(({ leg }) => leg.side !== side)) continue;
    let net: number | undefined;
    for (const { basket, leg } of members) {
      net = brokerNetQty.get(`${basket.id}:${leg.id}`);
      if (net != null) break;
    }
    if (net == null || net === 0 || Math.sign(net) !== (side === 'B' ? 1 : -1)) continue;
    const brokerQty = Math.abs(net);
    const trackedQty = members.reduce((s, { leg }) => s + (leg.fill?.qty ?? 0), 0);
    if (brokerQty === trackedQty) continue;
    const kind = brokerQty > trackedQty ? 'under' : 'over';
    for (const { basket, leg } of members) {
      out[`${basket.id}:${leg.id}`] = {
        kind, ownQty: leg.fill?.qty ?? 0, brokerQty, trackedQty, gap: Math.abs(brokerQty - trackedQty),
      };
    }
  }
  return out;
}

/**
 * Records that `qty` of a leg was closed outside this tool — no order placed.
 * A live leg has no field for a partially realized slice, so a partial
 * reduction splits off a CLOSED leg holding that slice; its P&L then survives
 * in basketTotalPnl like any other closed leg.
 */
export function recordOutsideReduction(
  leg: MultiLegLeg,
  qty: number,
  exitPrice: number,
  lotSize: number,
  now: number = Date.now(),
): MultiLegLeg[] {
  const own = leg.fill?.qty ?? 0;
  const avgPrice = leg.fill?.avgPrice ?? 0;
  const cut = Math.min(Math.max(0, qty), own);
  if (cut <= 0) return [leg];
  if (cut >= own) {
    return [{ ...leg, status: 'CLOSED', closedAt: now, fill: { qty: 0, avgPrice }, closedFill: { qty: own, exitPrice } }];
  }
  const lots = (q: number) => (lotSize > 0 ? Math.max(1, Math.round(q / lotSize)) : leg.lots);
  const remaining = own - cut;
  const closedSlice: MultiLegLeg = {
    id: newLegId(), side: leg.side, option: leg.option, strike: leg.strike, expiry: leg.expiry,
    lots: lots(cut), type: leg.type, price: leg.price, orderRef: leg.orderRef,
    status: 'CLOSED', closedAt: now, fill: { qty: 0, avgPrice }, closedFill: { qty: cut, exitPrice },
  };
  return [{ ...leg, lots: lots(remaining), fill: { ...leg.fill, qty: remaining, avgPrice } }, closedSlice];
}

// ─── Importing positions opened outside the tool ─────────────────────────

export interface ContractHint {
  underlying: string;
  option: 'CE' | 'PE';
  strike: number;
  /** null when the broker row carries only month precision (verify via lookup). */
  expiry: string | null;
}

export interface UntrackedPosition {
  broker: string;
  /** Dhan securityId, else the trading symbol — what findLegPosition matches on. */
  ident: string;
  tradingSymbol: string;
  hint: ContractHint | null;
  side: 'B' | 'S';
  brokerQty: number;
  trackedQty: number;
  untrackedQty: number;
  /** Entry average of the untracked qty: the broker's pooled average less lots already tracked or closed today (residualBrokerAvg). */
  brokerAvg: number;
}

/**
 * Entry average of the broker qty NOT already accounted for by this basket
 * store. Dhan's buyAvg/sellAvg pool every lot traded on the contract today,
 * including lots a CLOSED slice has since bought back (2026-10-01, 22300 PE:
 * pooled 180.23 over 1105 sold, of which 585 were closed at an own-lot entry
 * of 125.13 — importing the pooled average for the remaining 520 counted the
 * cheap carried lots twice and overstated the loss by ~32k; the residual is
 * 242.2). Subtracts slices closed today on the same contract and side, and —
 * when `subtractOpen` — the live legs already tracked on it. Falls back to the
 * pooled average whenever the row lacks the pooled qty or the residual is not
 * a sane positive price, so a contract with no closed slices is unchanged.
 */
export function residualBrokerAvg(
  broker: string,
  row: Record<string, unknown>,
  side: 'B' | 'S',
  baskets: MultiLegBasket[],
  subtractOpen: boolean,
  now: number = Date.now(),
): number {
  const pooledAvg = Number((side === 'B' ? row.buyAvg : row.sellAvg) || row.costPrice || 0);
  const pooledQty = Number(side === 'B' ? row.buyQty : row.sellQty) || 0;
  if (!(pooledAvg > 0) || !(pooledQty > 0)) return pooledAvg;
  const ident = broker === 'dhan' ? String(row.securityId ?? '') : String(row.tradingSymbol ?? '');
  if (!ident) return pooledAvg;
  let value = pooledAvg * pooledQty;
  let qty = pooledQty;
  for (const b of baskets) {
    if (b.broker !== broker) continue;
    for (const l of b.legs) {
      if (l.side !== side) continue;
      const lid = broker === 'dhan' ? l.orderRef?.securityId : l.orderRef?.symbol;
      if (lid !== ident || !(l.fill?.avgPrice && l.fill.avgPrice > 0)) continue;
      if (l.status === 'CLOSED') {
        if (l.closedAt == null || istDay(l.closedAt) !== istDay(now) || !(l.closedFill?.qty && l.closedFill.qty > 0)) continue;
        value -= l.fill.avgPrice * l.closedFill.qty;
        qty -= l.closedFill.qty;
      } else if (subtractOpen && (l.status === 'OPEN' || l.status === 'CLOSING' || l.status === 'PLACING') && l.fill.qty > 0) {
        value -= l.fill.avgPrice * l.fill.qty;
        qty -= l.fill.qty;
      }
    }
  }
  const avg = qty > 0 ? value / qty : 0;
  return avg > 0 ? avg : pooledAvg;
}

export interface ContractDrift {
  ident: string;
  tradingSymbol: string;
  side: 'B' | 'S';
  brokerQty: number;
  basketQty: number;
  brokerValue: number;
  basketValue: number;
}

/** Rupee slack for avg-price rounding before a basket-vs-broker value gap is reported. */
export const CONTRACT_DRIFT_TOLERANCE = 50;

/**
 * Per-contract audit of the basket store against the broker's own day totals.
 * For every contract a basket leg points at, the broker row's pooled
 * buyQty*buyAvg / sellQty*sellAvg (carried lots at their entry price) must equal
 * what the baskets record for that side: entry lots of legs on that side (open
 * ones plus ones closed today) plus the exit fills of legs on the opposite side
 * closed today. A gap means a close the baskets never recorded, a wrong entry
 * average (the pooled-average import bug, 2026-10-01) or an estimated exit
 * price. Quantity/value-based on purpose: lot-matching differences between the
 * tool and Dhan's pooled P&L split never trip it. Only Dhan rows carry
 * buyQty/sellQty; others are skipped, as are contracts no leg tracks (Import
 * handles those).
 */
export function findContractDrift(
  broker: string,
  rows: Record<string, unknown>[],
  baskets: MultiLegBasket[],
  now: number = Date.now(),
): ContractDrift[] {
  const today = istDay(now);
  const legsByIdent = new Map<string, MultiLegLeg[]>();
  for (const b of baskets) {
    if (b.broker !== broker) continue;
    for (const l of b.legs) {
      const id = broker === 'dhan' ? l.orderRef?.securityId : l.orderRef?.symbol;
      if (!id) continue;
      legsByIdent.set(id, [...(legsByIdent.get(id) ?? []), l]);
    }
  }
  const out: ContractDrift[] = [];
  for (const row of rows) {
    const ident = broker === 'dhan' ? String(row.securityId ?? '') : String(row.tradingSymbol ?? '');
    const legs = legsByIdent.get(ident);
    if (!legs || row.buyQty == null || row.sellQty == null) continue;
    for (const side of ['B', 'S'] as const) {
      const brokerQty = Number(side === 'B' ? row.buyQty : row.sellQty) || 0;
      const brokerValue = brokerQty * (Number(side === 'B' ? row.buyAvg : row.sellAvg) || 0);
      let basketQty = 0;
      let basketValue = 0;
      for (const l of legs) {
        const fill = l.fill?.avgPrice ?? 0;
        if (l.status === 'CLOSED') {
          if (l.closedAt == null || istDay(l.closedAt) !== today || !l.closedFill) continue;
          const q = l.closedFill.qty;
          if (l.side === side) { basketQty += q; basketValue += q * fill; }
          else { basketQty += q; basketValue += q * l.closedFill.exitPrice; }
        } else if (l.status === 'OPEN' || l.status === 'CLOSING' || l.status === 'PLACING') {
          if (l.side === side && (l.fill?.qty ?? 0) > 0) { basketQty += l.fill!.qty; basketValue += l.fill!.qty * fill; }
        }
      }
      if (basketQty === brokerQty && Math.abs(basketValue - brokerValue) <= CONTRACT_DRIFT_TOLERANCE) continue;
      out.push({ ident, tradingSymbol: String(row.tradingSymbol ?? ident), side, brokerQty, basketQty, brokerValue, basketValue });
    }
  }
  return out;
}

/**
 * Broker option positions whose net qty is not fully covered by live legs.
 * Legs are matched by the same identity findLegPosition uses (Dhan securityId,
 * else trading symbol), so what shows here is exactly what reconciliation
 * would not attribute to any leg. An over-tracked contract never appears —
 * that's legQtyWarningsFor's 'over' case, not something to import.
 */
export function findUntrackedPositions(
  broker: string,
  rows: Record<string, unknown>[],
  baskets: MultiLegBasket[],
  hintFor: (row: Record<string, unknown>) => ContractHint | null,
  now = Date.now(),
): UntrackedPosition[] {
  const trackedSigned = new Map<string, number>();
  for (const b of baskets) {
    if (b.broker !== broker) continue;
    for (const l of b.legs) {
      if (l.status !== 'OPEN' && l.status !== 'CLOSING' && l.status !== 'PLACING') continue;
      const ident = broker === 'dhan' ? l.orderRef?.securityId : l.orderRef?.symbol;
      if (!ident) continue;
      const q = l.fill?.qty ?? 0;
      trackedSigned.set(ident, (trackedSigned.get(ident) ?? 0) + (l.side === 'B' ? q : -q));
    }
  }
  const out: UntrackedPosition[] = [];
  for (const row of rows) {
    const net = Number(row.netQty) || 0;
    if (net === 0) continue;
    if (String(row.positionType ?? '').trim().toUpperCase() === 'CLOSED') continue;
    const tradingSymbol = String(row.tradingSymbol ?? '');
    const ident = broker === 'dhan' ? String(row.securityId ?? '') : tradingSymbol;
    if (!ident) continue;
    const hint = hintFor(row);
    if (!hint) continue;
    const tracked = trackedSigned.get(ident) ?? 0;
    const rest = net - tracked;
    if (rest === 0 || Math.sign(rest) !== Math.sign(net)) continue;
    const side = net > 0 ? 'B' : 'S';
    out.push({
      broker, ident, tradingSymbol, hint, side,
      brokerQty: Math.abs(net),
      trackedQty: Math.abs(tracked),
      untrackedQty: Math.abs(rest),
      brokerAvg: residualBrokerAvg(broker, row, side, baskets, true, now),
    });
  }
  return out;
}

/**
 * Best-effort contract for a broker position row: Dhan's drv* fields, else
 * the trading symbol. Only a HINT — Zerodha's monthly symbols can misparse
 * (NIFTY26OCT23400CE reads as day 26), so the caller must verify it against the
 * broker's own strike lookup before adopting anything.
 */
export function contractHintFromRow(row: Record<string, unknown>, underlyings: string[]): ContractHint | null {
  const sym = String(row.tradingSymbol ?? '');
  const underlying = [...underlyings].sort((a, b) => b.length - a.length).find(u => symbolMatchesUnderlying(sym, u));
  if (!underlying) return null;
  const drvType = normalizeOptType(row.drvOptionType);
  const drvStrike = Number(row.drvStrikePrice ?? 0);
  if (drvType && drvStrike > 0) {
    return { underlying, option: drvType, strike: drvStrike, expiry: normalizeExpiry(row.drvExpiryDate) };
  }
  const parsed = parseTradingSymbol(sym);
  if (!parsed) return null;
  return { underlying, option: parsed.type, strike: parsed.strike, expiry: parsed.expiry };
}

/** A live leg adopting `qty` of an untracked broker position (no order placed). */
export function legFromUntracked(
  pos: UntrackedPosition,
  contract: { option: 'CE' | 'PE'; strike: number; expiry: string },
  qty: number,
  avgPrice: number,
  lotSize: number,
): MultiLegLeg {
  return {
    id: newLegId(),
    side: pos.side,
    option: contract.option,
    strike: contract.strike,
    expiry: contract.expiry,
    lots: lotSize > 0 ? Math.max(1, Math.round(qty / lotSize)) : 1,
    type: 'MARKET',
    price: avgPrice,
    status: 'OPEN',
    fill: { qty, avgPrice },
    orderRef: pos.broker === 'dhan' ? { securityId: pos.ident } : { symbol: pos.ident },
  };
}

/**
 * Adds imported legs to a basket, folding each into an OPEN leg already on the
 * same contract (same side, option, strike, expiry and broker identity) instead
 * of appending a second row for one position (2026-10-01: a 195 import landed
 * beside the strangle's own 390 on 22300 PE). Qty adds, avg is qty-weighted, and
 * `filledAt` is stamped as on every ledger-growing path. A leg with unsettled
 * pendingOrders is left alone (its order outcome is still being applied), so the
 * import is appended as before. Returns the new legs and how many were merged.
 */
export function mergeImportedLegs(
  legs: MultiLegLeg[],
  imported: MultiLegLeg[],
  now: number = Date.now(),
): { legs: MultiLegLeg[]; merged: number } {
  const ident = (l: MultiLegLeg) => l.orderRef?.securityId || l.orderRef?.symbol || '';
  let out = legs;
  let merged = 0;
  for (const imp of imported) {
    const impQty = imp.fill?.qty ?? 0;
    const idx = impQty > 0 ? out.findIndex(l =>
      l.status === 'OPEN' && !l.pendingOrders?.length && (l.fill?.qty ?? 0) > 0
      && l.side === imp.side && l.option === imp.option && l.strike === imp.strike
      && l.expiry === imp.expiry && ident(l) !== '' && ident(l) === ident(imp),
    ) : -1;
    if (idx < 0) {
      out = [...out, imp];
      continue;
    }
    const cur = out[idx];
    const curQty = cur.fill!.qty;
    const qty = curQty + impQty;
    const avgPrice = (curQty * (cur.fill!.avgPrice ?? 0) + impQty * (imp.fill!.avgPrice ?? 0)) / qty;
    out = out.map((l, i) => (i === idx
      ? { ...l, lots: l.lots + imp.lots, fill: { ...l.fill, qty, avgPrice }, filledAt: now }
      : l));
    merged++;
  }
  return { legs: out, merged };
}

// ─── Execution broker ────────────────────────────────────────────────────

/** A basket trades on the broker stamped on it at creation (`basket.broker`,
 *  shown as the badge on its row), whatever the toolbar selector says now; the
 *  selector only picks the broker for NEW strategies. Every order, exit,
 *  lookup and margin call for a basket must go through this — otherwise
 *  switching the selector sends a Dhan strategy's exit or add-lots to Kotak
 *  (wrong account). Falls back to the selector only for a legacy basket
 *  persisted without a broker. */
export function executionBroker(basket: Pick<MultiLegBasket, 'broker'>, selected: string): string {
  return basket.broker || selected;
}

// ─── Post-ACK order outcomes ─────────────────────────────────────────────

export interface PendingLegOrder {
  id: string;
  /** 'grow' = opened / added to the leg; 'exit' = closed it. */
  kind: 'grow' | 'exit';
  qty: number;
  at: number;
  /** Price the ledger recorded on ACK (response price, else LTP, else entry)
   *  — a placeholder. Replaced by the traded average once the order fills. */
  price?: number;
}

/** Give up on an order that never shows up in the order book after this long. */
export const PENDING_ORDER_TTL_MS = 30 * 60_000;

export interface NormalizedOrder { id: string; status: string; filled: number | null; avgPrice: number | null }

/** Dhan (raw), Zerodha and Kotak (shaped) order-book rows → one shape.
 *  `filled` is null when the row carries no filled-quantity field. */
export function normalizeOrderRow(row: Record<string, unknown>): NormalizedOrder | null {
  const id = String(row.orderId ?? row.order_id ?? row.nOrdNo ?? '');
  if (!id) return null;
  const status = String(row.orderStatus ?? row.status ?? row.ordSt ?? '').toUpperCase();
  const rawFilled = row.filledQty ?? row.filled_quantity ?? row.fldQty ?? row.tradedQuantity;
  const filled = rawFilled == null || rawFilled === '' ? null : (Number(rawFilled) || 0);
  const avg = Number(row.averageTradedPrice ?? row.averagePrice ?? row.average_price ?? row.avgPrc) || 0;
  return { id, status, filled, avgPrice: avg > 0 ? avg : null };
}

const FILLED_STATUSES = new Set(['TRADED', 'COMPLETE', 'FILLED']);
const DEAD_STATUSES = new Set(['REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED']);

export interface OrderOutcomeNote { kind: 'grow' | 'exit'; status: string; unfilled: number; unknownFill?: boolean }

/**
 * Settles a leg's pending orders against the order book. A filled order is
 * just dropped. A rejected/cancelled/expired one has its ledger effect undone
 * for the UNFILLED part only:
 * - grow: the qty it added comes back off `fill.qty` (a leg left with nothing
 *   becomes FAILED) — otherwise a rejected entry is a phantom OPEN leg the
 *   position book never confirms, and nothing else would ever clear it.
 * - exit: the leg is reopened with the unfilled qty — exitOneLeg marks CLOSED
 *   on ACK, and reconciliation never resurrects a CLOSED leg, so a rejected
 *   exit would otherwise leave a live position the tool no longer tracks.
 * A cancelled/expired order whose row has no filled-qty field can't be sized
 * safely; it is dropped and reported (`unknownFill`) instead of guessed at.
 */
export function applyOrderOutcomes(
  leg: MultiLegLeg,
  ordersById: Map<string, NormalizedOrder>,
  lotSize: number,
  now: number = Date.now(),
): { leg: MultiLegLeg; notes: OrderOutcomeNote[] } {
  const pending = leg.pendingOrders;
  if (!pending?.length) return { leg, notes: [] };
  const notes: OrderOutcomeNote[] = [];
  const keep: PendingLegOrder[] = [];
  let next = leg;
  for (const p of pending) {
    const o = ordersById.get(p.id);
    if (!o) {
      if (now - p.at < PENDING_ORDER_TTL_MS) keep.push(p);
      continue;
    }
    if (FILLED_STATUSES.has(o.status)) {
      if (o.avgPrice != null) next = settleFillPrice(next, p, o.avgPrice);
      continue;
    }
    if (!DEAD_STATUSES.has(o.status)) { keep.push(p); continue; }
    const rejected = o.status === 'REJECTED';
    if (!rejected && o.filled == null) {
      notes.push({ kind: p.kind, status: o.status, unfilled: 0, unknownFill: true });
      continue;
    }
    const unfilled = Math.max(0, p.qty - (rejected ? 0 : (o.filled ?? 0)));
    if (unfilled <= 0) continue;
    notes.push({ kind: p.kind, status: o.status, unfilled });
    const lotsOf = (q: number) => (lotSize > 0 ? Math.max(1, Math.round(q / lotSize)) : next.lots);
    if (p.kind === 'grow') {
      const qty = Math.max(0, (next.fill?.qty ?? 0) - unfilled);
      next = {
        ...next,
        fill: { ...(next.fill ?? { avgPrice: 0 }), qty },
        lots: qty > 0 ? lotsOf(qty) : next.lots,
        status: qty > 0 ? next.status : (next.status === 'OPEN' ? 'FAILED' : next.status),
        filledAt: undefined,
      };
    } else {
      const qty = (next.status === 'CLOSED' ? 0 : (next.fill?.qty ?? 0)) + unfilled;
      const closedQty = (next.closedFill?.qty ?? 0) - unfilled;
      next = {
        ...next,
        status: 'OPEN',
        fill: { ...(next.fill ?? { avgPrice: 0 }), qty },
        lots: lotsOf(qty),
        closedFill: closedQty > 0 && next.closedFill ? { ...next.closedFill, qty: closedQty } : undefined,
        closedAt: undefined,
        filledAt: now,
      };
    }
  }
  if (keep.length === pending.length && notes.length === 0) return { leg, notes };
  // Settled (or expired) orders leave pendingOrders but stay this leg's own:
  // ownOrderIds needs them to tell its trades apart from outside ones.
  const settled = pending.filter(p => !keep.includes(p)).map(p => p.id);
  const orderIds = settled.length ? Array.from(new Set([...(next.orderIds ?? []), ...settled])) : next.orderIds;
  return { leg: { ...next, pendingOrders: keep.length ? keep : undefined, ...(orderIds ? { orderIds } : {}) }, notes };
}

/**
 * Swaps the ACK-time placeholder price for the order's traded average. Exits
 * mark CLOSED on ACK with LTP (or, when no LTP is loaded, the ENTRY price —
 * a zero-P&L close), and reconciliation never revisits a CLOSED leg, so
 * without this the realized P&L stays whatever was guessed at ACK
 * (2026-09-29: a 22600 PE bought back at 170.675 booked ₹0).
 */
function settleFillPrice(leg: MultiLegLeg, p: PendingLegOrder, actual: number): MultiLegLeg {
  if (p.kind === 'exit') {
    const cf = leg.closedFill;
    if (!cf || cf.qty <= 0) return leg;
    let exitPrice: number;
    if (p.price != null && p.qty <= cf.qty) exitPrice = cf.exitPrice + ((actual - p.price) * p.qty) / cf.qty;
    else if (cf.qty === p.qty) exitPrice = actual;
    else return leg;
    return { ...leg, closedFill: { ...cf, exitPrice } };
  }
  if (p.price == null || !leg.fill) return leg;
  const base = leg.status === 'CLOSED' ? (leg.closedFill?.qty ?? 0) : leg.fill.qty;
  if (base < p.qty || base <= 0) return leg;
  const avgPrice = leg.fill.avgPrice + ((actual - p.price) * p.qty) / base;
  return { ...leg, price: avgPrice, fill: { ...leg.fill, avgPrice } };
}

/** Appends a just-ACKed order to a leg's pending list, with the price the ledger recorded for it. */
export function withPendingOrder(
  leg: MultiLegLeg, id: string | undefined, kind: 'grow' | 'exit', qty: number, price?: number, now: number = Date.now(),
): MultiLegLeg {
  if (!id || qty <= 0) return leg;
  const entry: PendingLegOrder = { id: String(id), kind, qty, at: now, ...(price != null && price > 0 ? { price } : {}) };
  return { ...leg, pendingOrders: [...(leg.pendingOrders ?? []), entry] };
}

/** True when a leg's recorded order identity can't have come from `broker`:
 *  Dhan orders always carry a securityId; Zerodha/Kotak orders carry only a
 *  trading symbol. Before executionBroker existed, a leg could be placed on the
 *  toolbar's broker while its basket was stamped with another — such a leg
 *  must not be exited/added/reconciled against the basket's broker, where a
 *  same-strike position would be someone else's (wrong account). */
export function legBrokerMismatch(leg: Pick<MultiLegLeg, 'orderRef'>, broker: string): boolean {
  const ref = leg.orderRef;
  if (!ref) return false;
  if (broker === 'dhan') return !ref.securityId && !!ref.symbol;
  return !ref.symbol && !!ref.securityId;
}

/** Dhan order status → what a just-placed leg's order means for placement.
 * - filled: TRADED (a MARKET order is only "placed" once this is seen).
 * - working: a LIMIT order resting / part-filled at the exchange — accepted,
 *   may still fill; handled like before (never auto-reversed).
 * - dead: REJECTED / CANCELLED / EXPIRED — the leg never opened.
 * - pending: TRANSIT / PENDING-for-MARKET / unknown — keep waiting. */
export type DhanOrderPhase = 'filled' | 'working' | 'dead' | 'pending';

export function classifyDhanOrder(status: string, orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SLM'): DhanOrderPhase {
  const s = status.toUpperCase();
  if (s === 'TRADED') return 'filled';
  if (s === 'REJECTED' || s === 'CANCELLED' || s === 'CANCELED' || s === 'EXPIRED') return 'dead';
  // A stop order waiting for its trigger reads PENDING at Dhan, same as a resting limit.
  if (orderType !== 'MARKET' && (s === 'PENDING' || s === 'PART_TRADED')) return 'working';
  return 'pending';
}

// ─── Outside closes priced from the trade book ───────────────────────────

/** correlationId prefix on every Dhan order this page places (fast-order's
 *  `source`), so its orders stay recognisable in the order book after they
 *  settle and drop out of a leg's pendingOrders. */
export const MLF_ORDER_SOURCE = 'mlf';

export interface NormalizedTrade {
  /** Unique per fill: order id + exchange trade id (else time/qty/price). */
  key: string;
  orderId: string;
  /** Dhan securityId, else the trading symbol — what findLegPosition matches on. */
  ident: string;
  side: LegSide;
  qty: number;
  price: number;
  /** Epoch ms; 0 when the row's time can't be parsed. */
  at: number;
}

function tradeTime(raw: unknown): number {
  const s = String(raw ?? '').trim();
  if (!s) return 0;
  // Dhan / Zerodha send IST wall-clock "YYYY-MM-DD HH:MM:SS" with no zone;
  // Kotak's fill time can be the bare "HH:MM:SS" of today (IST).
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const full = /^\d{2}:\d{2}(:\d{2})?$/.test(s) ? `${today} ${s}` : s;
  const ist = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(full) ? `${full.replace(' ', 'T')}+05:30` : full;
  const t = Date.parse(ist);
  return Number.isFinite(t) ? t : 0;
}

/** Dhan (raw) and Zerodha/Kotak (shaped) trade-book rows -> one shape. */
export function normalizeTradeRow(row: Record<string, unknown>): NormalizedTrade | null {
  const orderId = String(row.orderId ?? row.order_id ?? '');
  const ident = String(row.securityId ?? '') || String(row.tradingSymbol ?? row.tradingsymbol ?? '');
  const tx = String(row.transactionType ?? '').toUpperCase();
  const qty = Number(row.tradedQuantity) || 0;
  const price = Number(row.tradedPrice) || 0;
  if (!ident || qty <= 0 || price <= 0 || (tx !== 'BUY' && tx !== 'SELL')) return null;
  const rawTime = row.exchangeTime ?? row.createTime ?? row.updateTime;
  const tradeId = String(row.exchangeTradeId ?? row.tradeId ?? '');
  const key = `${orderId}:${tradeId || `${String(rawTime ?? '')}:${qty}:${price}`}`;
  return { key, orderId, ident, side: tx === 'BUY' ? 'B' : 'S', qty, price, at: tradeTime(rawTime) };
}

/** Every order id this tool placed: settled (orderIds), in flight
 *  (pendingOrders), the last recorded fill, and any order-book row carrying
 *  MLF_ORDER_SOURCE's correlationId prefix. */
export function ownOrderIds(baskets: MultiLegBasket[], orderRows: Record<string, unknown>[] = []): Set<string> {
  const ids = new Set<string>();
  for (const b of baskets) {
    for (const l of b.legs) {
      for (const id of l.orderIds ?? []) ids.add(id);
      for (const p of l.pendingOrders ?? []) ids.add(p.id);
      if (l.fill?.orderId) ids.add(String(l.fill.orderId));
    }
  }
  for (const r of orderRows) {
    if (String(r.correlationId ?? '').startsWith(MLF_ORDER_SOURCE)) {
      const id = String(r.orderId ?? '');
      if (id) ids.add(id);
    }
  }
  return ids;
}

/** Trades on `ident` this tool did not place that close `qty` on `closeSide`
 *  at or before `before` and not before `after` (±60s clock skew), and no
 *  other close has claimed.
 *  Tries each run of consecutive trades, newest first, and takes the first
 *  that adds up to exactly `qty`; anything else is ambiguous -> null. */
export function matchOutsideTrades(
  trades: NormalizedTrade[],
  ident: string,
  closeSide: LegSide,
  qty: number,
  before: number,
  own: Set<string>,
  used: Set<string>,
  /** Epoch ms the position being closed was opened; earlier trades can't be its close (0 = no bound). */
  after = 0,
): { exitPrice: number; keys: string[] } | null {
  if (qty <= 0) return null;
  const cands = trades
    .filter(t => t.ident === ident && t.side === closeSide && !own.has(t.orderId) && !used.has(t.key)
      && t.at > 0 && t.at <= before + 60_000 && (after <= 0 || t.at >= after - 60_000))
    .sort((a, b) => b.at - a.at);
  for (let i = 0; i < cands.length; i++) {
    let sum = 0;
    let value = 0;
    for (let j = i; j < cands.length && sum < qty; j++) {
      sum += cands[j].qty;
      value += cands[j].qty * cands[j].price;
      if (sum === qty) return { exitPrice: value / qty, keys: cands.slice(i, j + 1).map(t => t.key) };
    }
  }
  return null;
}

/**
 * Replaces the estimated exit price of every leg closed outside this tool
 * (reconcile's flat/pooled-row close, brokerClampSlice) with the actual
 * outside trade(s) from the broker's trade book, once they are there. Only an
 * exact qty match counts; until then the leg keeps its estimate and "est."
 * mark. `tradesByBroker` holds only brokers whose trade book was read this
 * tick — a missing book changes nothing. Returns the input array when nothing
 * was repriced.
 */
export function repriceEstimatedCloses(
  baskets: MultiLegBasket[],
  tradesByBroker: Partial<Record<string, NormalizedTrade[]>>,
  own: Set<string>,
): MultiLegBasket[] {
  const used = new Set<string>();
  for (const b of baskets) for (const l of b.legs) for (const k of l.outsideTradeKeys ?? []) used.add(k);
  let changed = false;
  const next = baskets.map(b => {
    const trades = tradesByBroker[b.broker];
    if (!trades?.length) return b;
    let bChanged = false;
    const legs = b.legs.map(l => {
      const cf = l.closedFill;
      if (l.status !== 'CLOSED' || !cf?.estimated || l.outsideTradeKeys?.length) return l;
      const ident = l.orderRef?.securityId || l.orderRef?.symbol;
      if (!ident) return l;
      const m = matchOutsideTrades(trades, ident, l.side === 'B' ? 'S' : 'B', cf.qty, l.closedAt ?? Date.now(), own, used);
      if (!m) return l;
      for (const k of m.keys) used.add(k);
      bChanged = true;
      return { ...l, closedFill: { qty: cf.qty, exitPrice: m.exitPrice }, outsideTradeKeys: m.keys };
    });
    if (!bChanged) return b;
    changed = true;
    return { ...b, legs, updatedAt: new Date().toISOString() };
  });
  return changed ? next : baskets;
}
