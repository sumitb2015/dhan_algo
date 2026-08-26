// Net position greeks — pure, no React/JSX, so it's importable from both
// components/analytics/GreeksTab.tsx and a plain Node script (e.g.
// scripts/analyze-positions.ts) without pulling in a component's JSX, which
// bare type-stripped Node execution cannot parse.

import type { PositionLeg } from './positionLegs';

/** Signed multiplier taking a per-contract greek to a position greek. */
const posSign = (leg: PositionLeg) => (leg.side === 'SELL' ? -1 : 1) * leg.qtyLots;

export interface NetGreeks {
  delta: number; gamma: number; theta: number; vega: number;
  /** Legs whose greeks the chain did not supply — excluded from the sums above. */
  missing: PositionLeg[];
}

export function computeNetGreeks(legs: PositionLeg[]): NetGreeks {
  let delta = 0, gamma = 0, theta = 0, vega = 0;
  const missing: PositionLeg[] = [];

  for (const leg of legs) {
    // Dhan's chain returns all-zero greeks often enough that a leg with no delta
    // AND no gamma is almost certainly unpopulated rather than genuinely neutral.
    // Summing those zeros silently understates net exposure, so they are excluded
    // and reported instead. This also catches Dhan literally returning
    // {delta:0, theta:0, gamma:0, vega:0} for a priced-but-ungreeked contract
    // (observed live on a deep-ITM strike) — a real option's four greeks are
    // never simultaneously exactly zero, so that combination is the same
    // "unpopulated" signal as all-null, just spelled differently.
    const allNullOrZero = (v: number | null | undefined) => v === null || v === undefined || v === 0;
    if (allNullOrZero(leg.delta) && allNullOrZero(leg.gamma) && allNullOrZero(leg.theta) && allNullOrZero(leg.vega)) {
      missing.push(leg);
      continue;
    }
    const k = posSign(leg);
    delta += (leg.delta ?? 0) * k;
    gamma += (leg.gamma ?? 0) * k;
    theta += (leg.theta ?? 0) * k;
    vega += (leg.vega ?? 0) * k;
  }
  return { delta, gamma, theta, vega, missing };
}
