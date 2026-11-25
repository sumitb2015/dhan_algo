// Index Scalper "Reverse position": the rules, pure (no React, no fetch). The terminal runs it as
//   fresh broker read -> cancel this page's working orders on the closing side of that contract -> close the row in full
//   (the exit path: uncapped `isxx`, Kotak freeze slices) -> open the same lots on the other side, on THE ROW'S OWN
//   contract (Dhan security id / Kotak trading symbol), never one looked up again by strike in the expiry on screen.
// Tested in indexScalperReverse.test.ts.

export interface ReverseOrderLike { id: string; securityId: string; side: string; cancellable: boolean; own: boolean }

/**
 * Working orders on the contract that would ADD to the new position once it is reversed: the old position's target /
 * stop sit on its closing side, which is the new position's opening side (a long's SELL stop sells more after the
 * flip). This page's own are cancelled first; another placer's block the reverse (cancelling a strategy's order
 * silently is not this page's call).
 */
export function reverseBlockers(orders: readonly ReverseOrderLike[], securityId: string, isLong: boolean): { own: string[]; foreign: string[] } {
  const closeSide = isLong ? 'SELL' : 'BUY';
  const own: string[] = [];
  const foreign: string[] = [];
  for (const o of orders) {
    if (!o.cancellable || !o.securityId || o.securityId !== securityId || o.side !== closeSide) continue;
    (o.own ? own : foreign).push(o.id);
  }
  return { own, foreign };
}

/** Why the reverse cannot run for `lots` (null = it can): the opening half is a normal opening order, capped per order. */
export function reverseLotsError(lots: number | null, maxLots: number): string | null {
  if (lots === null) return 'the position is not a whole number of lots (or the lot size is unknown)';
  if (lots > maxLots) return `the other side would open ${lots} lots in one order, above the ${maxLots}-lot cap per order: Exit, then open it in smaller orders`;
  return null;
}
