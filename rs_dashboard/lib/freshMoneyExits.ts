/**
 * Fresh Money board — per-position target and stop-loss (pure, no I/O). REAL MONEY: the dashboard-server watcher
 * (lib/freshMoneyExitServer.ts) sends a MARKET close when one of these levels is hit.
 * Spec: docs/superpowers/specs/2026-11-11-fresh-money-target-sl-design.md.
 *
 * A level is a number in percent of the position's average fill price or in option premium points. Once the opening fill
 * is priced, the levels are fixed PRICES: adding lots does not move them. A level that works out at or below zero is off,
 * never a price.
 */

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

export function fmtExitSpec(s: ExitSpec | null): string {
  if (!s) return 'off';
  return s.unit === 'pct' ? `${s.value}%` : `${s.value} pts`;
}
