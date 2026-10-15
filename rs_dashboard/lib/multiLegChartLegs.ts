import type { StrategyLeg } from './optionsChartTypes.ts';
import { isOptionLeg, type MultiLegLeg } from './multiLegFocus.ts';

/** A leg the Strategy Chart plots: an option leg that is not CLOSED/FAILED and has lots. DRAFT and
 *  PLACING legs are still plotted (see the modal header); futures legs are on the payoff chart. */
function isChartLeg(l: MultiLegLeg): boolean {
  return isOptionLeg(l) && l.status !== 'CLOSED' && l.status !== 'FAILED' && l.lots > 0 && Number.isFinite(l.strike);
}

/** Chart legs for a basket: every live leg, with legs on the same contract netted by signed lots
 *  (a BUY and a SELL on one strike cancel instead of costing two chart legs). */
export function chartLegsFor(legs: MultiLegLeg[], lotSize?: number): StrategyLeg[] {
  const net = new Map<string, StrategyLeg & { signed: number }>();
  for (const l of legs.filter(isChartLeg)) {
    // A placed leg is sized from what actually filled (ledger qty / lot size), not the ordered
    // lots. Only when the qty divides cleanly; crude quantity semantics differ, so the caller
    // omits lotSize there and the ordered lots are used.
    const filled = l.fill?.qty ?? 0;
    const filledLots = lotSize && lotSize > 0 && filled > 0 ? Math.round(filled / lotSize) : 0;
    const lots = l.status === 'OPEN' && filledLots > 0 && Math.abs(filledLots * (lotSize as number) - filled) < 1e-6 ? filledLots : l.lots;
    const key = `${l.strike}:${l.option}`;
    const hit = net.get(key);
    const signed = (l.side === 'B' ? 1 : -1) * lots;
    if (hit) hit.signed += signed;
    else net.set(key, { option_type: l.option as 'CE' | 'PE', action: 'BUY', strike: l.strike, lots: 0, signed });
  }
  return [...net.values()]
    .filter((v) => v.signed !== 0)
    .map(({ signed, ...leg }) => ({ ...leg, action: signed > 0 ? 'BUY' : 'SELL', lots: Math.abs(signed) }));
}

/** True when a leg the chart would plot trades on a different expiry than the basket (Calendar /
 *  Diagonal): the chart is single-expiry. Dead legs (CLOSED/FAILED) never block it. */
export function chartHasMixedExpiry(legs: MultiLegLeg[], basketExpiry: string): boolean {
  return legs.some((l) => isChartLeg(l) && !!l.expiry && l.expiry !== basketExpiry);
}
