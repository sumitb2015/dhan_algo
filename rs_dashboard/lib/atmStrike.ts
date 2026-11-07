// The ATM strike rule, pure (no disk access), so browser code and the master-list reader (lib/pnfContracts.ts) share ONE rule.

/** The listed strike nearest `spot` (the lower one on a tie); the middle strike when there is no usable spot. Null for an empty list. */
export function atmStrike(strikes: number[], spot: number | null): number | null {
  if (!strikes.length) return null;
  if (spot === null || !(spot > 0)) return strikes[Math.floor((strikes.length - 1) / 2)];
  return strikes.reduce((best, k) => (Math.abs(k - spot) < Math.abs(best - spot) ? k : best), strikes[0]);
}
