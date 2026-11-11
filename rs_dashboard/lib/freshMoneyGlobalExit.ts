/**
 * Fresh Money board — the GLOBAL target / stop-loss (pure, no I/O). REAL MONEY: the dashboard-server watcher
 * (lib/freshMoneyGlobalTick.ts) closes every open position with MARKET orders when the combined P&L of this page's
 * positions reaches the target (profit) or the stop-loss (loss), in rupees.
 *
 * Combined P&L = booked + open P&L over every position in today's ledger (all brokers, all underlyings). If any
 * position's P&L is unknown (a fill or an LTP is missing) or an order is still in flight, the total is UNKNOWN and
 * nothing fires — it never guesses.
 */
import type { CloseResult, Streak } from './freshMoneyExits.ts';
import { CONFIRM_TICKS, STREAK_MAX_GAP_MS } from './freshMoneyExits.ts';
import type { FmPosition } from './freshMoneyTrades.ts';

export const GLOBAL_MAX_RS = 100_000_000;

/** armed = checked every tick; firing = the closes are being sent (at most once); sent = all closes went out;
 *  unknown = a close may or may not be live (never resent); incomplete = some closes went out, the rest did not;
 *  rejected = the broker refused a close (not retried — edit to re-arm). */
export type GlobalState = 'watching' | 'firing' | 'sent' | 'unknown' | 'incomplete' | 'rejected';

export interface FmGlobalExit {
  /** Profit in rupees (> 0) at which everything is closed; null = off. */
  target: number | null;
  /** Loss in rupees (> 0) at which everything is closed (P&L <= -sl); null = off. */
  sl: number | null;
  armedAt: number;
  state: GlobalState;
  firedBy?: 'target' | 'sl';
  firedAt?: number;
  /** A refused exit (nothing sent) is not retried before this. */
  retryAt?: number;
  note?: string;
}

/** An amount as sent by the page: null / blank = off; anything else must be a number above 0. */
export function validateGlobalAmount(raw: unknown): number | null | { error: string } {
  if (raw === null || raw === undefined || raw === '') return null;
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) return { error: 'An amount must be a number above 0' };
  if (raw > GLOBAL_MAX_RS) return { error: `At most ${GLOBAL_MAX_RS.toLocaleString('en-IN')}` };
  return Math.round(raw * 100) / 100;
}

/** What was typed in a box: blank = off; validated exactly as typed (never rewritten: "-5" or "1e9" is refused). */
export function parseGlobalDraft(raw: string): number | null | { error: string } {
  const t = raw.trim().replace(/,/g, '');
  if (t === '') return null;
  if (!/^\d+(\.\d+)?$/.test(t)) return { error: 'Type an amount above 0 (or leave blank for off)' };
  return validateGlobalAmount(Number(t));
}

/** The − / + buttons: ±step rupees. + from off = step; − to zero or below = off. */
export function stepGlobalAmount(cur: number | null, dir: 1 | -1, step = 500): number | null {
  if (cur === null) return dir > 0 ? step : null;
  const v = Math.round((cur + dir * step) * 100) / 100;
  return v <= 0 ? null : Math.min(GLOBAL_MAX_RS, v);
}

export const fmtGlobalAmount = (n: number | null) => (n === null ? 'off' : `₹${n.toLocaleString('en-IN')}`);

/** Sum of every position's P&L, or null if any is unknown or an order is still in flight on it. */
export function totalPnl(positions: Pick<FmPosition, 'pnl' | 'busy'>[]): number | null {
  let t = 0;
  for (const p of positions) {
    if (p.pnl === null || p.busy) return null;
    t += p.pnl;
  }
  return t;
}

/** Which level the total has reached. The stop-loss wins a tie. */
export function globalBreach(total: number | null, g: Pick<FmGlobalExit, 'target' | 'sl'>): 'target' | 'sl' | null {
  if (total === null) return null;
  if (g.sl !== null && total <= -g.sl) return 'sl';
  if (g.target !== null && total >= g.target) return 'target';
  return null;
}

export const GLOBAL_FIRING_STALE_MS = 120_000;
export const GLOBAL_REFUSED_RETRY_MS = 5000;

export type GlobalAction =
  | { kind: 'none' }
  | { kind: 'streak'; streak: Streak | null }
  | { kind: 'fire'; level: 'target' | 'sl' }
  | { kind: 'mark-unknown'; note: string };

/** The record's next step. `openCount` = positions still open; with none there is nothing to close, so nothing fires. */
export function nextGlobalAction(
  g: FmGlobalExit, total: number | null, openCount: number, streak: Streak | null, now: number,
): GlobalAction {
  if (g.state === 'firing') {
    return now - (g.firedAt ?? 0) > GLOBAL_FIRING_STALE_MS
      ? { kind: 'mark-unknown', note: 'exit UNKNOWN — check the broker: the dashboard stopped while the exits were being sent' }
      : { kind: 'none' };
  }
  if (g.state !== 'watching') return { kind: 'none' };
  const reset: GlobalAction = { kind: 'streak', streak: null };
  if (openCount === 0 || (g.retryAt !== undefined && now < g.retryAt)) return reset;
  const level = globalBreach(total, g);
  if (!level) return reset;
  const count = streak && streak.level === level && now - streak.at <= STREAK_MAX_GAP_MS ? streak.count + 1 : 1;
  return count >= CONFIRM_TICKS ? { kind: 'fire', level } : { kind: 'streak', streak: { level, count, at: now } };
}

/** The record's new fields once all closes have been tried. `results` = one per position, in the order sent. */
export function globalAfterClose(results: CloseResult[], level: 'target' | 'sl', now: number): Partial<FmGlobalExit> {
  const placed = results.filter(r => r.kind === 'placed').length;
  const bad = results.find(r => r.kind !== 'placed');
  if (!bad) return { state: 'sent', firedBy: level, firedAt: now, note: undefined };
  const err = 'error' in bad ? bad.error : '';
  if (results.some(r => r.kind === 'unknown' || (r.kind === 'partial'))) {
    return { state: 'unknown', firedBy: level, firedAt: now, note: `exit UNKNOWN — check the broker: ${err}` };
  }
  if (placed === 0 && bad.kind === 'refused') {
    return { state: 'watching', note: bad.error, retryAt: now + GLOBAL_REFUSED_RETRY_MS, firedBy: undefined, firedAt: undefined };
  }
  if (placed === 0) return { state: 'rejected', firedBy: level, firedAt: now, note: `exit REJECTED by the broker: ${err} — edit to re-arm` };
  return { state: 'incomplete', firedBy: level, firedAt: now, note: `${placed} of ${results.length} closes went out; the rest did not: ${err}` };
}

/** Order to close in: shorts first (their cover frees margin and removes the unlimited risk), then longs/hedges. */
export function closeOrder<T extends Pick<FmPosition, 'netQty'>>(open: T[]): T[] {
  return [...open].sort((a, b) => Number(b.netQty < 0) - Number(a.netQty < 0));
}

/** After a short's cover failed, no later (long/hedge) position is closed: the hedge stays on the remaining short. */
export const mustStopAfter = (p: Pick<FmPosition, 'netQty'>, r: CloseResult) => p.netQty < 0 && r.kind !== 'placed';
