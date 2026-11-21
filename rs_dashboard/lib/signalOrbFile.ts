import path from 'path';
import { readJsonFile } from '@/lib/lockedJsonFile';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { targetKey } from '@/lib/pnfTarget';
import { isLive, normalizeLedger, type OrbLedger } from '@/lib/signalOrbLedger';

// The Signal Orb ledger file, read-only helpers. Kept apart from lib/signalOrbServer.ts so the P&F / Renko order path
// (lib/pnfAutoOrders.ts) can keep the Orb's units out of its square-off without importing the Orb's order code (no cycle).

export const ORB_STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'signal_orb_state.json');

export const readOrbLedger = (): OrbLedger => normalizeLedger(readJsonFile(ORB_STATE_FILE));

/**
 * What the Orb's live REAL rows hold of a contract at `broker`, signed broker units (long +, short -). A P&F / Renko square-off of
 * the same contract keeps them, as it keeps the other page's AUTO. The Orb trades MIS only, so an NRML row is never reserved.
 */
export function reservedByOrb(broker: string, tKey: string, product: 'INTRADAY' | 'MARGIN', ledger: OrbLedger = readOrbLedger()): number {
  if (product !== 'INTRADAY') return 0;
  let out = 0;
  for (const r of ledger.rows) {
    if (!isLive(r) || r.mode !== 'REAL' || r.broker !== broker) continue;
    if (r.legs) {
      // a multi-leg row: each open leg holds its own units, signed by what opened it (BUY = long, SELL = short)
      for (const g of r.legs) if (g.status === 'open' && targetKey(g.target) === tKey) out += (g.action === 'BUY' ? 1 : -1) * (Number(g.units) || 0);
      continue;
    }
    if (targetKey(r.target) !== tKey) continue;
    // an options row is always a SOLD option (short at the broker) whatever its signal side; a futures row follows its side
    const sign = r.target.kind === 'options' ? -1 : r.side === 'LONG' ? 1 : -1;
    out += sign * (Number(r.units) || 0);
  }
  return out;
}
