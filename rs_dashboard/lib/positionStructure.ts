/**
 * Aggregates raw option legs (one per broker position row) into net legs per
 * (strike, type) and classifies the resulting shape into a recognizable
 * options structure (straddle, strangle, spread, condor, naked).
 *
 * Shared by the Margin Allocator (`app/api/margin-allocator/route.ts`, which
 * classifies a broker's whole book to price margin per structure) and
 * Multi-Leg Focus (`lib/multiLegFocus.ts`'s `findUntrackedGroups`, which
 * classifies broker positions with no matching basket leg so they can be
 * auto-tracked). Originally lived only in margin-allocator's route.
 */

import type { PositionLeg } from './positionLegs.ts';

export interface GroupLeg {
  strike: number;
  type: 'CE' | 'PE';
  side: 'BUY' | 'SELL';
  qty: number;
  avgPrice: number;
  securityId: string | null;
  /** Broker trading symbol for this (strike, type) — margin-allocator never
   *  needed this (it re-resolves a Dhan securityId from the live chain for
   *  cross-broker margin pricing), but Multi-Leg Focus's `orderRef.symbol`
   *  matching for non-Dhan legs (see findLegPosition) does. */
  symbol: string | null;
}

/**
 * Classify an aggregated (strike, type) leg set into the structure it forms.
 *
 * Deliberately coarse — this covers every shape the value_imbalance /
 * spread_trend / oi_directional strategies (CLAUDE.md) actually build, plus
 * the single-type (Call/Put) Butterfly template from the Baskets page
 * (lib/basketStrategies.ts). Anything more exotic (jade lizards, broken-wing
 * ratio combos, multi-strike scale-ins) falls into 'Custom Combo' or
 * 'Long Options / Hedge' rather than being mis-labeled as a clean butterfly.
 */
export function classifyStructure(legs: GroupLeg[]): { structure: string; riskType: 'defined' | 'undefined' } {
  const shortCE = legs.filter((l) => l.type === 'CE' && l.side === 'SELL');
  const shortPE = legs.filter((l) => l.type === 'PE' && l.side === 'SELL');
  const longCE = legs.filter((l) => l.type === 'CE' && l.side === 'BUY');
  const longPE = legs.filter((l) => l.type === 'PE' && l.side === 'BUY');

  if (shortCE.length === 1 && shortPE.length === 1 && longCE.length === 1 && longPE.length === 1) {
    if (longCE[0].strike > shortCE[0].strike && longPE[0].strike < shortPE[0].strike) {
      return { structure: 'Iron Condor', riskType: 'defined' };
    }
    if (longCE[0].strike < shortCE[0].strike && longPE[0].strike > shortPE[0].strike) {
      return { structure: 'Batman', riskType: 'undefined' };
    }
  }
  if (shortCE.length === 1 && shortPE.length === 1 && longCE.length === 0 && longPE.length === 0) {
    return shortCE[0].strike === shortPE[0].strike
      ? { structure: 'Short Straddle', riskType: 'undefined' }
      : { structure: 'Short Strangle', riskType: 'undefined' };
  }
  if (shortCE.length === 1 && longCE.length === 1 && shortPE.length === 0 && longPE.length === 0) {
    return longCE[0].strike > shortCE[0].strike
      ? { structure: 'Bear Call Spread', riskType: 'defined' }
      : { structure: 'Custom Call Combo', riskType: 'defined' };
  }
  if (shortPE.length === 1 && longPE.length === 1 && shortCE.length === 0 && longCE.length === 0) {
    return longPE[0].strike < shortPE[0].strike
      ? { structure: 'Bull Put Spread', riskType: 'defined' }
      : { structure: 'Custom Put Combo', riskType: 'defined' };
  }
  // Single-type Butterfly: one short body strike flanked by two long wing
  // strikes of the same option type, symmetric (equal distance each side)
  // and in the classic 1:2:1 quantity ratio — anything looser (skewed
  // wings, mismatched quantities) is a broken-wing/ratio combo, not a clean
  // butterfly, and is deliberately left to fall through below.
  if (shortCE.length === 1 && longCE.length === 2 && shortPE.length === 0 && longPE.length === 0) {
    const [lowCE, highCE] = [...longCE].sort((a, b) => a.strike - b.strike);
    const body = shortCE[0];
    if (
      lowCE.strike < body.strike && body.strike < highCE.strike &&
      body.strike - lowCE.strike === highCE.strike - body.strike &&
      lowCE.qty === highCE.qty && body.qty === lowCE.qty + highCE.qty
    ) {
      return { structure: 'Call Butterfly', riskType: 'defined' };
    }
  }
  if (shortPE.length === 1 && longPE.length === 2 && shortCE.length === 0 && longCE.length === 0) {
    const [lowPE, highPE] = [...longPE].sort((a, b) => a.strike - b.strike);
    const body = shortPE[0];
    if (
      lowPE.strike < body.strike && body.strike < highPE.strike &&
      body.strike - lowPE.strike === highPE.strike - body.strike &&
      lowPE.qty === highPE.qty && body.qty === lowPE.qty + highPE.qty
    ) {
      return { structure: 'Put Butterfly', riskType: 'defined' };
    }
  }
  if (shortCE.length >= 1 && shortPE.length === 0 && longCE.length === 0 && longPE.length === 0) {
    return { structure: 'Naked Call', riskType: 'undefined' };
  }
  if (shortPE.length >= 1 && shortCE.length === 0 && longCE.length === 0 && longPE.length === 0) {
    return { structure: 'Cash-Secured / Naked Put', riskType: 'undefined' };
  }
  if (longCE.length >= 1 || longPE.length >= 1) {
    return { structure: 'Long Options / Hedge', riskType: 'defined' };
  }
  return {
    structure: 'Custom Combo',
    riskType: shortCE.length + shortPE.length > longCE.length + longPE.length ? 'undefined' : 'defined',
  };
}

export function aggregateLegs(bucketLegs: PositionLeg[]): GroupLeg[] {
  const map = new Map<string, GroupLeg & { signedQty: number }>();
  for (const leg of bucketLegs) {
    const key = `${leg.strike}:${leg.type}`;
    const signedQty = (leg.side === 'SELL' ? -1 : 1) * leg.qtyLots;
    const existing = map.get(key);
    if (existing) {
      const newSigned = existing.signedQty + signedQty;
      existing.signedQty = newSigned;
      existing.qty = Math.abs(newSigned);
      existing.side = newSigned < 0 ? 'SELL' : 'BUY';
      existing.avgPrice = (existing.avgPrice + leg.price) / 2;
      if (!existing.securityId) existing.securityId = leg.securityId;
      if (!existing.symbol) existing.symbol = leg.display.tradingSymbol || null;
    } else {
      map.set(key, {
        strike: leg.strike, type: leg.type, side: leg.side,
        qty: leg.qtyLots, avgPrice: leg.price, securityId: leg.securityId,
        symbol: leg.display.tradingSymbol || null,
        signedQty,
      });
    }
  }
  return [...map.values()]
    .filter((l) => l.qty > 0)
    .map((l): GroupLeg => ({
      strike: l.strike, type: l.type, side: l.side, qty: l.qty,
      avgPrice: l.avgPrice, securityId: l.securityId, symbol: l.symbol,
    }));
}
