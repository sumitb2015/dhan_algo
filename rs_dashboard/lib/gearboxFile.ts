import fs from 'fs';
import path from 'path';
import { readJsonFile } from './lockedJsonFile.ts';
import { PROJECT_ROOT } from './pyExec.ts';
import { targetKey, type Target } from './pnfTarget.ts';
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

/** The ledger for readers (a missing or unreadable file reads as empty). The server's writers use readGbLedgerForWrite. */
export const readGbLedger = (): GbLedger => normalizeLedger(readJsonFile(gbStateFile()));

export const GB_UNREADABLE = 'gearbox ledger unreadable — fix debug/gearbox_state.json';

/**
 * The ledger for a server op that may write it: null when the file EXISTS but does not parse as a JSON object. Reading that as
 * empty and saving would overwrite live rows, so every trade / op refuses instead (and the square-off skips). Missing = empty.
 */
export function readGbLedgerForWrite(): GbLedger | null {
  let raw: string;
  try { raw = fs.readFileSync(gbStateFile(), 'utf8'); } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? normalizeLedger(null) : null;
  }
  try {
    const v: unknown = JSON.parse(raw);
    return v && typeof v === 'object' && !Array.isArray(v) ? normalizeLedger(v) : null;
  } catch { return null; }
}

/** Signed broker units held by live REAL rows of a contract at `broker` (BUY +, SELL -). Gearbox trades INTRADAY only: MARGIN is 0. */
export function reservedByGearbox(broker: string, tKey: string, product: 'INTRADAY' | 'MARGIN', ledger?: GbLedger): number {
  if (product !== 'INTRADAY') return 0;
  // Called from the shared P&F / Renko close path: a bad Gearbox row must never break another page's close.
  try { return reservedUnits(ledger ?? readGbLedger(), broker, tKey, targetKey); } catch (e) {
    console.warn('[gearbox] reservedByGearbox failed, keeping 0 units back:', e instanceof Error ? e.message : e);
    return 0;
  }
}

/**
 * Gearbox's live REAL FUT-leg units on a FUTURES chart's contract (0 for any other chart): the P&F / Renko close's `fromOther` keeps
 * them. Option rows are not counted here; the close keeps those per option leg (optionLegKeys), so nothing is held back twice.
 */
export function reservedByGearboxFuture(broker: string, target: Target, product: 'INTRADAY' | 'MARGIN', ledger?: GbLedger): number {
  return target.kind === 'futures' ? reservedByGearbox(broker, targetKey(target), product, ledger) : 0;
}
