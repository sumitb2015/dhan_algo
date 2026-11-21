// The Signal Orb funds gate's arithmetic, pure (no imports) so it is unit-tested; lib/orbMargin.ts reads the broker and calls it.

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** What a BOUGHT leg costs up front, +2% for the move before it fills: quantity x premium. MCX: lots x rupees per point per lot; NSE: units. */
export function boughtLegCost(l: { mcx: boolean; lots: number; lotUnits: number; unitsPerLot: number; premium: number }): number {
  return (l.mcx ? l.lots * l.unitsPerLot : l.lots * l.lotUnits) * l.premium * 1.02;
}

/**
 * The funds verdict: null when `margin + buyPremium` fits in what the account can spend on a short, else why not. Fail closed: an
 * unreadable funds figure or margin (null / not above 0) refuses. `name` is the broker's name for the message.
 */
export function marginVerdict(p: { funds: number | null; margin: number | null; buyPremium: number; name: string }): string | null {
  if (p.funds == null || !Number.isFinite(p.funds)) return `Could not read ${p.name} funds - entry refused (fail closed)`;
  if (p.margin == null || !(p.margin > 0)) return 'Could not read the margin for this entry - refused (fail closed)';
  const need = p.margin + p.buyPremium;
  return need > p.funds ? `Needs about ${inr(need)}, ${p.name} has ${inr(p.funds)} - entry refused` : null;
}
