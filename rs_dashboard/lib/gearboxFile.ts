import path from 'path';
import { readJsonFile } from './lockedJsonFile.ts';
import { PROJECT_ROOT } from './pyExec.ts';
import { targetKey } from './pnfTarget.ts';
import { normalizeLedger, reservedUnits, type GbLedger } from './gearboxLedger.ts';

// The Gearbox ledger file, read-only helpers. Kept apart from the server so the shared P&F order layer can keep Gearbox's
// units out of its square-off without importing Gearbox's order code (no cycle). Relative imports only, so the server core
// (lib/gearboxCore.ts) can load this under `node --test`.

export const GB_STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'gearbox_state.json');

const where = { file: GB_STATE_FILE };
/** The ledger file in use: GB_STATE_FILE, unless a test pointed it at a temp dir. */
export const gbStateFile = (): string => where.file;
/** TESTS ONLY: point the ledger at a temp file so a test never touches debug/gearbox_state.json. */
export function setGbStateFileForTests(file: string): void { where.file = file; }

export const readGbLedger = (): GbLedger => normalizeLedger(readJsonFile(gbStateFile()));

/** Signed broker units held by live REAL rows of a contract at `broker` (BUY +, SELL -). Gearbox trades INTRADAY only: MARGIN is 0. */
export function reservedByGearbox(broker: string, tKey: string, product: 'INTRADAY' | 'MARGIN', ledger: GbLedger = readGbLedger()): number {
  if (product !== 'INTRADAY') return 0;
  return reservedUnits(ledger, broker, tKey, targetKey);
}
