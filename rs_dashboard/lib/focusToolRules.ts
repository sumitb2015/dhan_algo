/**
 * The Focus Tool rule engine: every decision that can open or close a real
 * position, as pure functions.
 *
 * These used to live inside components/FocusTool.tsx, where nothing could
 * reach them — the terminal's shipping rules had no test coverage at all,
 * while the only test file in the feature covered a parallel implementation
 * that was never wired up. They are extracted here so both this page and its
 * server-side twin can be checked against the same cases.
 *
 * PARITY. scripts/tools/focus_tool_rows_worker.py runs these same rules
 * outside the browser, so a disagreement between the two means the screen
 * shows one thing and the account does another. That is no longer asserted
 * only in a comment: lib/focusToolRules.cases.json is a shared fixture that
 * BOTH implementations are run against — focusToolRules.test.ts here and
 * tests/test_focus_tool_parity.py there. Change a rule and you change the
 * fixture, which fails the other side until it is changed too.
 *
 * Everything here is pure: no fetch, no DOM, no clock. Time arrives as
 * 'HH:MM' IST and dates as 'YYYY-MM-DD', because a function that reads the
 * clock itself cannot be tested at 15:17.
 */

import type { FocusRow, FocusDte, FocusRowStatus } from '@/lib/focusToolRows';

// ── Constants ────────────────────────────────────────────────────────────────

/**
 * Repo-wide intraday square-off, 15:17 IST (CLAUDE.md — every strategy
 * hardcodes it). Applied to MIS rows as a backstop so a row whose own exit
 * time is later than the broker's auto-square-off never rides into it.
 */
export const INTRADAY_BACKSTOP_HM = '15:17';

// ── Position / row views ─────────────────────────────────────────────────────

/** One leg of a broker position book row, as this page reads it. */
export interface PosRow {
  tradingSymbol: string;
  securityId: string;
  exchangeSegment: string;
  productType: string;
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  lastTradedPrice?: number;
  realizedProfit: number;
  unrealizedProfit: number;
}

/** Everything the rules need to judge one row. */
export interface RowLive {
  ceStrike: number | null;
  peStrike: number | null;
  ltpCe: number | null;
  ltpPe: number | null;
  cePosition: PosRow | null;
  pePosition: PosRow | null;
  /** Realised + unrealised across the legs this row's Side trades, apportioned
   *  to this row's share of a netted broker position. */
  pnl: number;
  /** Combined entry premium for those same legs, off the position's own avg. */
  entryPremium: number;
  /** Session VWAP of the combined premium; null until fetched, or if VW is off. */
  vwap: number | null;
  /** Combined premium of the last CLOSED candle at the row's chosen VW
   *  interval — what the VW rule actually compares against VWAP, so a live
   *  tick spike can't trigger the exit on its own. Null until fetched, or if
   *  VW is off. */
  vwapClose: number | null;
  /** Display-only OI-buildup label ('LB'|'SB'|'SC'|'LU'|null) and OI change %
   *  per leg, straight off focus_tool_ws.py — the rule engine does not read
   *  these (no exit rule reacts to OI), so they carry no test-fixture weight
   *  in focusToolRules.cases.json. */
  ceBuildup: string | null;
  peBuildup: string | null;
  ceOiChgPct: number | null;
  peOiChgPct: number | null;
  /** Absolute open interest at the row's pinned/resolved CE and PE strikes
   *  (display-only; feeds the OI PCR chip next to premium Val PCR). */
  ceOi: number | null;
  peOi: number | null;
  /** Session VWAP of the combined premium at a FIXED 1-minute interval —
   *  shown under the LTP regardless of the row's own VW exit-rule setting.
   *  Independent of `vwap`/`vwapClose` above, which follow the row's own
   *  configured VW-rule interval and stay null unless `levelVw` is on. Null
   *  until fetched. */
  vwap1m: number | null;
  vwapClose1m: number | null;
}

export const EMPTY_ROW_LIVE: RowLive = {
  ceStrike: null, peStrike: null, ltpCe: null, ltpPe: null,
  cePosition: null, pePosition: null, pnl: 0, entryPremium: 0, vwap: null, vwapClose: null,
  ceBuildup: null, peBuildup: null, ceOiChgPct: null, peOiChgPct: null,
  ceOi: null, peOi: null, vwap1m: null, vwapClose1m: null,
};

// ── Legs ─────────────────────────────────────────────────────────────────────

/** Legs this row trades. `side` selects which; it is not a direction — this
 *  tool always opens with a SELL. */
export function legsOf(row: Pick<FocusRow, 'side'>): ('CE' | 'PE')[] {
  return row.side === 'BOTH' ? ['CE', 'PE'] : [row.side as 'CE' | 'PE'];
}

/** True once neither leg carries a broker quantity — safe to delete the row. */
export function legsFlat(live: RowLive): boolean {
  return Number(live.cePosition?.netQty ?? 0) === 0
    && Number(live.pePosition?.netQty ?? 0) === 0;
}

/**
 * Whether THIS row opened `leg` — fill ledger, or the worker's open pin.
 *
 * A coincidental broker position at the same strike (another row, another
 * strategy, a leftover from a previous session) is not ownership. Strike
 * config must stay editable on a draft ATM row that merely happens to resolve
 * onto someone else's 24150 PE; locking that selector (or rolling it with the
 * chevrons) would freeze or flatten a position this row never opened.
 */
export type WorkerHold = {
  open?: boolean;
  ceStrike?: number | null;
  peStrike?: number | null;
  /** Absolute contracts this worker still holds on each leg — used to qty-weight
   *  pair SL × when the page fill ledger is empty. */
  ceQty?: number;
  peQty?: number;
} | null | undefined;

export function rowOwnsLeg(
  row: Pick<FocusRow, 'fill'>,
  leg: 'CE' | 'PE',
  workerHold?: WorkerHold,
): boolean {
  const qty = leg === 'CE' ? Number(row.fill?.ceQty) || 0 : Number(row.fill?.peQty) || 0;
  if (qty > 0) return true;
  if (!workerHold?.open) return false;
  const strike = leg === 'CE' ? workerHold.ceStrike : workerHold.peStrike;
  return strike != null;
}

/**
 * True when this row owns neither leg — i.e. every broker position at its
 * resolved strikes belongs to something else (a manual trade, another row, a
 * running strategy). Replaces raw `legsFlat` wherever the real question is
 * "does THIS row hold anything," not "is the broker flat at this strike."
 */
export function rowFlat(row: Pick<FocusRow, 'fill'>, workerHold?: WorkerHold): boolean {
  return !rowOwnsLeg(row, 'CE', workerHold) && !rowOwnsLeg(row, 'PE', workerHold);
}

/**
 * Absolute contracts THIS row owns on a leg, for qty-weighting pair SL ×.
 * Prefers the page fill ledger, then the worker ledger, then falls back to the
 * broker net (only when ownership is already established). 0 when flat / not owned.
 */
export function legOwnContracts(
  row: Pick<FocusRow, 'fill'>,
  leg: 'CE' | 'PE',
  live: RowLive,
  workerHold?: WorkerHold,
): number {
  if (!rowOwnsLeg(row, leg, workerHold)) return 0;
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  const net = Math.abs(Number(pos?.netQty) || 0);
  if (net === 0) return 0;
  const pageOwn = Math.abs(Number(leg === 'CE' ? row.fill?.ceQty : row.fill?.peQty) || 0);
  const workerOwn = Math.abs(Number(leg === 'CE' ? workerHold?.ceQty : workerHold?.peQty) || 0);
  const own = pageOwn > 0 ? pageOwn : workerOwn > 0 ? workerOwn : net;
  return Math.min(own, net);
}

/**
 * Qty-weighted average premium across only the legs this row's Side trades AND
 * that are still actually open.
 *
 * Weighting by this row's own contracts (not a bare CE+PE sum) matters when the
 * legs have different sizes — a 7-lot PE and a 5-lot CE must not be treated as a
 * 1-lot straddle for pair SL ×. Equal lots are algebraically identical to the
 * old unweighted sum for the `premium >= entry × mult` comparison.
 *
 * A leg the Side names but that has already been closed — by a leg-wise stop, a
 * manual Exit, anything — must not keep contributing its market LTP: the pair
 * rules would then be measured against a phantom leg with no position behind
 * it, and would cross their threshold at the wrong number.
 */
export function sidePremium(
  row: Pick<FocusRow, 'side' | 'fill'>,
  live: RowLive,
  workerHold?: WorkerHold,
): number {
  let num = 0;
  let den = 0;
  for (const leg of legsOf(row)) {
    const qty = legOwnContracts(row, leg, live, workerHold);
    if (qty <= 0) continue;
    num += ((leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0) * qty;
    den += qty;
  }
  return den > 0 ? num / den : 0;
}

/**
 * Qty-weighted average entry premium across open owned legs — the denominator
 * for pair SL ×. Same weighting as sidePremium.
 */
export function entryPremiumWeighted(
  legs: { premium: number; qty: number }[],
): number {
  let num = 0;
  let den = 0;
  for (const { premium, qty } of legs) {
    const q = Math.abs(Number(qty) || 0);
    const p = Number(premium) || 0;
    if (q <= 0 || !(p > 0)) continue;
    num += p * q;
    den += q;
  }
  return den > 0 ? num / den : 0;
}

/**
 * This leg's own SL × breach, or null.
 *
 * Independent of the pair's slMultiplier/slRupees, and independent of
 * `row.side` — a leftover position on a leg the row no longer trades still
 * deserves its own stop. Only fires while that leg actually holds something; a
 * flat leg has no premium to measure a multiple against.
 */
export function legStopReason(
  row: Pick<FocusRow, 'ceSlMultiplier' | 'peSlMultiplier' | 'fill'>,
  leg: 'CE' | 'PE',
  live: RowLive,
  workerHold?: WorkerHold,
): string | null {
  if (!rowOwnsLeg(row, leg, workerHold)) return null;
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  const qty = Number(pos?.netQty ?? 0);
  if (qty === 0) return null;
  const mult = Number(leg === 'CE' ? row.ceSlMultiplier : row.peSlMultiplier);
  if (!(mult > 1)) return null;
  // Short: hurt by this leg's own premium expanding through a multiple of what
  // it was sold for (this tool only ever opens with a SELL).
  const entry = qty < 0 ? Number(pos?.sellAvg) || 0 : Number(pos?.buyAvg) || 0;
  const now = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  if (entry > 0 && now > 0 && now >= entry * mult) {
    return `${leg} SL ×${mult} hit (premium ${now.toFixed(2)} vs entry ${entry.toFixed(2)})`;
  }
  return null;
}

/**
 * Premium level a stop-multiple fires at: entry × multiplier.
 * Null when the multiple is off (blank / ≤1) or there is no entry to scale.
 * Display-only — evaluateRowExit / legStopReason remain the authority on
 * whether a stop actually fires.
 */
export function stopPremium(
  entry: number,
  multiplier: string | number | null | undefined,
): number | null {
  const m = Number(multiplier);
  const e = Number(entry);
  if (!(m > 1) || !(e > 0) || !Number.isFinite(m) || !Number.isFinite(e)) return null;
  return e * m;
}

function previewCombinedPremium(row: Pick<FocusRow, 'side'>, live: RowLive): number {
  let num = 0;
  let den = 0;
  for (const leg of legsOf(row)) {
    const p = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
    // Flat preview: equal weight per named leg (no position sizes yet).
    num += p;
    den += 1;
  }
  return den > 0 ? num / den : 0;
}

/** This leg's SL × level. Uses sell/buy avg while owned and open, else live LTP (preview). */
export function legStopPremium(
  row: Pick<FocusRow, 'ceSlMultiplier' | 'peSlMultiplier' | 'fill'>,
  leg: 'CE' | 'PE',
  live: RowLive,
  workerHold?: WorkerHold,
): number | null {
  const pos = leg === 'CE' ? live.cePosition : live.pePosition;
  const qty = Number(pos?.netQty ?? 0);
  const ltp = (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  const owned = rowOwnsLeg(row, leg, workerHold) && qty !== 0;
  const entry = owned
    ? (qty < 0 ? Number(pos?.sellAvg) || 0 : Number(pos?.buyAvg) || 0)
    : ltp;
  return stopPremium(entry, leg === 'CE' ? row.ceSlMultiplier : row.peSlMultiplier);
}

/** Pair SL × level. Uses qty-weighted entry premium while open, else equal-weight live LTP. */
export function pairStopPremium(
  row: Pick<FocusRow, 'slMultiplier' | 'side' | 'fill'>,
  live: RowLive,
  workerHold?: WorkerHold,
): number | null {
  let entry = live.entryPremium;
  if (!(entry > 0)) {
    // Recompute from live legs when entryPremium has not been stamped yet.
    const legs: { premium: number; qty: number }[] = [];
    for (const leg of legsOf(row)) {
      const qty = legOwnContracts(row, leg, live, workerHold);
      const pos = leg === 'CE' ? live.cePosition : live.pePosition;
      const q = Number(pos?.netQty) || 0;
      const avg = q < 0 ? Number(pos?.sellAvg) || 0 : Number(pos?.buyAvg) || 0;
      if (qty > 0 && avg > 0) legs.push({ premium: avg, qty });
    }
    entry = entryPremiumWeighted(legs);
  }
  if (!(entry > 0)) entry = previewCombinedPremium(row, live);
  return stopPremium(entry, row.slMultiplier);
}

// ── DTE ──────────────────────────────────────────────────────────────────────

/**
 * Whole calendar days from `today` to `expiry`, both 'YYYY-MM-DD'. 0 means
 * expiry is today, negative means lapsed, null means unparseable.
 *
 * Compared as UTC midnights so a timezone-offset host cannot shift the count
 * by a day.
 */
export function dteForExpiry(expiry: string, today: string): number | null {
  if (!expiry || !today) return null;
  const ms = Date.parse(`${expiry}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(ms) ? Math.round(ms / 86_400_000) : null;
}

/** Does a resolved DTE satisfy the row's DTE chip? */
export function dteMatches(filter: FocusDte, dte: number | null): boolean {
  if (filter === 'Any') return true;
  if (dte == null) return false;
  if (filter === '0') return dte === 0;
  if (filter === '1') return dte === 1;
  return dte === 0 || dte === 1;   // '0+1'
}

// ── Exit ─────────────────────────────────────────────────────────────────────

/**
 * The first level-exit rule this row breaches, or null.
 *
 * Checked in this order — H↑, L↓, VW, SL ₹, SL × — matching evaluate_exit in
 * focus_tool_rows_worker.py. Order matters because the reason is what gets
 * logged and shown, and a row breaching two rules on one tick should report the
 * more fundamental one.
 *
 * Every spot-derived rule is suppressed when `spot <= 0`. A failed quote read
 * arrives as 0, and 0 is below every conceivable L↓ — treating that as a breach
 * would flatten the whole book on one dropped tick. Premium-driven rules are
 * likewise suppressed at 0.
 *
 * Does NOT cover the group's Book Exit, the row's exit time or the 15:17 bell:
 * those are clock- and aggregate-driven and live in the scheduler, which keeps
 * firing even when no tick arrives.
 */
export function evaluateRowExit(
  row: FocusRow,
  live: RowLive,
  spot: number,
  workerHold?: WorkerHold,
): string | null {
  const hi = Number(row.levelHigh);
  if (row.levelHigh && Number.isFinite(hi) && spot > 0 && spot >= hi) {
    return `H↑ breached: spot ${spot.toFixed(2)} ≥ ${hi}`;
  }
  const lo = Number(row.levelLow);
  if (row.levelLow && Number.isFinite(lo) && spot > 0 && spot <= lo) {
    return `L↓ breached: spot ${spot.toFixed(2)} ≤ ${lo}`;
  }

  // Premium of only the legs this row's Side trades AND actually owns.
  // `entryPremium` is restricted the same way, so a CE-only row never
  // compares a CE entry price against a CE+PE current price, and a leg this
  // row doesn't own never contributes its premium either.
  const nowPremium = sidePremium(row, live, workerHold);

  if (row.levelVw && live.vwapClose != null && live.vwapClose > 0 && live.vwap != null && live.vwap > 0) {
    // Checked against the last CLOSED candle's premium, not the live tick —
    // a spurious wick shouldn't fire a real exit. bufferPct additionally
    // requires the close to clear VWAP by more than a % margin before it
    // counts as a breach; blank/0 means no buffer. This tool only ever opens
    // with a SELL — hurt by the premium expanding past VWAP, same as
    // slMultiplier below.
    const bufferPct = Number(row.vwapBufferPct) || 0;
    const threshold = live.vwap * (1 + bufferPct / 100);
    if (live.vwapClose >= threshold) {
      return `VW breached: closed premium ${live.vwapClose.toFixed(2)} ≥ VWAP+buffer ${threshold.toFixed(2)}`;
    }
  }

  const slRs = Number(row.slRupees);
  if (row.slRupees && Number.isFinite(slRs) && slRs > 0 && live.pnl <= -slRs) {
    return `SL ₹${slRs} hit (P&L ₹${live.pnl.toFixed(0)})`;
  }

  const slMult = Number(row.slMultiplier);
  if (row.slMultiplier && Number.isFinite(slMult) && slMult > 1) {
    const entry = live.entryPremium;
    if (entry > 0 && nowPremium > 0 && nowPremium >= entry * slMult) {
      return `SL ×${slMult} hit (premium ${nowPremium.toFixed(2)} vs entry ${entry.toFixed(2)})`;
    }
  }
  return null;
}

// ── Entry ────────────────────────────────────────────────────────────────────

export interface EntryContext {
  /** Wall-clock 'HH:MM' IST. */
  nowHm: string;
  /** The index group's Start control. */
  groupEnabled: boolean;
  product: 'INTRADAY' | 'MARGIN';
  /** Resolved DTE of the expiry this row would trade; null when unknown. */
  dte: number | null;
  /** At least one leg's strike has resolved. */
  strikesReady: boolean;
  /** The row currently holds nothing. */
  flat: boolean;
}

export interface EntryDecision { enter: boolean; reason: string }

/**
 * Should an armed row open now?
 *
 * A draft row never enters — that is the whole point of Arm, and it is the one
 * invariant worth restating: an unfinished row on screen must not be able to
 * place an order.
 *
 * The order of these checks is part of the contract, not an implementation
 * detail: `reason` is what gets logged and shown, and the Python side reports
 * the same reason for the same row.
 */
export function evaluateEntry(
  row: Pick<FocusRow, 'status' | 'lots' | 'dte' | 'entryTime' | 'exitTime'>,
  ctx: EntryContext,
): EntryDecision {
  if (!ctx.groupEnabled) return { enter: false, reason: 'index not started' };
  if (row.status !== ('armed' as FocusRowStatus)) return { enter: false, reason: `status ${row.status}` };
  if (!(Number(row.lots) > 0)) return { enter: false, reason: 'lots must be > 0' };
  if (!ctx.flat) return { enter: false, reason: 'already holds a position' };
  if (!ctx.strikesReady) return { enter: false, reason: 'strikes unresolved' };
  if (!dteMatches(row.dte, ctx.dte)) return { enter: false, reason: `DTE ${ctx.dte} != ${row.dte}` };

  if (!row.entryTime) return { enter: false, reason: 'no entry time' };
  if (ctx.nowHm < row.entryTime) return { enter: false, reason: `waiting for ${row.entryTime}` };

  // Never open into a window that has already closed — a row armed after its
  // own exit time (or after the bell) would be flattened on the next tick, for
  // nothing but two lots of slippage.
  if (row.exitTime && ctx.nowHm >= row.exitTime) {
    return { enter: false, reason: `past its own exit time ${row.exitTime}` };
  }
  if (ctx.product === 'INTRADAY' && ctx.nowHm >= INTRADAY_BACKSTOP_HM) {
    return { enter: false, reason: 'past 15:17 intraday cutoff' };
  }
  return { enter: true, reason: `entry time ${row.entryTime} reached` };
}

// ── Account budget ───────────────────────────────────────────────────────────

export type TrailState = 'INACTIVE' | 'DORMANT' | 'ARMED';

export interface RiskConfig {
  riskEnabled: boolean;
  targetRupees: string;
  stopRupees: string;
  trailEnabled: boolean;
  triggerRupees: string;
  lockRupees: string;
}

export interface GlobalRiskContext {
  /** P&L across this tool's own rows — NOT the whole account. */
  totalPnl: number;
  /** Highest totalPnl seen this session. */
  peakPnl: number;
  /** The ratcheted floor carried from the previous tick, or null. */
  lockFloor: number | null;
}

export interface GlobalRiskDecision {
  exitAll: boolean;
  reason: string;
  /** The floor to carry into the next tick. */
  lockFloor: number | null;
  trailState: TrailState;
}

/** A config number that arrives as a UI string. '' means "rule off", never 0. */
function num(v: string | number | null | undefined): number | null {
  const s = String(v ?? '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * The account-level budget: TARGET ₹ / STOP ₹ and the trailing lock.
 *
 * The trail is dormant until P&L clears TRIGGER, then a floor that ratchets up
 * with every new peak and never moves down. TRIGGER is the hysteresis —
 * without it the floor would arm on the first rupee of profit and fire on the
 * next down-tick.
 *
 * Returns the floor to carry rather than mutating, so a restart mid-session
 * resumes from what was last recorded instead of silently re-arming.
 */
export function evaluateGlobalRisk(cfg: RiskConfig, ctx: GlobalRiskContext): GlobalRiskDecision {
  let lockFloor = ctx.lockFloor;
  const trailState: { v: TrailState } = { v: 'INACTIVE' };

  if (cfg.riskEnabled) {
    const target = num(cfg.targetRupees);
    const stop = num(cfg.stopRupees);
    if (target != null && target > 0 && ctx.totalPnl >= target) {
      return { exitAll: true, reason: `Target ₹${target.toFixed(0)} reached (₹${ctx.totalPnl.toFixed(0)})`, lockFloor, trailState: trailState.v };
    }
    // STOP is stored as a positive magnitude; the UI labels it a loss limit.
    if (stop != null && stop > 0 && ctx.totalPnl <= -stop) {
      return { exitAll: true, reason: `Stop ₹${stop.toFixed(0)} hit (₹${ctx.totalPnl.toFixed(0)})`, lockFloor, trailState: trailState.v };
    }
  }

  const trigger = num(cfg.triggerRupees);
  if (cfg.trailEnabled && trigger != null && trigger > 0) {
    const gap = Math.max(num(cfg.lockRupees) ?? 0, 0);

    if (lockFloor === null) {
      if (ctx.totalPnl >= trigger) {
        lockFloor = trigger - gap;
        trailState.v = 'ARMED';
      } else {
        trailState.v = 'DORMANT';
      }
    } else {
      trailState.v = 'ARMED';
      // Ratchet on the running peak, not the current tick: a spike that has
      // already faded still counts, and the floor can only ever rise.
      const ratchet = ctx.peakPnl - gap;
      if (ratchet > lockFloor) lockFloor = ratchet;
      if (ctx.totalPnl <= lockFloor) {
        return {
          exitAll: true,
          reason: `Trail lock ₹${lockFloor.toFixed(0)} hit (₹${ctx.totalPnl.toFixed(0)}, peak ₹${ctx.peakPnl.toFixed(0)})`,
          lockFloor,
          trailState: trailState.v,
        };
      }
    }
  }

  return { exitAll: false, reason: '', lockFloor, trailState: trailState.v };
}
