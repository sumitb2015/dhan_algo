// Signal Orb entry filters (optional, off by default). Pure: the browser engine asks them before it sends an entry or a
// reversal; lib/orbFilters.test.ts runs them under `node --test` (relative imports only).
//  - Higher-timeframe confirm: the indicators' own consensus on a higher timeframe must be the entry's colour.
//  - Pivot guard: no LONG with a CPR / R / S level within N points ABOVE the price (it would buy into resistance), no SHORT with
//    one within N points BELOW (selling into support). Levels: classic pivots from the previous session (lib/pivotLevels.ts).
// A filter only ever stops a NEW position. It never holds one against the signal: a blocked reversal exits to flat instead.

import type { PivotSet } from './pivotLevels.ts';
import type { Side, Signal, Timeframe } from './signalOrb.ts';

export interface FilterInput {
  side: Side;
  /** The trading timeframe and the confirm timeframe (0 = filter off). */
  tf: Timeframe;
  htfConfirm: number;
  /** The orb's consensus on the confirm timeframe from closed bars; null = not computed yet. */
  htfSignal: Signal | null;
  /** Points; 0 = filter off. */
  levelGuardPts: number;
  price: number;
  pivots: PivotSet | null;
}

const PIVOT_LABEL: Record<keyof PivotSet, string> = {
  p: 'P', tc: 'TC', bc: 'BC', r1: 'R1', r2: 'R2', r3: 'R3', r4: 'R4', s1: 'S1', s2: 'S2', s3: 'S3', s4: 'S4',
};

const tfName = (tf: number) => (tf === 60 ? '1h' : `${tf}m`);

/** Why this entry is filtered out, or null when every enabled filter lets it through. */
export function entryFilter(i: FilterInput): string | null {
  if (i.htfConfirm > 0 && i.htfConfirm > i.tf) {
    const want = i.side === 'LONG' ? 'BULL' : 'BEAR';
    if (i.htfSignal === null) return `${tfName(i.htfConfirm)} confirmation not ready yet`;
    if (i.htfSignal !== want) return `${tfName(i.htfConfirm)} is ${i.htfSignal}, not ${want}`;
  }
  if (i.levelGuardPts > 0 && i.pivots && i.price > 0) {
    let near: { label: string; price: number; dist: number } | null = null;
    for (const k of Object.keys(PIVOT_LABEL) as (keyof PivotSet)[]) {
      const lv = i.pivots[k];
      if (!(lv > 0)) continue;
      const dist = i.side === 'LONG' ? lv - i.price : i.price - lv;   // how far the level is AHEAD of the trade
      if (dist > 0 && dist <= i.levelGuardPts && (!near || dist < near.dist)) near = { label: PIVOT_LABEL[k], price: lv, dist };
    }
    if (near) return `${near.label} ${near.price.toLocaleString('en-IN')} is ${near.dist.toFixed(1)} pts ${i.side === 'LONG' ? 'above' : 'below'} - no ${i.side} into it`;
  }
  return null;
}
