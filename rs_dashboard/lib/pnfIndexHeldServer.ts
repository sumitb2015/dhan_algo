import fs from 'fs';
import path from 'path';
import { parseHeld, type HeldLedger } from '@/lib/pnfIndexHeld';
import { PROJECT_ROOT } from '@/lib/pyExec';
import type { PnfScope } from '@/lib/pnfScope';

// The index charts' held-option ledger files (lib/pnfIndexHeld.ts): debug/renko_index_held.json and debug/pnf_index_held.json. Read by the
// ledger route and by the order route, whose whole-contract close keeps the units an index chart holds of that contract.

export const indexHeldFileFor = (scope: PnfScope) => path.join(PROJECT_ROOT, 'debug', scope === 'renko' ? 'renko_index_held.json' : 'pnf_index_held.json');

export function readIndexHeld(scope: PnfScope): HeldLedger {
  try { return parseHeld(JSON.parse(fs.readFileSync(indexHeldFileFor(scope), 'utf8'))); } catch { return parseHeld(null); }
}
