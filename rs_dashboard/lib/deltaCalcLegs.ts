// Leg model for the shared net-delta calculator (components/NetDeltaCalculator.tsx) plus the adapter for tools that already
// hold GreekLeg[] (Multi-Leg Focus, Focus Tool). Pure: no fetch, no React.

import type { GreekLeg } from './multiLegGreeks.ts';
import { calculateTimeToExpiryYears, greeksFromMark, type OptType } from './optionsPricing.ts';

export interface CalcLeg {
  key: string;
  label: string;
  kind: 'FUT' | OptType;
  strike: number;
  expiry: string | null;
  /** Units (barrels / shares) in one lot of this leg. */
  unitsPerLot: number;
  /** Signed lots currently held. */
  liveLots: number;
  /** Premium the leg trades at now (options), used to solve the starting IV. */
  mark: number;
  /** IV as a percent, solved from the mark. */
  liveIv: number;
}

export interface GreekLegsToCalcOptions {
  /** Units in one lot, so the lots box reads in the lots the trader thinks in. */
  unitsPerLot: number;
  /** Underlying price the starting IVs are solved at. */
  price: number;
  /** Options on a futures price (MCX): Black-76. */
  isFutures: boolean;
  markOf: (leg: GreekLeg) => number | undefined;
  /** Chain IV (fraction) used when a leg has no live price. */
  chainIvOf?: (leg: GreekLeg) => number | undefined;
  /** IV (fraction) when neither a mark nor a chain IV exists. */
  fallbackIv: number;
  labelOf?: (leg: GreekLeg) => string;
}

/** GreekLeg[] → calculator legs. Sell legs become negative lots; the IV is solved from each leg's own mark. */
export function calcLegsFromGreekLegs(legs: GreekLeg[], o: GreekLegsToCalcOptions): CalcLeg[] {
  const out: CalcLeg[] = [];
  for (const l of legs) {
    if (!(l.units > 0) || !(o.unitsPerLot > 0)) continue;
    const liveLots = (l.side === 'S' ? -1 : 1) * (l.units / o.unitsPerLot);
    if (l.option === 'FUT') {
      out.push({ key: l.legId, label: o.labelOf?.(l) ?? 'Future', kind: 'FUT', strike: 0, expiry: l.expiry || null, unitsPerLot: o.unitsPerLot, liveLots, mark: 0, liveIv: 0 });
      continue;
    }
    const mark = o.markOf(l) ?? 0;
    const t = l.expiry ? calculateTimeToExpiryYears(l.expiry) : 0;
    const solved = l.expiry && mark > 0 && o.price > 0
      ? greeksFromMark({ type: l.option, strike: l.strike, expiry: l.expiry, mark, underlying: o.price, isFutures: o.isFutures })
      : null;
    const fallback = o.chainIvOf?.(l) || o.fallbackIv;
    const ivPct = solved && t > 0 ? solved.iv * 100 : fallback * 100;
    out.push({
      key: l.legId,
      label: o.labelOf?.(l) ?? `${l.option === 'PE' ? 'Put' : 'Call'} ${l.strike.toLocaleString('en-IN')}${l.expiry ? ` · ${l.expiry}` : ''}`,
      kind: l.option, strike: l.strike, expiry: l.expiry || null, unitsPerLot: o.unitsPerLot, liveLots, mark,
      liveIv: Math.round(ivPct * 10) / 10,
    });
  }
  return out;
}
