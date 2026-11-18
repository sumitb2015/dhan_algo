// The entry lines of a Renko INDEX chart's option positions (an index chart trades the CE / PE of its bull / bear map, lib/pnfIndexMap.ts).
// The chart is the index, so the line sits at the INDEX level the position was entered at (AUTO's decision price / the hand entry's spot),
// while its tag tells the option held, its premium and its live P&L. Display only: an index chart has no rail to act on a line.
// Pure (lib/pnfIndexLines.test.ts).
import type { IndexLeg } from './pnfIndexGuard.ts';

export interface IndexEntryLine {
  key: string;
  /** The index level of the entry: where the line is drawn. */
  y: number;
  side: 'LONG' | 'SHORT';
  text: string;
  /** Rupees; null when the option cannot be priced right now (never a made-up 0). */
  pnl: number | null;
}

interface OptTarget { strike?: number; side?: string }

export function indexEntryLines(o: {
  /** The chart's open AUTO option row (lib/pnfAutoLedger.ts), or null. */
  auto: { id: string; entryPrice: number; lots: number; mode: string; entryFilled?: boolean; traded?: { action: 'BUY' | 'SELL'; target: OptTarget; entryPremium: number } } | null;
  autoPnl: number | null;
  /** The option this chart holds by hand (lib/pnfIndexHeld.ts) and its own mark (lib/pnfIndexGuard.ts ownMarkLeg). */
  held: { id: string; entryY?: number; action: 'BUY' | 'SELL'; traded: OptTarget } | null;
  heldLeg: IndexLeg | null;
  /** The mark's average premium (the live premium when the chart first saw the units: an estimate, shown with ~). */
  heldAvg: number | null;
}): IndexEntryLine[] {
  const out: IndexEntryLine[] = [];
  const opt = (t: OptTarget) => `${t.strike ?? ''} ${t.side ?? ''}`.trim();
  const a = o.auto;
  if (a && a.traded && a.lots > 0 && a.entryPrice > 0) {
    const est = a.mode === 'REAL' && !a.entryFilled ? '~' : '';
    out.push({
      key: `auto:${a.id}`, y: a.entryPrice, side: a.traded.action === 'BUY' ? 'LONG' : 'SHORT', pnl: o.autoPnl,
      text: `AUTO ${a.traded.action} ${a.lots}L ${opt(a.traded.target)} @ ${est}${a.traded.entryPremium.toFixed(2)}`,
    });
  }
  const h = o.held, l = o.heldLeg;
  if (h && l && h.entryY != null && h.entryY > 0) {
    const lots = Number.isInteger(l.lots) ? String(l.lots) : l.lots.toFixed(2);
    out.push({
      key: `held:${h.id}`, y: h.entryY, side: l.side, pnl: l.pnl,
      text: `${h.action} ${lots}L ${opt(h.traded)}${o.heldAvg != null && o.heldAvg > 0 ? ` @ ~${o.heldAvg.toFixed(2)}` : ''}`,
    });
  }
  return out;
}
