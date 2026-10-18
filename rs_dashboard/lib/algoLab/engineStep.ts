/**
 * One risk step of an open position at price `px` — the single function both the simulator (at each point of a bar)
 * and the live engine (on each tick) call, so a stop, trail or strategy exit behaves the same in both.
 *
 * Order: improve the best price, ask the strategy for its stop / exits, clamp the stop (tighten-only), add the stop
 * itself if crossed, and pick the exit the price reaches first on the move prevPx -> px.
 */

import { bestOf, clampStop, fillOnSegment, firstCrossed, stopHit } from './risk.ts';
import type { AlgoConfig, AlgoCtx, ExitSignal, Json, PositionView, StrategyDefinition } from './types.ts';

export interface StepResult {
  best: number;
  stop: number;
  state: Json;
  /** The exit to take, with its fill on the traded segment prevPx..px (live books the LTP instead). */
  exit: (ExitSignal & { fill: number }) | null;
}

export function stepPosition(def: StrategyDefinition, p: PositionView, px: number, prevPx: number, ctx: AlgoCtx, c: AlgoConfig): StepResult {
  const best = bestOf(p.side, p.best, px);
  const res = def.manage({ ...p, best }, px, ctx, c);
  const stop = clampStop(p.side, p.stop, res.stop);
  const state = res.state !== undefined ? res.state : p.state;
  const exits: ExitSignal[] = [...(res.exits ?? [])];
  if (stopHit(p.side, px, stop)) {
    const trailed = stop !== p.initialStop;
    exits.push({ kind: trailed ? 'TRAIL_STOP' : 'STOP', level: stop, reason: `${trailed ? 'Trailing stop' : 'Stop'} ₹${stop.toFixed(2)} hit` });
  }
  const hit = firstCrossed(prevPx, px, exits);
  return { best, stop, state, exit: hit ? { ...hit, fill: fillOnSegment(prevPx, px, hit.level) } : null };
}
