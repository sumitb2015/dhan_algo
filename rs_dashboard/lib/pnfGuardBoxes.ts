// Box-based MTM levels of the P&F / Renko guard: "10 boxes of profit, 5 boxes of loss". A box is the chart's own box (a price move of
// `box` points), worth `rupeesPerBox` = box x lots x rupees per point per lot for the position the guard is watching. The guard then
// reads one number, the MTM in rupees, so the box levels are turned into rupee levels and the FIRST level reached (rupee or box)
// exits. Pure (tested in lib/pnfGuardBoxes.test.ts).
import type { LadderGuard } from './priceLadderGuard.ts';

const lowest = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/**
 * What box levels are worth in rupees. A number: every box is worth the same (a points or % chart). On a Renko Log % chart a box is
 * one log step, so N boxes are N steps from the ENTRY price, and up and down steps differ: `target(n)` / `stop(n)` give the rupees of
 * n boxes in the position's profit / loss direction. Either way the value is fixed for the trade (it does not move with each brick).
 */
export type BoxValue = number | { target: (n: number) => number; stop: (n: number) => number };

const boxValueOk = (v: BoxValue | null): v is BoxValue => v !== null && (typeof v !== 'number' || (Number.isFinite(v) && v > 0));
const rupeesOf = (v: BoxValue, side: 'target' | 'stop', n: number) => (typeof v === 'number' ? n * v : v[side](n));

/**
 * Box value on a Log % chart (grid ratio `r` = 1 + P/100): from the position's entry price, n up steps are entry x (r^n - 1) points and
 * n down steps entry x (1 - r^-n); a long profits up, a short down. `rupeesPerPoint` = lots x units per lot. Null when anything is unknown.
 */
export function logBoxValue(entry: number | null | undefined, side: 'LONG' | 'SHORT', r: number | null | undefined, rupeesPerPoint: number | null | undefined): BoxValue | null {
  if (!(entry != null && entry > 0 && r != null && r > 1 && Number.isFinite(r) && rupeesPerPoint != null && rupeesPerPoint > 0)) return null;
  const up = (n: number) => entry * (r ** n - 1) * rupeesPerPoint;
  const down = (n: number) => entry * (1 - r ** -n) * rupeesPerPoint;
  return side === 'LONG' ? { target: up, stop: down } : { target: down, stop: up };
}

/** Rupees one box is worth for a position: box points x whole lots x rupees per point per lot; null when any of them is unknown. */
export function rupeesPerBox(boxPts: number | null | undefined, lots: number | null | undefined, unitsPerLot: number | null | undefined): number | null {
  const v = (boxPts ?? 0) * (lots ?? 0) * (unitsPerLot ?? 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The guard with its box levels folded into the rupee target / stop (the lower of the two); unchanged without box levels or a box value. */
export function effectiveGuard(g: LadderGuard, rpb: BoxValue | null): LadderGuard {
  if (!boxValueOk(rpb) || (g.targetBoxes === undefined && g.stopBoxes === undefined)) return g;
  return {
    ...g,
    target: lowest(g.target, g.targetBoxes === undefined ? undefined : rupeesOf(rpb, 'target', g.targetBoxes)),
    stop: lowest(g.stop, g.stopBoxes === undefined ? undefined : rupeesOf(rpb, 'stop', g.stopBoxes)),
  };
}

/** Says "(N boxes)" on a trip reason when the level that tripped was the box one. */
export function noteBoxes(g: LadderGuard, rpb: BoxValue | null, reason: string): string {
  if (!boxValueOk(rpb)) return reason;
  if (reason.startsWith('MTM target') && g.targetBoxes !== undefined && (g.target === undefined || rupeesOf(rpb, 'target', g.targetBoxes) <= g.target)) return `${reason} (${g.targetBoxes} boxes)`;
  if (reason.startsWith('MTM stop-loss') && g.stopBoxes !== undefined && (g.stop === undefined || rupeesOf(rpb, 'stop', g.stopBoxes) <= g.stop)) return `${reason} (${g.stopBoxes} boxes)`;
  return reason;
}
