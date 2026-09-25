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
