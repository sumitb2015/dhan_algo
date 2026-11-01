import fs from 'fs';
import { NextRequest, NextResponse } from 'next/server';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyAutoOp, parseLedger, type AutoOp } from '@/lib/pnfAutoLedger';
import { parseScope } from '@/lib/pnfScope';
import { autoFileFor } from '@/lib/pnfAutoServer';

// The P&F AUTO ledger (debug/pnf_auto_state.json). GET returns it; POST applies ONE op (lib/pnfAutoLedger.ts applyAutoOp)
// under a file lock, written atomically. The browser never writes the file whole. Places no orders. `?scope=renko` is the Renko
// page's own ledger (debug/renko_auto_state.json, lib/pnfScope.ts): its chart 1 / 2 never share a row with the P&F page's.

const fileFor = autoFileFor;

function read(file: string) {
  try { return parseLedger(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return parseLedger(null); }
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ success: true, ledger: read(fileFor(parseScope(req.nextUrl.searchParams.get('scope')))) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let op: AutoOp;
  try { op = await req.json() as AutoOp; } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const FILE = fileFor(scope);
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
