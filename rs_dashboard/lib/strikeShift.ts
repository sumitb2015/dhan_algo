// Strike-shift target resolution for the scalper chevrons.

export const MAX_SHIFT_STEPS = 10;

export function clampShiftSteps(n: number): number {
  const v = Math.trunc(Number(n));
  if (!Number.isFinite(v) || v < 1) return 1;
  return Math.min(v, MAX_SHIFT_STEPS);
}

export interface ShiftTarget {
  /** Index into `sorted` of the strike to land on. */
  targetIdx: number;
  /** Steps actually moved (< requested when clamped at the chain edge). */
  moved: number;
}

/**
 * Move `steps` listed strikes up/down from `current`, clamped to the chain edge.
 * Returns null when no movement is possible. When `current` isn't in the list,
 * falls back to an exact `current ± fallbackStep*steps` lookup.
 */
export function resolveShiftTarget(
  sorted: number[], current: number, direction: 'UP' | 'DOWN', steps: number, fallbackStep: number,
): ShiftTarget | null {
  const n = clampShiftSteps(steps);
  const sign = direction === 'UP' ? 1 : -1;
  const currIdx = sorted.indexOf(current);
  if (currIdx === -1) {
    const idx = sorted.indexOf(current + sign * fallbackStep * n);
    return idx === -1 ? null : { targetIdx: idx, moved: n };
  }
  const targetIdx = Math.max(0, Math.min(sorted.length - 1, currIdx + sign * n));
  const moved = Math.abs(targetIdx - currIdx);
  return moved === 0 ? null : { targetIdx, moved };
}

export interface LegShiftInput { id: string; strike: number; expiry?: string }
export interface LegShiftMove { legId: string; from: number; to: number }
export type LegShiftPlan =
  | { ok: true; moves: LegShiftMove[] }
  | { ok: false; reason: string };

/**
 * Plan a multi-leg shift. All-or-nothing: if ANY leg cannot move the full
 * `steps` (chain edge, unresolvable strike, missing chain), the whole plan is
 * refused — a live strategy must never end up with only some legs moved, or a
 * leg on a strike other than the one asked for.
 *
 * `strikesFor` returns the sorted listed strikes for a leg's own expiry (a
 * Calendar/Diagonal far leg has a different chain from the front month).
 */
export function planLegShifts(
  legs: LegShiftInput[],
  strikesFor: (legExpiry: string | undefined) => number[],
  direction: 'UP' | 'DOWN',
  steps: number,
  fallbackStep: number,
): LegShiftPlan {
  if (!legs.length) return { ok: false, reason: 'No open legs to shift' };
  const n = clampShiftSteps(steps);
  const moves: LegShiftMove[] = [];
  for (const leg of legs) {
    const sorted = strikesFor(leg.expiry);
    if (!sorted.length) return { ok: false, reason: `Strike list for ${leg.strike} not loaded yet` };
    const target = resolveShiftTarget(sorted, leg.strike, direction, n, fallbackStep);
    if (!target) return { ok: false, reason: `No ${direction.toLowerCase()} strike available for ${leg.strike}` };
    if (target.moved < n) {
      return { ok: false, reason: `Only ${target.moved} strike${target.moved > 1 ? 's' : ''} available ${direction.toLowerCase()} of ${leg.strike}, ${n} requested` };
    }
    moves.push({ legId: leg.id, from: leg.strike, to: sorted[target.targetIdx] });
  }
  return { ok: true, moves };
}
