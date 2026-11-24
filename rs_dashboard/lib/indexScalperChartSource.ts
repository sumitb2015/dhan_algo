// What one chart pane of /index-scalper plots, and which positions / working orders belong on it. Pure: no React, no
// fetch. Tested in indexScalperChartSource.test.ts.
//
// A pane plots the underlying (NIFTY index, or the CRUDEOILM future) or ONE option's premium. On an option pane every
// level (position, TP / SL, working orders) is a premium, so it is exact; the underlying pane carries only what is
// priced on its own axis (futures and non-option orders). Option legs still show there (at the spot they were opened
// at), but their TP / SL live on their own option chart.

import { INSTRUMENTS, type Underlying } from './indexScalperInstrument.ts';
import type { ScalperLeg } from './indexScalperPositions.ts';

export type ChartSource = { kind: 'underlying' } | { kind: 'option'; type: 'CE' | 'PE'; strike: number };

export interface StrikeIdsLike { ceId?: string; peId?: string }
export interface KotakStrikeLike { ceSymbol?: string; peSymbol?: string }

export interface ResolvedSource {
  kind: 'underlying' | 'option';
  /** The option actually shown (a strike missing from this expiry falls back to the nearest one); null for underlying. */
  type: 'CE' | 'PE' | null;
  strike: number | null;
  /** Dhan security id of the option (candles + live ticks come from Dhan whatever the order broker). */
  dhanId: string | null;
  /** Kotak trading symbol of the option, when Kotak's contracts are loaded. */
  kotakSymbol: string | null;
  tick: number;
}

/** Nearest listed strike to `spot`; null without strikes or spot. */
export function nearestStrike(strikes: number[], spot: number | null): number | null {
  if (strikes.length === 0) return null;
  if (spot === null || !Number.isFinite(spot) || spot <= 0) return strikes[Math.floor(strikes.length / 2)];
  let best = strikes[0];
  for (const s of strikes) if (Math.abs(s - spot) < Math.abs(best - spot)) best = s;
  return best;
}

export function resolveSource(
  src: ChartSource,
  underlying: Underlying,
  strikeIds: Map<number, StrikeIdsLike>,
  spot: number | null,
  kotakStrikes?: Map<number, KotakStrikeLike> | null,
): ResolvedSource {
  const spec = INSTRUMENTS[underlying];
  if (src.kind === 'underlying') {
    return { kind: 'underlying', type: null, strike: null, dhanId: null, kotakSymbol: null, tick: spec.futTick };
  }
  const listed = [...strikeIds.keys()].sort((a, b) => a - b);
  const strike = strikeIds.has(src.strike) ? src.strike : nearestStrike(listed, spot);
  const ids = strike === null ? undefined : strikeIds.get(strike);
  const k = strike === null ? undefined : kotakStrikes?.get(strike);
  return {
    kind: 'option',
    type: src.type,
    strike,
    dhanId: (src.type === 'CE' ? ids?.ceId : ids?.peId) ?? null,
    kotakSymbol: (src.type === 'CE' ? k?.ceSymbol : k?.peSymbol) ?? null,
    tick: spec.optTick,
  };
}

/** Does this leg belong on the pane? Underlying pane: every leg (as before). Option pane: only that contract's leg, by
 *  Dhan id (Dhan REAL and SIM legs) or Kotak trading symbol (Kotak REAL legs). */
export function legOnChart(leg: ScalperLeg, r: ResolvedSource): boolean {
  if (r.kind === 'underlying') return true;
  if (leg.type === 'FUT') return false;
  return (r.dhanId !== null && leg.securityId === r.dhanId) || (r.kotakSymbol !== null && leg.securityId === r.kotakSymbol);
}

/** TP / SL handles for a leg on this pane: option legs only on their own premium chart, futures only on the underlying. */
export function bracketsOnChart(leg: ScalperLeg, r: ResolvedSource): boolean {
  return r.kind === 'underlying' ? leg.type === 'FUT' : leg.type !== 'FUT' && legOnChart(leg, r);
}

export interface OrderLike { securityId: string; isOption: boolean }

/** Does this working order belong on the pane? Option pane: exactly that contract. Underlying pane: non-option orders
 *  only (an option order is priced in premium and would sit at a meaningless index level). */
export function orderOnChart(o: OrderLike, r: ResolvedSource): boolean {
  if (r.kind === 'underlying') return !o.isOption;
  if (!o.securityId) return false;
  return o.securityId === r.dhanId || o.securityId === r.kotakSymbol;
}

/** Short pane label, e.g. "NIFTY 25550 CE". */
export function sourceLabel(underlying: Underlying, r: ResolvedSource): string {
  if (r.kind === 'underlying') return underlying === 'CRUDEOILM' ? 'CRUDEOILM FUT' : 'NIFTY IDX';
  return `${underlying} ${r.strike ?? '—'} ${r.type}`;
}
