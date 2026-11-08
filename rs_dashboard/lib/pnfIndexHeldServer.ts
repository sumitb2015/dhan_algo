import fs from 'fs';
import path from 'path';
import { parseHeld, type HeldLedger } from './pnfIndexHeld.ts';
import { PROJECT_ROOT } from './pyExec.ts';
import type { PnfScope } from './pnfScope.ts';

// The index charts' held-option ledger files (lib/pnfIndexHeld.ts): debug/renko_index_held.json and debug/pnf_index_held.json. Read by the
// ledger route and by the order route, whose whole-contract close keeps the units an index chart holds of that contract.

export const indexHeldFileFor = (scope: PnfScope) => path.join(PROJECT_ROOT, 'debug', scope === 'renko' ? 'renko_index_held.json' : 'pnf_index_held.json');

export function readIndexHeld(scope: PnfScope): HeldLedger {
  try { return parseHeld(JSON.parse(fs.readFileSync(indexHeldFileFor(scope), 'utf8'))); } catch { return parseHeld(null); }
}
