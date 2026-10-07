// On-demand Greeks for one Multi-Leg Focus strategy row. Pure — no fetch/React.
// Computed through the central payoff/pricing library (IV solved from each leg's live mark) — the same numbers as the payoff chart.

import type { MultiLegBasket, LegInstrument } from './multiLegFocus.ts';
import { bookGreeks } from './optionsPayoff.ts';

export interface GreekLeg {
  legId: string;
  side: 'B' | 'S';
  option: LegInstrument;
  strike: number;
  expiry: string;
  /** Real contract units (NOT lots) — the multiplier the Greeks are scaled by. */
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
  ivSource: 'mark' | 'chain' | 'assumed';
}

export interface BasketGreekContext {
  spot: number;
  /** Live premium of a leg (the IV is solved from it). */
  markOf: (leg: GreekLeg) => number | undefined;
  /** Chain IV fallback (fraction) when a leg has no live price. */
  chainIvOf?: (leg: GreekLeg) => number | undefined;
  fallbackIv?: number;
  now?: number;
}

/**
 * Net and per-leg Greeks for a basket, through the central payoff library (lib/optionsPayoff.ts → bookGreeks), so this panel
 * agrees with the payoff chart, the header strips and every other page. No chain fetch: IV is solved from each leg's live mark.
 * `net` is position-scaled (units / ₹ per day / ₹ per 1% IV); `legs` hold per-unit Greeks, as the panel multiplies by ±units.
 * `assumed` lists legs that had neither a live price nor a chain IV and were priced on the fallback IV.
 */
export function computeBasketGreeks(
  legs: GreekLeg[],
  ctx: BasketGreekContext,
): { net: { delta: number; gamma: number; theta: number; vega: number }; legs: PricedGreekLeg[]; assumed: PricedGreekLeg[] } {
  const empty = { net: { delta: 0, gamma: 0, theta: 0, vega: 0 }, legs: [] as PricedGreekLeg[], assumed: [] as PricedGreekLeg[] };
  if (legs.length === 0) return empty;
  // Futures: delta 1 per unit, no gamma/theta/vega. Options go through the central library.
  const opts = legs.filter((l): l is GreekLeg & { option: 'CE' | 'PE' } => l.option !== 'FUT');
  const res = opts.length ? bookGreeks({
    spot: ctx.spot, now: ctx.now, fallbackIv: ctx.fallbackIv,
    legs: opts.map(l => ({
      type: l.option, strike: l.strike, expiry: l.expiry, qty: l.side === 'S' ? -l.units : l.units,
      entryPrice: 1, mark: ctx.markOf(l), chainIv: ctx.chainIvOf?.(l),
    })),
  }) : null;
  if (opts.length && !res) return empty;
  const net = res ? { ...res.net } : { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const priced: PricedGreekLeg[] = legs.map(l => {
    if (l.option === 'FUT') {
      net.delta += l.side === 'S' ? -l.units : l.units;
      return { ...l, delta: 1, gamma: 0, theta: 0, vega: 0, iv: null, ivSource: 'mark' as const };
    }
    const i = opts.indexOf(l as GreekLeg & { option: 'CE' | 'PE' });
    return { ...l, ...res!.legs[i].unit, iv: res!.legs[i].iv, ivSource: res!.legs[i].ivSource };
  });
  return { net, legs: priced, assumed: priced.filter(p => p.ivSource === 'assumed') };
}
