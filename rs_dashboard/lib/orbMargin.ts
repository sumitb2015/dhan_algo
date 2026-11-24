import { dhanPost } from '@/lib/dhanToken';
import { availableFunds } from '@/lib/priceLadderServer';
import { fetchNettedMargin, pacedMarginCall } from '@/lib/ultimateScannerDhan';
import { resolvePnfLegs } from '@/lib/pnfOrderServer';
import type { Target } from '@/lib/pnfTarget';
import { boughtLegCost, marginVerdict } from '@/lib/orbMarginMath';

// The Signal Orb's funds gate for an entry that blocks margin (a short option leg, or a future either way), fail closed: an unreadable figure refuses the entry. REAL on Dhan or Kotak: the margin is the exchange's (Dhan's calculator, the same on every
// broker), compared with the chosen broker's own funds.
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
  /** The leg's live premium (a future: its price). */
  premium: number;
}

/** Why the entry must be refused for want of funds / margin, or null when it fits. */
export async function orbMarginBlock(broker: 'dhan' | 'kotak' | 'zerodha', legs: MarginLegIn[]): Promise<string | null> {
  const name = broker === 'kotak' ? 'Kotak' : broker === 'zerodha' ? 'Zerodha' : 'Dhan';
  // what blocks margin: a sold option, or a future bought OR sold (a bought option only costs its premium, below)
  const blocks = (l: MarginLegIn) => l.action === 'SELL' || l.target.kind === 'futures';
  if (!legs.some(blocks)) return null;
  const funds = await availableFunds(broker);
  if (funds == null) return marginVerdict({ funds: null, margin: 0, buyPremium: 0, name });
  const resolved = legs.map(l => { const r = resolvePnfLegs(l.target); return { l, leg: typeof r === 'string' ? null : r[0] ?? null }; });
  if (resolved.some(x => !x.leg)) return 'Could not resolve a leg for the margin check - entry refused (fail closed)';
  const mcx = (x: typeof resolved[number]) => x.leg!.segment === 'MCX_COMM';
  const buyPremium = resolved.filter(x => x.l.action === 'BUY' && x.l.target.kind !== 'futures').reduce((a, x) => a + boughtLegCost({ mcx: mcx(x), ...x.l }), 0);
  let margin: number | null = 0;
  if (resolved.some(x => blocks(x.l) && !mcx(x))) {
    margin = await fetchNettedMargin(legs[0].target.symbol, resolved.map(x => ({ side: x.l.action, securityId: x.leg!.securityId, quantity: x.l.lots * x.l.lotUnits })));
  } else {
    const each = await Promise.all(resolved.filter(x => blocks(x.l)).map(async x => {
      try {
        const r = await pacedMarginCall(() => dhanPost('/margincalculator', {
          securityId: x.leg!.securityId, exchangeSegment: x.leg!.segment, transactionType: x.l.action, quantity: x.l.lots,
          productType: 'INTRADAY', price: x.l.premium,
        })) as Record<string, unknown>;
        const m = Number(r?.totalMargin ?? 0);
        return m > 0 ? m : null;
      } catch { return null; }
    }));
    margin = each.every(v => v != null) ? each.reduce<number>((a, v) => a + (v as number), 0) : null;
  }
  return marginVerdict({ funds: funds.sell, margin, buyPremium, name });
}
