// Bracket / Cover for the P&F page (the Price Ladder's Style: Single | Bracket | Cover), held by the page. An entry that fills
// gets exit levels at fixed POINTS from its fill price (points of the chart's own price: a futures price, an option premium, or a
// straddle's combined premium): Bracket = stop-loss + target, Cover = stop-loss only, Single = nothing. Optional trailing moves
// the stop with the price. Pure (tested in lib/pnfBracket.test.ts); the rows live in the resting ledger (lib/pnfRestingLedger.ts).
import { snapToTick } from './pnfResting.ts';
import type { RestingKind, RestingSide } from './pnfResting.ts';

export type OrderStyle = 'Single' | 'Bracket' | 'Cover';
export interface BracketSpec { style: 'Bracket' | 'Cover'; tgtPts: number; slPts: number; trailPts?: number }

/** The style's inputs as a spec: null for Single, an error string for a missing / invalid number (nothing is guessed). */
export function cleanBracketSpec(style: OrderStyle, tgtPts: unknown, slPts: unknown, trailPts?: unknown): BracketSpec | null | string {
  if (style === 'Single') return null;
  const sl = Number(slPts);
  if (!(sl > 0) || !Number.isFinite(sl)) return 'Set the stop-loss points (a positive number) for a Bracket / Cover order';
  let tgt = 0;
  if (style === 'Bracket') {
    tgt = Number(tgtPts);
    if (!(tgt > 0) || !Number.isFinite(tgt)) return 'Set the target points (a positive number) for a Bracket order';
  }
  const spec: BracketSpec = { style, tgtPts: tgt, slPts: sl };
  // undefined = the Trail box is not ticked. Ticked but blank / zero is refused, never silently dropped.
  if (trailPts !== undefined && trailPts !== null) {
    const t = Number(trailPts);
    if (!(t > 0) || !Number.isFinite(t)) return 'Trail points must be a positive number';
    spec.trailPts = t;
  }
  return spec;
}

export interface BracketChild {
  role: 'sl' | 'target';
  /** The exit's side: opposite the entry. */
  side: RestingSide;
  kind: RestingKind;
  /** Where the line is drawn (the stop's trigger, or the target). */
  level: number;
  trigger?: number;
  /** A page-held exit fires at MARKET; this is the limit the paper simulation allows (wide enough never to block a stop). */
  price: number;
  trailPts?: number;
}

/**
 * The exits for an entry that filled at `entry`. A LONG entry stops below and targets above; a SHORT the mirror. Levels are
 * snapped to `tick` (a stop away from the entry, a target toward it never pays a worse price than asked). Refuses a level that
 * is not positive (a stop wider than the price).
 */
export function planBracketChildren(p: { side: RestingSide; entry: number; tick: number; spec: BracketSpec }): BracketChild[] | string {
  const { side, entry, tick, spec } = p;
  if (!(entry > 0)) return 'No entry price';
  const long = side === 'BUY';
  const exit: RestingSide = long ? 'SELL' : 'BUY';
  const slLevel = snapToTick(long ? entry - spec.slPts : entry + spec.slPts, tick, long ? 'down' : 'up');
  if (!(slLevel > 0)) return `A stop ${spec.slPts} points from ${entry} is not a valid price`;
  const out: BracketChild[] = [{
    role: 'sl', side: exit, kind: 'stop', level: slLevel, trigger: slLevel,
    price: long ? Math.max(tick, slLevel * 0.01) : slLevel * 2,
    // A trail tighter than the stop would pull the stop up to the price on the first tick: it never trails closer than the SL distance.
    ...(spec.trailPts ? { trailPts: Math.max(spec.trailPts, spec.slPts) } : {}),
  }];
  if (spec.style === 'Bracket') {
    const tgt = snapToTick(long ? entry + spec.tgtPts : entry - spec.tgtPts, tick, long ? 'down' : 'up');
    if (!(tgt > 0)) return `A target ${spec.tgtPts} points from ${entry} is not a valid price`;
    out.push({ role: 'target', side: exit, kind: 'limit', level: tgt, price: tgt });
  }
  return out;
}

/** The stop a trailing stop moves to as the price improves, or null when it should not move (only ever in the profit direction). */
export function trailedStop(p: { exitSide: RestingSide; trigger: number; price: number; trailPts: number; tick: number }): number | null {
  const { exitSide, trigger, price, trailPts, tick } = p;
  if (!(price > 0) || !(trailPts > 0)) return null;
  const sellStop = exitSide === 'SELL';                         // closing a long: the stop sits below and only rises
  const next = snapToTick(sellStop ? price - trailPts : price + trailPts, tick, sellStop ? 'down' : 'up');
  if (!(next > 0)) return null;
  return sellStop ? (next > trigger + tick / 2 ? next : null) : (next < trigger - tick / 2 ? next : null);
}
