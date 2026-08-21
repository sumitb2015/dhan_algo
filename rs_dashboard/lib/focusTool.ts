/**
 * Focus Tool — shared types and the rule engine for the straddles/strangles terminal.
 *
 * Every function here is pure: no fetch, no DOM, no clock. That is deliberate.
 * The same rules decide what the browser previews and what the Python worker
 * actually trades, so they have to be testable in isolation (see
 * focusTool.test.ts) rather than only observable by watching real orders fire.
 *
 * `evaluateExit` and `evaluateGlobalRisk` are ported line-for-line into
 * scripts/tools/focus_tool_worker.py. If you change a rule here, change it
 * there in the same commit — a disagreement between the two means the screen
 * shows one thing and the account does another.
 */

import type { Broker } from '@/hooks/useBrokerSelector';

// ─── Constants ────────────────────────────────────────────────────

export type Underlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';

export const UNDERLYINGS: readonly Underlying[] = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;

/**
 * Default strike ladder spacing. Also duplicated in Scalper.tsx and
 * AdvancedScalper.tsx; this is the copy new code should import. A group can
 * override it (the STRIKES ± control) for a ladder the exchange has rebased.
 */
export const STRIKE_STEP: Record<Underlying, number> = {
  NIFTY: 50,
  BANKNIFTY: 100,
  SENSEX: 100,
};

/**
 * Repo-wide intraday auto-exit, 15:17 IST (see CLAUDE.md — every strategy
 * hardcodes it). The worker force-exits here regardless of row config, and
 * refuses to open anything at or after it: an entry at 15:16 would be flattened
 * a minute later for nothing but two lots of slippage.
 */
export const INTRADAY_EXIT_MINUTES = 15 * 60 + 17;

// ─── Config model ─────────────────────────────────────────────────

export type RowState = 'DRAFT' | 'ARMED' | 'ENTERED' | 'EXITED' | 'ERROR';

export type DteFilter = 'any' | '0' | '1' | '0+1';

export interface LevelExits {
  /** H↑ — exit once the underlying trades at or above this. */
  spotHigh: number | null;
  /** L↓ — exit once the underlying trades at or below this. */
  spotLow: number | null;
  /** VW — exit when the combined premium crosses its session VWAP adversely. */
  vwap: boolean;
  /** SL ₹ — absolute rupee loss on the pair. */
  slRupees: number | null;
  /** SL × — adverse move as a multiple of the combined entry premium. > 1. */
  slMult: number | null;
}

export interface RowFill {
  ceStrike: number;
  peStrike: number;
  ceEntry: number;
  peEntry: number;
  /** Absolute units, already lot-multiplied. Never lots. */
  qty: number;
  ts: string;
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

export interface FocusRow {
  id: string;
  /** "HH:MM" IST. Empty means the row only ever enters by an explicit Arm. */
  entryTime: string;
  exitTime: string;
  dte: DteFilter;
  /** Strike steps away from ATM. 0 = straddle; n = strangle n steps wide each side. */
  offset: number;
  lots: number;
  side: 'SELL' | 'BUY';
  state: RowState;
  exits: LevelExits;
  fill?: RowFill;
  error?: string;
}

export interface FocusGroup {
  underlying: Underlying;
  /** The Stop / ● Started control. A stopped group neither enters nor exits. */
  started: boolean;
  atmBy: 'SPOT' | 'FUT';
  product: 'INTRADAY' | 'MARGIN';
  /** STRIKES ± override; null uses STRIKE_STEP. */
  strikeStep: number | null;
  bookExit: { enabled: boolean; spotHigh: number | null; spotLow: number | null };
  rows: FocusRow[];
}

export interface FocusConfig {
  broker: Broker;
  /** LIVE · REAL MONEY. False means the worker simulates fills and places nothing. */
  live: boolean;
  risk: { enabled: boolean; targetRs: number | null; stopRs: number | null };
  trail: { enabled: boolean; triggerRs: number | null; lockRs: number | null };
  groups: FocusGroup[];
}

// ─── Defaults ─────────────────────────────────────────────────────

export function emptyExits(): LevelExits {
  return { spotHigh: null, spotLow: null, vwap: false, slRupees: null, slMult: null };
}

export function newRow(id: string): FocusRow {
  return {
    id,
    entryTime: '',
    exitTime: '',
    dte: 'any',
    offset: 0,
    lots: 1,
    side: 'SELL',
    state: 'DRAFT',
    exits: emptyExits(),
  };
}

export function newGroup(underlying: Underlying): FocusGroup {
  return {
    underlying,
    started: false,
    atmBy: 'SPOT',
    product: 'INTRADAY',
    strikeStep: null,
    bookExit: { enabled: false, spotHigh: null, spotLow: null },
    rows: [],
  };
}

export function defaultConfig(): FocusConfig {
  return {
    broker: 'dhan',
    live: false,
    risk: { enabled: false, targetRs: null, stopRs: null },
    trail: { enabled: false, triggerRs: null, lockRs: null },
    groups: UNDERLYINGS.map(newGroup),
  };
}

// ─── Time ─────────────────────────────────────────────────────────

/** "HH:MM" -> minutes since midnight, or null for empty/malformed input. */
export function parseHHMM(value: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

// ─── Strikes ──────────────────────────────────────────────────────

/** Mirrors DhanHelper.select_strike: the listed strike nearest to spot. */
export function atmStrike(spot: number, step: number): number {
  if (!(spot > 0) || !(step > 0)) return 0;
  return Math.round(spot / step) * step;
}

/**
 * CE above, PE below. offset 0 is a straddle (both legs at the ATM); offset n
 * is a strangle n steps wide on each side, which is the only shape this
 * terminal builds — so CE strike is always >= PE strike and the inversion the
 * straddle strategies guard against cannot be constructed here.
 */
export function resolveStrikes(atm: number, offset: number, step: number): { ceStrike: number; peStrike: number } {
  const width = Math.abs(Math.trunc(offset)) * step;
  return { ceStrike: atm + width, peStrike: atm - width };
}

// ─── DTE ──────────────────────────────────────────────────────────

/**
 * Calendar days from `today` to `expiry`, both "YYYY-MM-DD". 0 means expiry is
 * today. Negative for a lapsed expiry; null if either date is unparseable.
 *
 * Compared as UTC midnights so a DST-free but timezone-offset host cannot shift
 * the count by a day.
 */
export function dteFor(expiry: string, today: string): number | null {
  const a = Date.parse(`${(expiry ?? '').trim()}T00:00:00Z`);
  const b = Date.parse(`${(today ?? '').trim()}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((a - b) / 86_400_000);
}

/** Does a resolved DTE satisfy the row's DTE chip? Unknown DTE never matches. */
export function dteMatches(filter: DteFilter, dte: number | null): boolean {
  if (dte === null) return false;
  switch (filter) {
    case 'any': return dte >= 0;
    case '0':   return dte === 0;
    case '1':   return dte === 1;
    case '0+1': return dte === 0 || dte === 1;
    default:    return false;
  }
}

// ─── P&L ──────────────────────────────────────────────────────────

/**
 * Mark-to-market on the pair, in rupees.
 *
 * SELL earns the decay (entry minus current), BUY earns the expansion. `qty` is
 * already absolute units, so no lot multiplication happens here.
 */
export function pairPnl(fill: RowFill, ceLtp: number, peLtp: number, side: 'SELL' | 'BUY'): number {
  const entry = fill.ceEntry + fill.peEntry;
  const now = ceLtp + peLtp;
  const move = side === 'SELL' ? entry - now : now - entry;
  return move * fill.qty;
}

/** Combined premium paid/received per unit at entry. */
export function entryCombined(fill: RowFill): number {
  return fill.ceEntry + fill.peEntry;
}

// ─── Exit rules ───────────────────────────────────────────────────

export interface ExitContext {
  /** Minutes since midnight IST. */
  nowMinutes: number;
  /** Underlying last price. <= 0 means "unknown" and suppresses every spot rule. */
  spot: number;
  ceLtp: number;
  peLtp: number;
  /** Session VWAP of the combined premium; null when not yet computable. */
  vwap: number | null;
  bookExit: FocusGroup['bookExit'];
}

export interface ExitDecision {
  exit: boolean;
  reason: string;
}

const NO_EXIT: ExitDecision = { exit: false, reason: '' };

/**
 * The exit ladder for one entered row. First match wins, in this order:
 *
 *   1. the 15:17 intraday bell
 *   2. the group's Book Exit spot level
 *   3. the row's own exit time
 *   4. the row's H↑ / L↓ spot levels
 *   5. VWAP cross
 *   6. SL ₹ / SL ×
 *
 * Order matters because the reason is what gets logged and shown, and a row
 * that breaches two rules on the same tick should report the more fundamental
 * one. Global risk and the trailing lock are evaluated separately and outrank
 * everything here — see evaluateGlobalRisk.
 *
 * Every spot-derived rule is suppressed when `spot <= 0`. A failed quote read
 * arrives as 0, and 0 is below every conceivable L↓ — treating it as a breach
 * would flatten the whole book on a single dropped tick.
 */
export function evaluateExit(row: FocusRow, ctx: ExitContext): ExitDecision {
  if (row.state !== 'ENTERED' || !row.fill) return NO_EXIT;

  if (ctx.nowMinutes >= INTRADAY_EXIT_MINUTES) {
    return { exit: true, reason: 'Intraday auto-exit 15:17' };
  }

  const spotKnown = ctx.spot > 0;

  if (spotKnown && ctx.bookExit?.enabled) {
    const { spotHigh, spotLow } = ctx.bookExit;
    if (spotHigh != null && ctx.spot >= spotHigh) {
      return { exit: true, reason: `Book exit: spot ${ctx.spot} ≥ ${spotHigh}` };
    }
    if (spotLow != null && ctx.spot <= spotLow) {
      return { exit: true, reason: `Book exit: spot ${ctx.spot} ≤ ${spotLow}` };
    }
  }

  const exitAt = parseHHMM(row.exitTime);
  if (exitAt !== null && ctx.nowMinutes >= exitAt) {
    return { exit: true, reason: `Exit time ${row.exitTime}` };
  }

  const { spotHigh, spotLow, vwap, slRupees, slMult } = row.exits;

  if (spotKnown) {
    if (spotHigh != null && ctx.spot >= spotHigh) {
      return { exit: true, reason: `H↑ ${spotHigh} breached (spot ${ctx.spot})` };
    }
    if (spotLow != null && ctx.spot <= spotLow) {
      return { exit: true, reason: `L↓ ${spotLow} breached (spot ${ctx.spot})` };
    }
  }

  const combined = ctx.ceLtp + ctx.peLtp;

  // A short pair is hurt by premium expanding through VWAP, a long pair by it
  // collapsing through VWAP. Guarded on combined > 0 so a pair of missing
  // quotes (0 + 0) cannot read as "collapsed below VWAP" and exit a long.
  if (vwap && ctx.vwap != null && ctx.vwap > 0 && combined > 0) {
    if (row.side === 'SELL' && combined >= ctx.vwap) {
      return { exit: true, reason: `Premium ${combined.toFixed(2)} ≥ VWAP ${ctx.vwap.toFixed(2)}` };
    }
    if (row.side === 'BUY' && combined <= ctx.vwap) {
      return { exit: true, reason: `Premium ${combined.toFixed(2)} ≤ VWAP ${ctx.vwap.toFixed(2)}` };
    }
  }

  if (slRupees != null && slRupees > 0 && combined > 0) {
    const pnl = pairPnl(row.fill, ctx.ceLtp, ctx.peLtp, row.side);
    if (pnl <= -slRupees) {
      return { exit: true, reason: `SL ₹${slRupees} hit (P&L ₹${pnl.toFixed(0)})` };
    }
  }

  // SL × is the rupee stop expressed as a factor of the entry premium, applied
  // symmetrically: a short exits when the premium has multiplied by slMult, a
  // long when it has divided by it. Stated as a ratio rather than as a rupee
  // loss because the rupee form goes negative for a long once slMult > 2.
  if (slMult != null && slMult > 1 && combined > 0) {
    const entry = entryCombined(row.fill);
    if (entry > 0) {
      if (row.side === 'SELL' && combined >= entry * slMult) {
        return { exit: true, reason: `SL ×${slMult}: premium ${combined.toFixed(2)} vs entry ${entry.toFixed(2)}` };
      }
      if (row.side === 'BUY' && combined <= entry / slMult) {
        return { exit: true, reason: `SL ×${slMult}: premium ${combined.toFixed(2)} vs entry ${entry.toFixed(2)}` };
      }
    }
  }

  return NO_EXIT;
}

// ─── Entry rules ──────────────────────────────────────────────────

export interface EntryContext {
  nowMinutes: number;
  /** Resolved DTE of the expiry the group is trading; null when unknown. */
  dte: number | null;
  /** True when the group's Start control is on. */
  groupStarted: boolean;
}

export interface EntryDecision {
  enter: boolean;
  reason: string;
}

/**
 * Should an armed row open now?
 *
 * A DRAFT row never enters — that is the whole point of the Arm button, and it
 * is the one invariant worth restating: an unfinished row on screen must not be
 * able to place an order.
 */
export function evaluateEntry(row: FocusRow, ctx: EntryContext): EntryDecision {
  if (!ctx.groupStarted) return { enter: false, reason: 'group stopped' };
  if (row.state !== 'ARMED') return { enter: false, reason: `state ${row.state}` };
  if (!(row.lots > 0)) return { enter: false, reason: 'lots must be > 0' };
  if (!dteMatches(row.dte, ctx.dte)) return { enter: false, reason: `DTE ${ctx.dte} ≠ ${row.dte}` };

  const entryAt = parseHHMM(row.entryTime);
  if (entryAt === null) return { enter: false, reason: 'no entry time' };
  if (ctx.nowMinutes < entryAt) return { enter: false, reason: `waiting for ${row.entryTime}` };

  if (ctx.nowMinutes >= INTRADAY_EXIT_MINUTES) {
    return { enter: false, reason: 'past 15:17 intraday cutoff' };
  }

  // Entering after the row's own exit time would open a position the exit
  // ladder flattens on the very next tick — two lots of slippage for nothing.
  const exitAt = parseHHMM(row.exitTime);
  if (exitAt !== null && ctx.nowMinutes >= exitAt) {
    return { enter: false, reason: `past its own exit time ${row.exitTime}` };
  }

  return { enter: true, reason: `entry time ${row.entryTime} reached` };
}

// ─── Global risk + trailing lock ──────────────────────────────────

export type TrailState = 'INACTIVE' | 'DORMANT' | 'ARMED';

export interface GlobalRiskContext {
  /** Realised + unrealised across every row this tool owns. */
  totalPnl: number;
  /** Highest totalPnl seen this session. */
  peakPnl: number;
  /** Current ratcheted floor, or null before the trail arms. */
  lockFloor: number | null;
}

export interface GlobalRiskDecision {
  exitAll: boolean;
  reason: string;
  /** The floor to persist for the next tick. Null while dormant. */
  lockFloor: number | null;
  trailState: TrailState;
}

/**
 * Account-level budget: the TARGET ₹ / STOP ₹ pair and the trailing lock.
 *
 * The trail is the ProfitLock state machine (components/ProfitLock.tsx) moved
 * server-side: dormant until P&L clears TRIGGER ₹, then a floor that ratchets
 * up 1:1 with every new peak and never moves down. TRIGGER is the hysteresis —
 * without it the floor would arm on the first rupee of profit and fire on the
 * next down-tick.
 *
 * Returns the floor to persist rather than mutating, so the worker's state is
 * whatever it last wrote and a restart mid-session cannot silently reset it.
 */
export function evaluateGlobalRisk(cfg: FocusConfig, ctx: GlobalRiskContext): GlobalRiskDecision {
  const { risk, trail } = cfg;
  let lockFloor = ctx.lockFloor;
  let trailState: TrailState = 'INACTIVE';

  if (risk.enabled) {
    if (risk.targetRs != null && risk.targetRs > 0 && ctx.totalPnl >= risk.targetRs) {
      return { exitAll: true, reason: `Target ₹${risk.targetRs} reached (₹${ctx.totalPnl.toFixed(0)})`, lockFloor, trailState };
    }
    // STOP is stored as a positive magnitude; the UI labels it a loss limit.
    if (risk.stopRs != null && risk.stopRs > 0 && ctx.totalPnl <= -risk.stopRs) {
      return { exitAll: true, reason: `Stop ₹${risk.stopRs} hit (₹${ctx.totalPnl.toFixed(0)})`, lockFloor, trailState };
    }
  }

  if (trail.enabled && trail.triggerRs != null && trail.triggerRs > 0) {
    const gap = trail.lockRs != null && trail.lockRs > 0 ? trail.lockRs : 0;

    if (lockFloor === null) {
      if (ctx.totalPnl >= trail.triggerRs) {
        lockFloor = trail.triggerRs - gap;
        trailState = 'ARMED';
      } else {
        trailState = 'DORMANT';
      }
    } else {
      trailState = 'ARMED';
      // Ratchet on the running peak, not on the current tick: a spike that has
      // already faded still counts, and the floor can only ever rise.
      const ratchet = ctx.peakPnl - gap;
      if (ratchet > lockFloor) lockFloor = ratchet;

      if (ctx.totalPnl <= lockFloor) {
        return {
          exitAll: true,
          reason: `Trail lock ₹${lockFloor.toFixed(0)} hit (₹${ctx.totalPnl.toFixed(0)}, peak ₹${ctx.peakPnl.toFixed(0)})`,
          lockFloor,
          trailState,
        };
      }
    }
  }

  return { exitAll: false, reason: '', lockFloor, trailState };
}
