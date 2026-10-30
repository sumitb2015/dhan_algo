import fs from 'fs';
import path from 'path';
import { NextRequest, NextResponse } from 'next/server';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyAutoOp, parseLedger, type AutoOp } from '@/lib/pnfAutoLedger';

// The P&F AUTO ledger (debug/pnf_auto_state.json). GET returns it; POST applies ONE op (lib/pnfAutoLedger.ts applyAutoOp)
// under a file lock, written atomically. The browser never writes the file whole. Places no orders.

const FILE = path.join(path.resolve(process.cwd(), '..'), 'debug', 'pnf_auto_state.json');
const LOCK = `${FILE}.lock`;

function read() {
  try { return parseLedger(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return parseLedger(null); }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ success: true, ledger: read() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let op: AutoOp;
  try { op = await req.json() as AutoOp; } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  try {
    return await withFileLock(LOCK, 5_000, 'P&F AUTO ledger', () => {
      const r = applyAutoOp(read(), op);
      if (!r.ok) return NextResponse.json({ success: false, error: r.error, ledger: read() }, { status: r.status });
      writeJsonAtomic(FILE, r.ledger);
      return NextResponse.json({ success: true, ledger: r.ledger });
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 503 });
  }
}
