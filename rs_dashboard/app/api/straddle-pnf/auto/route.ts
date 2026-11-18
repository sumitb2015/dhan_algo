import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyAutoOp, parseLedger, type AutoOp } from '@/lib/pnfAutoLedger';
import { parseScope } from '@/lib/pnfScope';
import { autoFileFor } from '@/lib/pnfAutoServer';
import { engineHeartbeat, readEngineFile, startPnfAutoEngine } from '@/lib/pnfAutoEngine';
import { serverGuardOf } from '@/lib/autoServerWatcher';
import { armNeedsGuardStop, guardStopProblem, NEEDS_STOP_TEXT } from '@/lib/pnfAutoSafety';

// The P&F AUTO ledger (debug/pnf_auto_state.json). GET returns it with the server AUTO engine's status (lib/pnfAutoEngine.ts, which
// trades the armed charts with every tab closed; started here too, idempotently); POST applies ONE op (lib/pnfAutoLedger.ts applyAutoOp)
// under a file lock, written atomically. The browser never writes the file whole. Places no orders. `?scope=renko` is the Renko
// page's own ledger (debug/renko_auto_state.json, lib/pnfScope.ts): its chart 1 / 2 never share a row with the P&F page's.

const fileFor = autoFileFor;

function read(file: string) {
  try { return parseLedger(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return parseLedger(null); }
}

const startEngine = () => { if (process.env.DASHBOARD_NO_BACKGROUND !== '1') startPnfAutoEngine(); };

export async function GET(req: NextRequest): Promise<NextResponse> {
  startEngine();
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  return NextResponse.json({ success: true, ledger: read(fileFor(scope)), engine: readEngineFile(scope), heartbeat: engineHeartbeat(), serverNow: Date.now() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  startEngine();
  let op: AutoOp;
  try { op = await req.json() as AutoOp; } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const FILE = fileFor(scope);
  // A REAL arming of a rule with no stop of its own needs the chart's MTM guard ON with a stop-loss on the SERVER (it is that rule's only loss
  // limit with the tab closed). Checked here, whichever tab or bundle sent it; the engine also disarms it if the guard goes later.
  // Read off the VALIDATED arm record (the ledger's own parser): a malformed one is left to applyAutoOp, which refuses it with a 400.
  const arm = op && op.op === 'setArm' && op.arm ? parseLedger({ arms: { '1': op.arm } }).arms?.['1'] : undefined;
  if (op && op.op === 'setArm' && arm && armNeedsGuardStop(scope, arm)) {
    const problem = guardStopProblem(serverGuardOf(scope, op.chart), { broker: arm.broker, mode: arm.mode, index: arm.run?.target.kind === 'index' });
    if (problem) return NextResponse.json({ success: false, error: `${NEEDS_STOP_TEXT} (${problem})`, ledger: read(FILE) }, { status: 422 });
  }
  try {
    return await withFileLock(`${FILE}.lock`, 5_000, scope === 'renko' ? 'Renko AUTO ledger' : 'P&F AUTO ledger', () => {
      const r = applyAutoOp(read(FILE), op);
      if (!r.ok) return NextResponse.json({ success: false, error: r.error, ledger: read(FILE) }, { status: r.status });
      writeJsonAtomic(FILE, r.ledger);
      return NextResponse.json({ success: true, ledger: r.ledger });
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 503 });
  }
}
