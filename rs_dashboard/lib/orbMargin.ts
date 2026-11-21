import { dhanPost } from '@/lib/dhanToken';
import { availableFunds } from '@/lib/priceLadderServer';
import { fetchNettedMargin, pacedMarginCall } from '@/lib/ultimateScannerDhan';
import { resolvePnfLegs } from '@/lib/pnfOrderServer';
import type { Target } from '@/lib/pnfTarget';

// The Signal Orb's funds gate for a structure with a short leg, fail closed: an unreadable figure refuses the entry. REAL on Dhan only.
// Cash needed = the margin of the shorts (NSE: Dhan's netted basket margin, so a bought leg's hedge credit counts; MCX: each short's
// own margin, no hedge credit - as the Price Ladder baskets do) plus the premium of every bought leg (+2%). Read-only: it places nothing.

export interface MarginLegIn {
  target: Target;
  action: 'BUY' | 'SELL';
  lots: number;
  /** The broker's units per lot (Dhan: the master lot on NSE, 1 on MCX where quantity is in lots). */
  lotUnits: number;
  /** Rupees per point per lot, for the premium a bought leg costs. */
  unitsPerLot: number;
  /** The leg's live premium. */
  premium: number;
}

const inr = (n: number) => `₹${Math.round(n).toLocaleString('en-IN')}`;

/** Why the entry must be refused for want of funds / margin, or null when it fits. */
export async function orbMarginBlock(legs: MarginLegIn[]): Promise<string | null> {
  const sells = legs.filter(l => l.action === 'SELL');
  if (!sells.length) return null;
  const funds = await availableFunds('dhan');
  if (funds == null) return 'Could not read Dhan funds - entry refused (fail closed)';
  const resolved = legs.map(l => { const r = resolvePnfLegs(l.target); return { l, leg: typeof r === 'string' ? null : r[0] ?? null }; });
  if (resolved.some(x => !x.leg)) return 'Could not resolve a leg for the margin check - entry refused (fail closed)';
  const mcx = (x: typeof resolved[number]) => x.leg!.segment === 'MCX_COMM';
  const buyPremium = resolved.filter(x => x.l.action === 'BUY')
    .reduce((a, x) => a + (mcx(x) ? x.l.lots * x.l.unitsPerLot : x.l.lots * x.l.lotUnits) * x.l.premium * 1.02, 0);
  let margin: number | null = 0;
  if (resolved.some(x => x.l.action === 'SELL' && !mcx(x))) {
    margin = await fetchNettedMargin(legs[0].target.symbol, resolved.map(x => ({ side: x.l.action, securityId: x.leg!.securityId, quantity: x.l.lots * x.l.lotUnits })));
  } else {
    const each = await Promise.all(resolved.filter(x => x.l.action === 'SELL').map(async x => {
      try {
        const r = await pacedMarginCall(() => dhanPost('/margincalculator', {
          securityId: x.leg!.securityId, exchangeSegment: x.leg!.segment, transactionType: 'SELL', quantity: x.l.lots,
          productType: 'INTRADAY', price: x.l.premium,
        })) as Record<string, unknown>;
        const m = Number(r?.totalMargin ?? 0);
        return m > 0 ? m : null;
      } catch { return null; }
    }));
    margin = each.every(v => v != null) ? each.reduce<number>((a, v) => a + (v as number), 0) : null;
  }
  if (margin == null || !(margin > 0)) return 'Could not read the margin for this entry - refused (fail closed)';
  const need = margin + buyPremium;
  return need > funds.sell ? `Needs about ${inr(need)}, Dhan has ${inr(funds.sell)} - entry refused` : null;
}
