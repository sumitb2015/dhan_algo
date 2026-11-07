import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyHeldOp, parseHeld, type HeldLedger, type HeldOp } from '@/lib/pnfIndexHeld';
import { parseScope, type PnfScope } from '@/lib/pnfScope';
import { PROJECT_ROOT } from '@/lib/pyExec';

// Which option each REAL index chart holds (lib/pnfIndexHeld.ts): debug/renko_index_held.json (or pnf_index_held.json for the P&F page).
// GET returns the ledger; POST applies ONE op under a file lock, written atomically. Places no orders.

const fileFor = (scope: PnfScope) => path.join(PROJECT_ROOT, 'debug', scope === 'renko' ? 'renko_index_held.json' : 'pnf_index_held.json');

function read(scope: PnfScope): HeldLedger {
  try { return parseHeld(JSON.parse(fs.readFileSync(fileFor(scope), 'utf8'))); } catch { return parseHeld(null); }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ success: true, ledger: read(parseScope(req.nextUrl.searchParams.get('scope'))) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let op: HeldOp;
  try { op = await req.json() as HeldOp; } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const FILE = fileFor(scope);
  try {
    return await withFileLock(`${FILE}.lock`, 5_000, 'index held-option ledger', () => {
      const led = read(scope);
      const r = applyHeldOp(led, { ...op, now: Math.floor(Date.now() / 1000) } as HeldOp);
      if (!r.ok) return NextResponse.json({ success: false, error: r.error, ledger: led }, { status: r.status });
      if (r.ledger !== led) writeJsonAtomic(FILE, r.ledger);
      return NextResponse.json({ success: true, ledger: r.ledger, row: r.row ?? null });
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 503 });
  }
}
