// On-demand Greeks for one Multi-Leg Focus strategy row. Pure — no fetch/React.
// Chain-supplied pipeline (see dhan-position-greeks): Dhan's own per-contract
// greeks are joined onto each leg and summed by computeNetGreeks.

import type { MultiLegBasket } from './multiLegFocus.ts';
import type { PositionLeg } from './positionLegs.ts';
import { lookupChainLegData, type ChainOc } from './optionsStrategy.ts';
import { computeNetGreeks, type NetGreeks } from './positionGreeks.ts';

export interface GreekLeg {
  legId: string;
  side: 'B' | 'S';
  option: 'CE' | 'PE';
  strike: number;
  expiry: string;
  /** Real contract units (NOT lots) — the multiplier computeNetGreeks expects. */
  units: number;
}

/**
 * Legs that contribute exposure. Placed baskets use each leg's own fill ledger
 * (OPEN/CLOSING only); a pure-draft basket previews lots × lotSize.
 * `mult` converts broker qty to real units (Dhan crude: qty is in lots); it applies to
 * drafts too, matching the payoff code's `(fill.qty || lots*lotSize) * crudeMult`.
 */
export function basketToGreekLegs(basket: MultiLegBasket, lotSize: number, mult = 1): GreekLeg[] {
  const hasPlaced = basket.legs.some(l => l.status !== 'DRAFT');
  const out: GreekLeg[] = [];
  for (const l of basket.legs) {
    let units = 0;
    if (hasPlaced) {
      if (l.status !== 'OPEN' && l.status !== 'CLOSING') continue;
      units = (l.fill?.qty ?? 0) * mult;
    } else {
      units = l.lots * lotSize * mult;
    }
    if (!(units > 0)) continue;
    out.push({
      legId: l.id,
      side: l.side === 'B' ? 'B' : 'S',
      option: l.option,
      strike: l.strike,
      expiry: l.expiry || basket.expiry,
      units,
    });
  }
  return out;
}

export interface PricedGreekLeg extends GreekLeg {
  delta: number | null; gamma: number | null; theta: number | null; vega: number | null;
  iv: number | null; // fraction
}

/** Joins chain greeks (keyed by expiry) onto legs and aggregates. */
export function computeBasketGreeks(
  legs: GreekLeg[],
  chains: Record<string, ChainOc | undefined>,
): { net: NetGreeks; legs: PricedGreekLeg[]; missing: PricedGreekLeg[] } {
  const priced: PricedGreekLeg[] = legs.map(l => {
    const cl = chains[l.expiry] ? lookupChainLegData(chains[l.expiry]!, l.strike, l.option) : undefined;
    return {
      ...l,
      delta: cl?.greeks?.delta ?? null,
      gamma: cl?.greeks?.gamma ?? null,
      theta: cl?.greeks?.theta ?? null,
      vega: cl?.greeks?.vega ?? null,
      iv: typeof cl?.implied_volatility === 'number' && cl.implied_volatility > 0 ? cl.implied_volatility / 100 : null,
    };
  });
  const asPos = priced.map(p => ({
    side: p.side === 'S' ? 'SELL' : 'BUY',
    qtyLots: p.units,
    delta: p.delta, gamma: p.gamma, theta: p.theta, vega: p.vega,
    strike: p.strike, type: p.option, expiry: p.expiry,
  })) as unknown as PositionLeg[];
  const net = computeNetGreeks(asPos);
  const missingKeys = new Set(net.missing.map(m => `${m.strike}${m.type}${m.expiry}`));
  const missing = priced.filter(p => missingKeys.has(`${p.strike}${p.option}${p.expiry}`));
  return { net, legs: priced, missing };
}
