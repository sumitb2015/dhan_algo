// Multi-Leg Focus: warn when a new SHORT is bigger than the short on the same side that was just stopped out.
// Selling more after a stop-out (rolling up into the move with a larger size) is how a small loss became a big one.
// Pure rule: the Add Leg ticket shows the warning and asks for an explicit acknowledgement. It never blocks.

import type { MultiLegBasket } from './multiLegFocus.ts';

export interface RollSizeWarning {
  /** Lots of the largest short on this option side that closed at a loss today. */
  stoppedLots: number;
  /** Lots the user is about to sell. */
  newLots: number;
  option: 'CE' | 'PE';
  message: string;
}

const istDay = (ts: number): string => new Date(ts + 5.5 * 3_600_000).toISOString().slice(0, 10);

/**
 * `lotSize` converts the ledger's quantity back to lots (leg.lots is the leg's *current* lots, which a partial exit changes).
 * Only legs closed TODAY at a loss count: a short whose exit price is above its entry premium. Unknown prices are not a loss.
 */
export function rollSizeWarning(
  basket: Pick<MultiLegBasket, 'legs'>,
  draft: { side: 'B' | 'S'; option: 'CE' | 'PE'; lots: number },
  lotSize: number,
  now: number = Date.now(),
): RollSizeWarning | null {
  if (draft.side !== 'S' || !(draft.lots > 0)) return null;
  const today = istDay(now);
  let stoppedLots = 0;
  for (const l of basket.legs) {
    if (l.side !== 'S' || l.option !== draft.option || l.status !== 'CLOSED') continue;
    if (l.closedAt == null || istDay(l.closedAt) !== today) continue;
    // An estimated exit is the broker row's pooled day average, not this leg's own fill: not proof of a loss.
    if (l.closedFill?.estimated) continue;
    const exit = l.closedFill?.exitPrice, entry = l.fill?.avgPrice;
    if (!(typeof exit === 'number' && typeof entry === 'number' && entry > 0 && exit > entry)) continue;
    const q = l.closedFill?.qty ?? 0;
    // Ledger qty is in contract units; if it is not a whole number of lots (unit mismatch, e.g. MCX or a lot size still
    // loading) fall back to the leg's own lots rather than guess.
    const lots = lotSize > 0 && q > 0 && q % lotSize === 0 ? q / lotSize : l.lots;
    if (lots > stoppedLots) stoppedLots = lots;
  }
  if (!(stoppedLots > 0) || draft.lots <= stoppedLots) return null;
  return {
    stoppedLots, newLots: draft.lots, option: draft.option,
    message: `A ${stoppedLots}-lot short ${draft.option} was closed at a loss today. You are selling ${draft.lots} lots, ${(draft.lots / stoppedLots).toFixed(1)}x that size, into the same move.`,
  };
}
