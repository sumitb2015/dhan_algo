import fs from 'fs';
import path from 'path';
import { isLive, parseLedger, type AutoLedger } from './pnfAutoLedger.ts';
import type { PnfScope } from './pnfScope.ts';

// The P&F / Renko AUTO ledger files (debug/pnf_auto_state.json, debug/renko_auto_state.json), read by the ledger route and by the
// order route, which keeps a close on one page from taking the quantity the OTHER page's AUTO holds on the same contract.

const DEBUG = path.join(path.resolve(process.cwd(), '..'), 'debug');
export const autoFileFor = (scope: PnfScope) => path.join(DEBUG, scope === 'renko' ? 'renko_auto_state.json' : 'pnf_auto_state.json');

export function readAutoLedger(scope: PnfScope): AutoLedger {
  try { return parseLedger(JSON.parse(fs.readFileSync(autoFileFor(scope), 'utf8'))); } catch { return parseLedger(null); }
}

/**
 * What a page's live REAL AUTO rows hold on `targetKey` at `broker`, per leg, signed (+ long, - short), in broker units. Every
 * row that is not closed counts (entering / exiting / unknown included): while its outcome is open its quantity is reserved.
 */
export function reservedByAuto(ledger: AutoLedger, broker: string, targetKey: string, legs: number): number[] {
  const out = new Array<number>(legs).fill(0);
  for (const r of ledger.rows) {
    if (!isLive(r) || r.mode !== 'REAL' || r.broker !== broker || r.targetKey !== targetKey) continue;
    const sign = r.side === 'BUY' ? 1 : -1;
    r.legs.forEach((l, i) => { if (i < legs) out[i] += sign * (Number(l.units) || 0); });
  }
  return out;
}
