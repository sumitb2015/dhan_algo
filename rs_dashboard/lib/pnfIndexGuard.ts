// The MTM guard of a Renko INDEX chart (an index chart trades the CE / PE of its bull / bear map, lib/pnfIndexMap.ts). The guard reads
// the chart's own option P&L: AUTO's option row (lib/pnfAutoLedger.ts `traded`, its own entry premium) plus the units THIS chart opened
// by hand from the trade bar / Scalper (the held-option ledger, lib/pnfIndexHeld.ts), marked on the chart's own shadow position - never a
// book the other chart, another page or a strategy shares, so the two charts' guards never move each other. Its levels are rupees only: a chart box is an INDEX move, not a move of the option's premium. Pure (lib/pnfIndexGuard.test.ts).
import type { LadderPosition } from './pnfLadderPosition.ts';
import { applyPaperFill, FLAT_LEG, paperPnl, type PaperLeg } from './pnfOrderLogic.ts';
import type { LadderGuard } from './priceLadderGuard.ts';

/** One source of the chart's position: `lots` > 0, `pnl` null when it cannot be priced right now (never a made-up 0). */
export interface IndexLeg { side: 'LONG' | 'SHORT'; lots: number; pnl: number | null; /** P&L at entry, when it is known (an AUTO row: 0). */ entryPnl?: number }

/** AUTO's open option row: priced on the option's live premium against its entry premium. */
export function autoIndexLeg(row: { lots: number; traded?: { action: 'BUY' | 'SELL' } }, pnl: number | null): IndexLeg | null {
  if (!row.traded || !(row.lots > 0)) return null;
  return { side: row.traded.action === 'BUY' ? 'LONG' : 'SHORT', lots: row.lots, pnl, entryPnl: 0 };
}

/**
 * The units this chart holds by hand, marked on THIS chart alone: a shadow position that changes only when the chart's own held units change
 * (each change filled at the option's live premium) and is priced on that premium. Never the option's paper book or broker row: both
 * charts can hold the same strike (and another page too), and a shared book's average, lots and realised P&L would let one chart's trade
 * move the other chart's MTM. `null` = flat. An unpriced change keeps the previous mark until a premium arrives.
 */
export interface OwnMark { id: string; leg: PaperLeg }
export function stepOwnMark(prev: OwnMark | null, held: { id: string; action: 'BUY' | 'SELL'; units: number } | null,
  perLot: number | null, ltp: number | null, unitsPerLot: number | null): OwnMark | null {
  if (!held || !(held.units > 0)) return null;
  const priced = ltp != null && ltp > 0 && !!perLot && perLot > 0 && !!unitsPerLot && unitsPerLot > 0;
  const base = prev && prev.id === held.id ? prev : null;
  if (!priced) return base;
  const lots = (held.units / perLot!) * (held.action === 'BUY' ? 1 : -1);
  const leg = base?.leg ?? FLAT_LEG;
  if (leg.lots === lots && base) return base;
  return { id: held.id, leg: applyPaperFill(leg, lots - leg.lots, ltp!, unitsPerLot!) };
}

/** The hand-held part of the chart's position from its own mark (null when flat or never priced yet). */
export function ownMarkLeg(mark: OwnMark | null, ltp: number | null, unitsPerLot: number | null): IndexLeg | null {
  if (!mark || mark.leg.lots === 0) return null;
  const priced = ltp != null && ltp > 0 && !!unitsPerLot && unitsPerLot > 0;
  return { side: mark.leg.lots > 0 ? 'LONG' : 'SHORT', lots: Math.abs(mark.leg.lots), pnl: priced ? paperPnl([mark.leg], [ltp], [unitsPerLot!]) : null };
}

/** The chart's guard position: AUTO's row and the hand-held units together (null = flat). Opposite sides are MIXED; P&L is null unless every part is priced. */
export function indexGuardPosition(auto: IndexLeg | null, held: IndexLeg | null): LadderPosition | null {
  const parts = [auto, held].filter((x): x is IndexLeg => x !== null);
  if (parts.length === 0) return null;
  const side = parts.every(p => p.side === parts[0].side) ? parts[0].side : 'MIXED';
  const pnl = parts.some(p => p.pnl === null) ? null : parts.reduce((s, p) => s + (p.pnl as number), 0);
  // only an AUTO-only position knows its P&L at entry (0); anything held by hand is measured from when the guard first sees it priced
  return { side, lots: parts.reduce((s, p) => s + p.lots, 0), avg: null, pnl, ...(parts.length === 1 && parts[0].entryPnl !== undefined ? { entryPnl: parts[0].entryPnl } : {}) };
}

/** An index chart's guard keeps no box levels: they would be read as index boxes on an option's P&L. */
export function rupeeLevels(g: LadderGuard): LadderGuard {
  if (g.targetBoxes === undefined && g.stopBoxes === undefined) return g;
  const { targetBoxes: _t, stopBoxes: _s, ...rest } = g;
  void _t; void _s;
  return rest;
}
