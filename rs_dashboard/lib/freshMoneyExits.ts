/**
 * Fresh Money board — per-position target and stop-loss (pure, no I/O). REAL MONEY: the dashboard-server watcher
 * (lib/freshMoneyExitServer.ts) sends a MARKET close when one of these levels is hit.
 * Spec: docs/superpowers/specs/2026-11-11-fresh-money-target-sl-design.md.
 *
 * A level is a number in percent of the position's average fill price or in option premium points. Once the opening fill
 * is priced, the levels are fixed PRICES: adding lots does not move them. A level that works out at or below zero is off,
 * never a price.
 */

import { buildPositions, unconfirmedQty, type FmOrder, type FmPosition, type TxnSide } from './freshMoneyTrades.ts';

export type ExitUnit = 'pct' | 'pts';
export interface ExitSpec { value: number; unit: ExitUnit }
export type ExitDir = 'long' | 'short';
export interface ExitLevels { targetPx: number | null; slPx: number | null }

export const EXIT_MAX_PCT = 1000;
export const EXIT_MAX_PTS = 100_000;

/** A level as sent by the page: null / blank value = off; anything else must be a valid spec. */
export function validateExitSpec(raw: unknown): ExitSpec | null | { error: string } {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') return { error: 'A level must be { value, unit }' };
  const { value, unit } = raw as { value?: unknown; unit?: unknown };
  if (value === null || value === undefined || value === '') return null;
  if (unit !== 'pct' && unit !== 'pts') return { error: 'Unit must be % or pts' };
  const v = typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(v) || v <= 0) return { error: 'A level must be a number above 0' };
  if (unit === 'pct' && v > EXIT_MAX_PCT) return { error: `At most ${EXIT_MAX_PCT}%` };
  if (unit === 'pts' && v > EXIT_MAX_PTS) return { error: `At most ${EXIT_MAX_PTS.toLocaleString('en-IN')} pts` };
  return { value: v, unit };
}

/** What was typed in a level box: blank = off; anything else is validated exactly as typed (never rewritten, so "-5"
 *  or "1e9" is refused rather than read as 5 or 19). */
export function parseExitDraft(raw: string, unit: ExitUnit): ExitSpec | null | { error: string } {
  const t = raw.trim();
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return { error: 'Type a number above 0 (or leave blank for off)' };
  return validateExitSpec({ value: Number(t), unit });
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** How far a spec moves from the basis, in premium points. */
const offset = (basis: number, s: ExitSpec) => (s.unit === 'pct' ? (basis * s.value) / 100 : s.value);

/** Target and SL prices from the basis. Long: target above, SL below; short: mirrored. <= 0 = off (null). */
export function levelsFor(basis: number, dir: ExitDir, target: ExitSpec | null, sl: ExitSpec | null): ExitLevels {
  const sign = dir === 'long' ? 1 : -1;
  const at = (s: ExitSpec | null, towards: 1 | -1) => {
    if (!s) return null;
    const px = round2(basis + towards * sign * offset(basis, s));
    return px > 0 ? px : null;
  };
  return { targetPx: at(target, 1), slPx: at(sl, -1) };
}

/** Which level the price has reached, if any. If both somehow hold, the stop-loss wins. */
export function breached(ltp: number, dir: ExitDir, lv: ExitLevels): 'target' | 'sl' | null {
  const long = dir === 'long';
  if (lv.slPx !== null && (long ? ltp <= lv.slPx : ltp >= lv.slPx)) return 'sl';
  if (lv.targetPx !== null && (long ? ltp >= lv.targetPx : ltp <= lv.targetPx)) return 'target';
  return null;
}

/** The − / + buttons: ±1 in the current unit. + from off = 1; − from 1 (or below) = off; capped at the unit's limit. */
export function stepExitSpec(cur: ExitSpec | null, unit: ExitUnit, dir: 1 | -1): ExitSpec | null {
  if (!cur) return dir > 0 ? { value: 1, unit } : null;
  const max = unit === 'pct' ? EXIT_MAX_PCT : EXIT_MAX_PTS;
  const v = Math.round((cur.value + dir) * 100) / 100;
  if (v < 1) return null;
  return { value: Math.min(max, v), unit };
}

export function fmtExitSpec(s: ExitSpec | null): string {
  if (!s) return 'off';
  return s.unit === 'pct' ? `${s.value}%` : `${s.value} pts`;
}

// ── the per-position record and the watcher's per-tick decision ──────────────────────────────────────────────────────

/** waiting-fill = stamped, the opening fill is not priced yet; watching = levels are prices, checked every tick;
 *  firing = the close is being sent (at most once); sent = the close went out; unknown = it may or may not be live
 *  (never resent); incomplete = the close settled but part of the position is still open (not watched); rejected = the
 *  broker refused the close (not retried: a rejection repeats — edit to re-arm). */
export type ExitState = 'waiting-fill' | 'watching' | 'firing' | 'sent' | 'unknown' | 'incomplete' | 'rejected';

export interface FmExit {
  /** Position key `broker|contract` (lib/freshMoneyTrades.ts orderKey). */
  key: string;
  /** ts of the order that stamped it. */
  openedAt: number;
  dir: ExitDir;
  target: ExitSpec | null;
  sl: ExitSpec | null;
  basis: number | null;
  targetPx: number | null;
  slPx: number | null;
  state: ExitState;
  firedBy?: 'target' | 'sl';
  firedAt?: number;
  /** A refused exit (nothing sent) is not retried before this. */
  retryAt?: number;
  note?: string;
}

/** Consecutive breaching ticks of one level (kept in the watcher's memory). */
export interface Streak { level: 'target' | 'sl'; count: number; at: number }

/** What the shared close path did. refused = stopped by this page's own checks, nothing sent (hold, session, gate);
 *  rejected = the broker refused the order; partial = some slices went out, the rest was not. */
export type CloseResult =
  | { kind: 'placed'; orderId: string; note?: string }
  | { kind: 'refused'; error: string; http: number }
  | { kind: 'rejected'; error: string; http: number }
  | { kind: 'unknown'; error: string; partial: boolean }
  | { kind: 'partial'; error: string };

export type ExitAction =
  | { kind: 'none' }
  | { kind: 'drop' }
  | { kind: 'resolve'; basis: number; levels: ExitLevels }
  | { kind: 'streak'; streak: Streak | null }
  | { kind: 'fire'; level: 'target' | 'sl' }
  | { kind: 'settle'; to: 'drop' | 'incomplete' }
  | { kind: 'mark-unknown'; note: string };

export const CONFIRM_TICKS = 2;
export const STREAK_MAX_GAP_MS = 6000;
export const FIRING_STALE_MS = 60_000;
export const REFUSED_RETRY_MS = 5000;

const NONE: ExitAction = { kind: 'none' };
const RESET: ExitAction = { kind: 'streak', streak: null };

/**
 * One record's next step. `pos` = this page's position on the key (null = none), `settling` = the contract has an
 * order in flight or placed in the last 20 s (lib/freshMoneyTrades.ts contractSettling), `ltp` = a usable price or null.
 */
export function nextExitAction(
  x: FmExit, pos: { netQty: number; avgPrice: number | null } | null, settling: boolean, ltp: number | null,
  streak: Streak | null, now: number,
): ExitAction {
  if (x.state === 'firing') {
    return now - (x.firedAt ?? 0) > FIRING_STALE_MS
      ? { kind: 'mark-unknown', note: 'exit UNKNOWN — check the broker: the dashboard stopped while the exit was being sent' }
      : NONE;
  }
  const open = !!pos && pos.netQty !== 0 && Math.sign(pos.netQty) === (x.dir === 'long' ? 1 : -1);
  if (x.state === 'sent') {
    if (settling) return NONE;
    return { kind: 'settle', to: open ? 'incomplete' : 'drop' };
  }
  if (!open) return settling ? NONE : { kind: 'drop' };
  if (x.state === 'waiting-fill') {
    if (pos!.avgPrice === null) return NONE;
    return { kind: 'resolve', basis: pos!.avgPrice, levels: levelsFor(pos!.avgPrice, x.dir, x.target, x.sl) };
  }
  if (x.state !== 'watching') return NONE;
  if (ltp === null || (x.retryAt !== undefined && now < x.retryAt)) return RESET;
  const level = breached(ltp, x.dir, { targetPx: x.targetPx, slPx: x.slPx });
  if (!level) return RESET;
  const count = streak && streak.level === level && now - streak.at <= STREAK_MAX_GAP_MS ? streak.count + 1 : 1;
  return count >= CONFIRM_TICKS ? { kind: 'fire', level } : { kind: 'streak', streak: { level, count, at: now } };
}

/** The record's new fields once the close has answered. */
export function exitAfterClose(r: CloseResult, level: 'target' | 'sl', now: number): Partial<FmExit> {
  if (r.kind === 'placed') return { state: 'sent', firedBy: level, firedAt: now };
  if (r.kind === 'refused') return { state: 'watching', note: r.error, retryAt: now + REFUSED_RETRY_MS, firedBy: undefined, firedAt: undefined };
  if (r.kind === 'rejected') return { state: 'rejected', note: `exit REJECTED by the broker: ${r.error} — edit to re-arm`, firedBy: level, firedAt: now };
  return { state: 'unknown', note: `exit UNKNOWN — check the broker: ${r.error}` };
}

// ── stamping on entry, editing per position ──────────────────────────────────────────────────────────────────────

export interface ExitDefaults { target: ExitSpec | null; sl: ExitSpec | null }

/** The header defaults an order carries (`exitDefaults`). Absent = both off; any invalid level refuses the order. */
export function parseExitDefaults(raw: unknown): ExitDefaults | { error: string } {
  if (raw === null || raw === undefined) return { target: null, sl: null };
  if (typeof raw !== 'object') return { error: 'exitDefaults must be { target, sl }' };
  const r = raw as { target?: unknown; sl?: unknown };
  const target = validateExitSpec(r.target);
  if (target && 'error' in target) return { error: `Target: ${target.error}` };
  const sl = validateExitSpec(r.sl);
  if (sl && 'error' in sl) return { error: `Stop-loss: ${sl.error}` };
  return { target, sl };
}

/** The record an opening order stamps: only when the contract is flat with nothing unconfirmed (adding lots keeps the
 *  position's levels) and at least one level is set. */
export function stampExit(orders: FmOrder[], key: string, side: TxnSide, now: number, d: ExitDefaults): FmExit | null {
  if (!d.target && !d.sl) return null;
  const held = buildPositions(orders, {}, now).find(p => p.key === key)?.netQty ?? 0;
  if (held !== 0 || unconfirmedQty(orders, key, now) !== 0) return null;
  return {
    key, openedAt: now, dir: side === 'BUY' ? 'long' : 'short', target: d.target, sl: d.sl,
    basis: null, targetPx: null, slPx: null, state: 'waiting-fill',
  };
}

/**
 * The exit records after an opening order is recorded. On a flat contract with nothing unconfirmed this is a NEW
 * position: any leftover record (from a position closed less than 20 s ago, before the watcher dropped it) is replaced
 * by the header's stamp, or removed when the header is blank — old prices from an old basis must never guard it.
 * Adding to an open position returns `exits` unchanged (the same object).
 */
export function exitsOnOpen(
  exits: Record<string, FmExit> | undefined, orders: FmOrder[], key: string, side: TxnSide, now: number, d: ExitDefaults,
): Record<string, FmExit> {
  const cur = exits ?? {};
  const held = buildPositions(orders, {}, now).find(p => p.key === key)?.netQty ?? 0;
  if (held !== 0 || unconfirmedQty(orders, key, now) !== 0) return cur;
  const next = { ...cur };
  delete next[key];
  const x = stampExit(orders, key, side, now, d);
  if (x) next[key] = x;
  return next;
}

/** A per-position edit from the Positions panel. Levels come from the position's CURRENT average; both null = remove. */
export function editExit(
  x: FmExit | undefined, pos: FmPosition, target: ExitSpec | null, sl: ExitSpec | null, now: number,
): FmExit | null | { error: string } {
  if (x?.state === 'firing') return { error: 'An exit for this position is being sent right now — try again in a moment' };
  if (pos.netQty === 0) return { error: 'This position is flat' };
  if (!target && !sl) return null;
  const dir: ExitDir = pos.netQty > 0 ? 'long' : 'short';
  const base: FmExit = { key: pos.key, openedAt: x?.openedAt ?? now, dir, target, sl, basis: null, targetPx: null, slPx: null, state: 'waiting-fill' };
  if (pos.avgPrice === null) return base;
  return { ...base, basis: pos.avgPrice, ...levelsFor(pos.avgPrice, dir, target, sl), state: 'watching' };
}

/** "T 30% · SL 20 pts" for a toast; '' when both are off. */
export function exitSummary(d: ExitDefaults): string {
  const parts = [d.target ? `T ${fmtExitSpec(d.target)}` : null, d.sl ? `SL ${fmtExitSpec(d.sl)}` : null].filter(Boolean);
  return parts.join(' · ');
}
