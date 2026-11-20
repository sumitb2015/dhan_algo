import path from 'path';
import { readJsonFile } from '@/lib/lockedJsonFile';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { targetKey } from '@/lib/pnfTarget';
import { normalizeLedger, reservedUnits, type GbLedger } from '@/lib/gearboxLedger';

// The Gearbox ledger file, read-only helpers. Kept apart from the server so the shared P&F order layer can keep Gearbox's
// units out of its square-off without importing Gearbox's order code (no cycle).

export const GB_STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'gearbox_state.json');

export const readGbLedger = (): GbLedger => normalizeLedger(readJsonFile(GB_STATE_FILE));

/** Signed broker units held by live REAL rows of a contract at `broker` (BUY +, SELL -). Gearbox trades INTRADAY only: MARGIN is 0. */
export function reservedByGearbox(broker: string, tKey: string, product: 'INTRADAY' | 'MARGIN', ledger: GbLedger = readGbLedger()): number {
  if (product !== 'INTRADAY') return 0;
  return reservedUnits(ledger, broker, tKey, targetKey);
}
