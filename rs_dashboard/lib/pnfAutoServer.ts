import fs from 'fs';
import path from 'path';
import { applyAutoOp, closingSide, isLive, parseLedger, pendingAddUnits, type AutoLedger, type AutoOp } from './pnfAutoLedger.ts';
import { withFileLock, writeJsonAtomic } from './lockedJsonFile.ts';
import type { PnfScope } from './pnfScope.ts';
import { autoProductOf, type AutoProduct } from './pnfOrderLogic.ts';
import { readIndexHeld } from './pnfIndexHeldServer.ts';
import { targetKey as keyOfTarget } from './pnfTarget.ts';

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
 * `exceptChart`: leave that chart's rows out (this page's own ledger, read for the OTHER chart when chart N's MTM guard closes).
 */
export function reservedByAuto(ledger: AutoLedger, broker: string, targetKey: string, legs: number, exceptChart?: 1 | 2, product: AutoProduct = 'INTRADAY'): number[] {
  const out = new Array<number>(legs).fill(0);
  for (const r of ledger.rows) {
    // an index chart's row holds its OPTION, not the chart's contract: it is kept per leg by reservedByAutoTraded instead
    if (!isLive(r) || r.mode !== 'REAL' || r.broker !== broker || r.traded || r.targetKey !== targetKey) continue;
    if (autoProductOf(r.product) !== product) continue;   // each product's broker row keeps its own rows' units
    if (exceptChart !== undefined && r.chart === exceptChart) continue;       // the guarding chart's own row: it is the one being closed
    const sign = r.side === 'BUY' ? 1 : -1;
    // a pyramid add whose outcome is open may be live at the broker: its units are reserved too
    const pend = pendingAddUnits(r);
    r.legs.forEach((l, i) => { if (i < legs) out[i] += sign * ((Number(l.units) || 0) + (pend[i] || 0)); });
  }
  return out;
}

/**
 * What a page's live REAL AUTO rows on an INDEX chart hold of ONE option contract (`legKey`, a single CE / PE target key), signed, in broker
 * units: a whole-contract close of that option (or of a straddle that has it as a leg) keeps it, like the index charts' manual held option.
 */
export function reservedByAutoTraded(ledger: AutoLedger, broker: string, legKey: string, product: AutoProduct = 'INTRADAY'): number {
  let out = 0;
  for (const r of ledger.rows) {
    if (!isLive(r) || r.mode !== 'REAL' || r.broker !== broker || r.traded?.targetKey !== legKey || autoProductOf(r.product) !== product) continue;
    out += (r.traded.action === 'BUY' ? 1 : -1) * (Number(r.legs[0]?.units) || 0);
  }
  return out;
}

/**
 * The product of the AUTO row an `exitOwn` order is closing, read from the ledger, never from the request: the REAL rows reserved for an
 * exit (`exiting`) on this broker and contract whose closing side is `side`. null when there is none, or when such rows disagree (the
 * request's own product is used then). A tab still running an older bundle sends no product, and would otherwise exit an NRML row as MIS.
 */
export function exitingAutoProduct(ledger: AutoLedger, broker: string, targetKey: string, side: 'BUY' | 'SELL'): AutoProduct | null {
  // matched on the contract the row TRADES (an index chart's row: its option, on the option's own side)
  const products = new Set(ledger.rows
    .filter(r => r.mode === 'REAL' && r.state === 'exiting' && r.broker === broker && (r.traded?.targetKey ?? r.targetKey) === targetKey
      && closingSide(r) === side)
    .map(r => autoProductOf(r.product)));
  return products.size === 1 ? [...products][0] : null;
}

/**
 * One ledger op applied under the same file lock and atomic write as the ledger route (so the server watcher and a page can never
 * overwrite each other; whoever takes a row's `beginExit` first owns that exit). Returns the op's own result.
 */
export async function applyAutoLedgerOp(scope: PnfScope, op: AutoOp): Promise<{ ok: true } | { ok: false; error: string }> {
  const file = autoFileFor(scope);
  try {
    return await withFileLock(`${file}.lock`, 5_000, scope === 'renko' ? 'Renko AUTO ledger' : 'P&F AUTO ledger', () => {
      // A REAL option row on an index chart must not net against the OTHER ledger: the manual held option (renko_index_held.json) on the same
      // option at the same broker, in the opposite direction, would be netted into one broker position that neither side's exit can size.
      if (op.op === 'open' && op.row.mode === 'REAL' && op.row.traded) {
        const t = op.row.traded;
        const against = readIndexHeld(scope).rows.find(h => h.broker === op.row.broker && keyOfTarget(h.traded) === t.targetKey && h.action !== t.action && (h.units > 0 || h.pending !== 0));
        if (against) return { ok: false as const, error: `Chart ${against.chart} holds a manual ${against.action} on this option: an opposite AUTO position would net against it at the broker` };
      }
      const r = applyAutoOp(readAutoLedger(scope), op);
      if (!r.ok) return { ok: false as const, error: r.error };
      writeJsonAtomic(file, r.ledger);
      return { ok: true as const };
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
