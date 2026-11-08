// Box-based MTM levels of the P&F / Renko guard: "10 boxes of profit, 5 boxes of loss". A box is the chart's own box (a price move of
// `box` points), worth `rupeesPerBox` = box x lots x rupees per point per lot for the position the guard is watching. The guard then
// reads one number, the MTM in rupees, so the box levels are turned into rupee levels and the FIRST level reached (rupee or box)
// exits. Pure (tested in lib/pnfGuardBoxes.test.ts).
import type { LadderGuard } from './priceLadderGuard.ts';

const lowest = (a?: number, b?: number) => (a === undefined ? b : b === undefined ? a : Math.min(a, b));

/** Rupees one box is worth for a position: box points x whole lots x rupees per point per lot; null when any of them is unknown. */
export function rupeesPerBox(boxPts: number | null | undefined, lots: number | null | undefined, unitsPerLot: number | null | undefined): number | null {
  const v = (boxPts ?? 0) * (lots ?? 0) * (unitsPerLot ?? 0);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** The guard with its box levels folded into the rupee target / stop (the lower of the two); unchanged without box levels or a box value. */
export function effectiveGuard(g: LadderGuard, rpb: number | null): LadderGuard {
  if (!(rpb !== null && rpb > 0) || (g.targetBoxes === undefined && g.stopBoxes === undefined)) return g;
  return {
    ...g,
    target: lowest(g.target, g.targetBoxes === undefined ? undefined : g.targetBoxes * rpb),
    stop: lowest(g.stop, g.stopBoxes === undefined ? undefined : g.stopBoxes * rpb),
  };
}

/** Says "(N boxes)" on a trip reason when the level that tripped was the box one. */
export function noteBoxes(g: LadderGuard, rpb: number | null, reason: string): string {
  if (rpb === null || !(rpb > 0)) return reason;
  if (reason.startsWith('MTM target') && g.targetBoxes !== undefined && (g.target === undefined || g.targetBoxes * rpb <= g.target)) return `${reason} (${g.targetBoxes} boxes)`;
  if (reason.startsWith('MTM stop-loss') && g.stopBoxes !== undefined && (g.stop === undefined || g.stopBoxes * rpb <= g.stop)) return `${reason} (${g.stopBoxes} boxes)`;
  return reason;
}
