// Pure rules for the Triple Straddle page's own trade ledger. No React, no fetch:
// everything here is unit-tested (tripleStraddle.test.ts) so the real-money paths
// (sizing, P&L, stop/target) never depend on component state.
//
// One ledger entry = one straddle slot (left / centre / right) = a CE + PE pair of
// the SAME side. Ownership is this ledger, never the broker net position (Dhan nets
// by security id, so two slots on overlapping strikes share one broker row).

export type TsSlot = 'left' | 'center' | 'right';
export type TsSide = 'B' | 'S';
export type TsMode = 'SIM' | 'REAL';
export type TsProduct = 'INTRADAY' | 'MARGIN';
export type TsStatus = 'OPEN' | 'CLOSED';

export type TsExitReason = 'MANUAL' | 'SL' | 'TARGET' | 'TRAIL' | 'LOCK';

export const TS_SLOTS: TsSlot[] = ['left', 'center', 'right'];
export const TS_MAX_LOTS = 50;
export const TS_ORDER_SOURCE = 'ts';
/** Fills are exempt from broker down-reconcile for this long (position book lags). */
export const TS_FILL_GRACE_MS = 20_000;

export interface TsLeg {
  option: 'CE' | 'PE';
  securityId?: string;
  symbol?: string;
  qty: number;
  entry: number;
  /** Set once this leg's closing order is confirmed filled. */
  exit?: number;
  closed?: boolean;
  /** Entry order was accepted but its fill is not confirmed (REAL only). */
  unconfirmed?: boolean;
  /** A closing order was accepted but its fill is unconfirmed. While set, the exit is
   *  NOT re-sent (a retry could double-close and open the opposite side). */
  pendingExit?: { orderId: string; at: number };
  orderIds: string[];
}

/** Trailing / profit-lock rules, ported from Focus Tool's overall trail (evaluateOverallExit),
 *  expressed in % of the entry combined premium. All values are percentages.
 *  - trailSl:  every `every`% of peak profit, the stop tightens by `by`% (needs slPct); may pass
 *              zero, which is a locked profit.
 *  - lock:     once peak profit reached `reach`%, exit if profit falls back to `lock`%
 *              (`lock` unset = 0 = breakeven).
 *  - lockTrail: as lock, with the floor then rising by `by`% for every `every`% more peak. */
export type TsTrailKind = 'trailSl' | 'lock' | 'lockTrail';
export interface TsTrail {
  kind: TsTrailKind;
  every?: number;
  by?: number;
  reach?: number;
  lock?: number;
}

export interface TsRisk {
  trail?: TsTrail;
  /** % of the entry combined premium. Short: premium rising by this much stops out. */
  slPct?: number;
  /** % of the entry combined premium captured/gained to take profit. */
  targetPct?: number;
  armed: boolean;
}

export interface TsPosition {
  id: string;
  slot: TsSlot;
  mode: TsMode;
  side: TsSide;
  underlying: string;
  expiry: string;
  strike: number;
  lots: number;
  lotSize: number;
  product: TsProduct;
  status: TsStatus;
  legs: [TsLeg, TsLeg];
  risk: TsRisk;
  openedAt: number;
  closedAt?: number;
  exitReason?: TsExitReason;
  /** Highest P&L % (of entry premium) seen while open, never below 0. The trail and lock rules
   *  run off this, so it is persisted: a reload must not forget how far it ran. */
  peakPct?: number;
}

export interface TsState {
  /** At most one OPEN position per slot; closed ones are kept for today's history. */
  positions: TsPosition[];
  updatedAt?: number;
}

/** Sum of both legs' entry prices (combined premium per unit). */
export function entryPremium(p: Pick<TsPosition, 'legs'>): number {
  return p.legs[0].entry + p.legs[1].entry;
}

export function openQtyUnits(p: Pick<TsPosition, 'lots' | 'lotSize'>): number {
  return p.lots * p.lotSize;
}

/** P&L in rupees. Closed legs use their exit price; open legs the live price.
 *  Returns null when an open leg has no usable live price (never show 0 for unknown). */
export function straddlePnl(p: TsPosition, ltp: { CE?: number; PE?: number }): number | null {
  let total = 0;
  for (const leg of p.legs) {
    const px = leg.closed ? leg.exit : ltp[leg.option];
    if (px == null || !Number.isFinite(px) || px <= 0) return null;
    const perUnit = p.side === 'S' ? leg.entry - px : px - leg.entry;
    total += perUnit * leg.qty;
  }
  return total;
}

/** P&L as % of the entry combined premium (the stop/target basis). */
export function straddlePnlPct(p: TsPosition, ltp: { CE?: number; PE?: number }): number | null {
  const pnl = straddlePnl(p, ltp);
  // Premium actually deployed: sum of entry x qty over the legs that exist (a rejected
  // leg has qty 0 and must not zero the basis).
  const basis = p.legs.reduce((sum, l) => sum + l.entry * l.qty, 0);
  if (pnl == null || basis <= 0) return null;
  return (pnl / basis) * 100;
}

/** The running profit peak in % of entry premium; null while unpriced. Never below 0. */
export function nextPeakPct(p: TsPosition, ltp: { CE?: number; PE?: number }): number | null {
  const pct = straddlePnlPct(p, ltp);
  if (pct == null) return null;
  return Math.max(p.peakPct ?? 0, pct, 0);
}

/** Loss limit / profit floor currently in force, in % of entry premium (floor is a P&L %). */
export function activeFloorPct(risk: TsRisk, peak: number): { kind: 'SL' | 'TRAIL' | 'LOCK'; floor: number } | null {
  const t = risk.trail;
  const sl = risk.slPct != null && risk.slPct > 0 ? risk.slPct : null;
  if (t?.kind === 'trailSl') {
    // by > every would put the floor above the profit that set it (an instant exit): invalid.
    if (sl == null || !(t.every! > 0) || !(t.by! > 0) || t.by! > t.every!) return sl != null ? { kind: 'SL', floor: -sl } : null;
    const n = Math.floor(peak / t.every! + 1e-9);
    return n > 0 ? { kind: 'TRAIL', floor: 0 - (sl - n * t.by!) } : { kind: 'SL', floor: -sl };
  }
  if ((t?.kind === 'lock' || t?.kind === 'lockTrail') && t.reach! > 0) {
    const lock = t.lock != null && t.lock >= 0 ? t.lock : 0;
    if (lock < t.reach! && peak >= t.reach!) {
      const steps = t.kind === 'lockTrail' && t.every! > 0 && t.by! > 0 && t.by! <= t.every! ? Math.floor((peak - t.reach!) / t.every! + 1e-9) * t.by! : 0;
      const lockFloor = lock + steps;
      // A plain stop that is still tighter than the lock keeps priority only if it is above it.
      return { kind: 'LOCK', floor: sl != null ? Math.max(lockFloor, -sl) : lockFloor };
    }
  }
  return sl != null ? { kind: 'SL', floor: -sl } : null;
}

const RISK_EPS = 1e-6;

/** Stop / target / trail / lock decision. Null when disarmed, unpriced, or a leg is already closed
 *  or unconfirmed (a half-closed straddle needs the user, not an automatic second exit).
 *  The peak includes the current reading, so a spike and an immediate reversal in one tick still lock. */
export function evaluateRisk(p: TsPosition, ltp: { CE?: number; PE?: number }): 'SL' | 'TARGET' | 'TRAIL' | 'LOCK' | null {
  if (p.status !== 'OPEN' || !p.risk.armed) return null;
  if (p.legs.some((l) => l.closed || l.unconfirmed)) return null;
  const pct = straddlePnlPct(p, ltp);
  const peak = nextPeakPct(p, ltp);
  if (pct == null || peak == null) return null;
  const { targetPct } = p.risk;
  if (targetPct != null && targetPct > 0 && pct >= targetPct - RISK_EPS) return 'TARGET';
  const f = activeFloorPct(p.risk, peak);
  if (f && pct <= f.floor + RISK_EPS) return f.kind;
  return null;
}

/** Validates a trade request; returns an error message or null. Mirrors the server cap. */
export function validateTrade(lots: number, lotSize: number): string | null {
  if (!Number.isInteger(lots) || lots <= 0) return 'Lots must be a positive whole number';
  if (lots > TS_MAX_LOTS) return `Max ${TS_MAX_LOTS} lots per straddle`;
  if (!Number.isFinite(lotSize) || lotSize <= 0) return 'Lot size not loaded yet';
  return null;
}

export function openPositionFor(state: TsState, slot: TsSlot): TsPosition | undefined {
  return state.positions.find((p) => p.slot === slot && p.status === 'OPEN');
}

/** Replace/insert one position by id. */
export function upsertPosition(state: TsState, pos: TsPosition): TsState {
  const exists = state.positions.some((p) => p.id === pos.id);
  return {
    ...state,
    positions: exists ? state.positions.map((p) => (p.id === pos.id ? pos : p)) : [...state.positions, pos],
  };
}

/** Closed positions older than today's IST day are dropped; OPEN ones are never dropped. */
export function pruneState(state: TsState, now: number = Date.now()): TsState {
  const day = (t: number) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const today = day(now);
  return {
    ...state,
    positions: state.positions.filter((p) => p.status === 'OPEN' || (p.closedAt != null && day(p.closedAt) === today)),
  };
}

/** Quantity to send when closing one leg. `brokerAbsQty` is what the broker still shows
 *  in the leg's direction (null = unknown). Never exceeds this ledger's own qty; when the
 *  broker shows less (a sibling slot or the user already closed some), clamp down to it. */
export function exitQtyForLeg(ownQty: number, brokerAbsQty: number | null): number {
  if (!(ownQty > 0)) return 0;
  if (brokerAbsQty == null) return ownQty;
  return Math.max(0, Math.min(ownQty, brokerAbsQty));
}

/** What the broker shows for one leg's contract, in the direction this ledger holds. */
export type BrokerCapacity =
  | { kind: 'qty'; qty: number }
  | { kind: 'flat' }        // a matching row exists and is flat/closed
  | { kind: 'opposite' }    // only the other direction is open (not ours to close)
  | { kind: 'unknown' };    // positions unreadable or no matching row at all

/** Reads the broker position rows for ONE leg. Matches security id AND product (a
 *  strategy's MARGIN row must not be read as this INTRADAY leg). An absent row is
 *  'unknown', never 'flat': the book lags and may be empty on a transient failure. */
export function brokerCapacity(
  rows: Record<string, unknown>[] | null, securityId: string | undefined, product: TsProduct, side: TsSide,
): BrokerCapacity {
  if (!rows || !securityId) return { kind: 'unknown' };
  const mine = rows.filter((r) => {
    if (String(r.securityId ?? '') !== securityId) return false;
    const prod = String(r.productType ?? r.product ?? '').trim().toUpperCase();
    return prod === '' || prod === product;
  });
  if (mine.length === 0) return { kind: 'unknown' };
  const live = mine.filter((r) => String(r.positionType ?? '').trim().toUpperCase() !== 'CLOSED' && (Number(r.netQty) || 0) !== 0);
  if (live.length === 0) return { kind: 'flat' };
  const ours = live.filter((r) => (side === 'S' ? Number(r.netQty) < 0 : Number(r.netQty) > 0));
  if (ours.length === 0) return { kind: 'opposite' };
  return { kind: 'qty', qty: ours.reduce((sum, r) => sum + Math.abs(Number(r.netQty)), 0) };
}

/** Price older than this is treated as unknown: stops and P&L must not run on a dead feed. */
export const TS_PRICE_STALE_MS = 20_000;

/** Total for a set of positions. Unpriced positions are counted, not silently zeroed. */
export function pnlSummary(
  positions: TsPosition[],
  ltpFor: (p: TsPosition) => { CE?: number; PE?: number },
): { total: number; priced: number; unpriced: number } {
  let total = 0; let priced = 0; let unpriced = 0;
  for (const p of positions) {
    const v = straddlePnl(p, ltpFor(p));
    if (v == null) unpriced += 1; else { total += v; priced += 1; }
  }
  return { total, priced, unpriced };
}

/** Rupee P&L for the whole day across positions (closed ones count once, at their exit). */
export function totalPnl(
  positions: TsPosition[],
  ltpFor: (p: TsPosition) => { CE?: number; PE?: number },
): number | null {
  let total = 0;
  for (const p of positions) {
    const v = straddlePnl(p, ltpFor(p));
    if (v == null) return null;
    total += v;
  }
  return total;
}

/** Whether the profit peak may be ratcheted and saved: armed, and every leg confirmed open.
 *  Half-closed or unconfirmed positions mix prices and would record a bogus peak. */
export function peakTrackable(p: TsPosition): boolean {
  return p.status === 'OPEN' && p.risk.armed && p.legs.every((l) => !l.closed && !l.unconfirmed && !l.pendingExit);
}
