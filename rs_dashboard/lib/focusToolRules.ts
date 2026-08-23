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
}

export const EMPTY_ROW_LIVE: RowLive = {
  ceStrike: null, peStrike: null, ltpCe: null, ltpPe: null,
  cePosition: null, pePosition: null, pnl: 0, entryPremium: 0, vwap: null,
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
 * Current premium across only the legs this row's Side trades AND that are
 * still actually open.
 *
 * A leg the Side names but that has already been closed — by a leg-wise stop, a
 * manual Exit, anything — must not keep contributing its market LTP: the pair
 * rules would then be measured against a phantom leg with no position behind
 * it, and would cross their threshold at the wrong number.
 */
export function sidePremium(row: Pick<FocusRow, 'side'>, live: RowLive): number {
  let sum = 0;
  for (const leg of legsOf(row)) {
    const pos = leg === 'CE' ? live.cePosition : live.pePosition;
    if (!pos || Number(pos.netQty) === 0) continue;
    sum += (leg === 'CE' ? live.ltpCe : live.ltpPe) ?? 0;
  }
  return sum;
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
  row: Pick<FocusRow, 'ceSlMultiplier' | 'peSlMultiplier'>,
  leg: 'CE' | 'PE',
  live: RowLive,
): string | null {
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
export function evaluateRowExit(row: FocusRow, live: RowLive, spot: number): string | null {
  const hi = Number(row.levelHigh);
  if (row.levelHigh && Number.isFinite(hi) && spot > 0 && spot >= hi) {
    return `H↑ breached: spot ${spot.toFixed(2)} ≥ ${hi}`;
  }
  const lo = Number(row.levelLow);
  if (row.levelLow && Number.isFinite(lo) && spot > 0 && spot <= lo) {
    return `L↓ breached: spot ${spot.toFixed(2)} ≤ ${lo}`;
  }

  // Premium of only the legs this row's Side trades. `entryPremium` is
  // restricted the same way, so a CE-only row never compares a CE entry price
  // against a CE+PE current price.
  const nowPremium = sidePremium(row, live);

  if (row.levelVw && live.vwap != null && live.vwap > 0) {
    // This tool only ever opens with a SELL — hurt by the premium expanding
    // past VWAP, same as slMultiplier below.
    if (nowPremium > 0 && nowPremium >= live.vwap) {
      return `VW breached: premium ${nowPremium.toFixed(2)} ≥ VWAP ${live.vwap.toFixed(2)}`;
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
