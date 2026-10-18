/**
 * Side-aware price arithmetic shared by strategies, the simulator, the ledger and the live engine.
 * SELL (short premium) loses when price rises; BUY (long premium) loses when price falls.
 */

import type { ExitSignal, Side } from './types.ts';

export const r2 = (n: number) => Math.round(n * 100) / 100;

/** P&L per unit of moving from `entry` to `exit`. */
export const pnlPts = (side: Side, entry: number, exit: number) => (side === 'SELL' ? entry - exit : exit - entry);

/** The order side that opens / closes a position of `side`. */
export const exitSideOf = (side: Side): Side => (side === 'SELL' ? 'BUY' : 'SELL');

export const initialStop = (side: Side, entry: number, slPct: number) =>
  r2(side === 'SELL' ? entry * (1 + slPct / 100) : entry * (1 - slPct / 100));

/** Profit target at `pct` % of the entry premium; null when pct <= 0 (no target). */
export const targetOf = (side: Side, entry: number, pct: number): number | null =>
  pct > 0 ? r2(side === 'SELL' ? entry * (1 - pct / 100) : entry * (1 + pct / 100)) : null;

/** Best price so far (SELL: lowest, BUY: highest). */
export const bestOf = (side: Side, prev: number, px: number) => (side === 'SELL' ? Math.min(prev, px) : Math.max(prev, px));

/** A stop can only tighten: SELL down, BUY up. */
export const clampStop = (side: Side, prev: number, next: number) =>
  Number.isFinite(next) ? (side === 'SELL' ? Math.min(prev, next) : Math.max(prev, next)) : prev;

export const stopHit = (side: Side, px: number, stop: number) => (side === 'SELL' ? px >= stop : px <= stop);
export const targetHit = (side: Side, px: number, target: number | null) =>
  target != null && (side === 'SELL' ? px <= target : px >= target);

/**
 * Lock & trail (Breakdown Scalper's 3-phase stop, mirrored for BUY):
 *  1. until the best price is `trailStartPct` % in profit, the stop stays at `initial`;
 *  2. then it locks to cost (entry);
 *  3. for every further `stepPts` of gain it moves `byPts` towards profit.
 * The result is never looser than `initial`.
 */
export function lockAndTrail(
  side: Side,
  entry: number,
  best: number,
  initial: number,
  trailStartPct: number,
  stepPts: number,
  byPts: number,
): number {
  const gain = pnlPts(side, entry, best);
  const trigger = (entry * trailStartPct) / 100;
  if (!(gain >= trigger) || trailStartPct <= 0) return initial;
  const steps = stepPts > 0 ? Math.floor((gain - trigger) / stepPts + 1e-9) : 0;
  const level = side === 'SELL' ? entry - steps * byPts : entry + steps * byPts;
  return r2(clampStop(side, initial, level));
}

/**
 * Among exits triggered on the move prev -> px, the one whose level the price reaches first: moving up, the lowest
 * level; moving down, the highest. (A fixed precedence would pick a later level the price never stopped at.)
 */
export function firstCrossed<T extends Pick<ExitSignal, 'level'>>(prev: number, px: number, exits: T[]): T | null {
  if (!exits.length) return null;
  const up = px >= prev;
  return [...exits].sort((a, b) => (up ? a.level - b.level : b.level - a.level))[0];
}

/** A level clamped onto the traded segment prev..px: a crossed level fills at the level, a gap fills at the price. */
export const fillOnSegment = (prev: number, px: number, level: number) =>
  Math.min(Math.max(prev, px), Math.max(Math.min(prev, px), level));
