import { NextRequest, NextResponse } from 'next/server';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyRestingOp, type RestingOp } from '@/lib/pnfRestingLedger';
import { RESTING_FILE as FILE, readRestingLedger as read } from '@/lib/pnfRestingServer';

// The P&F resting-orders ledger (debug/pnf_resting_state.json). GET returns it; POST applies ONE op (lib/pnfRestingLedger.ts applyRestingOp)
// under a file lock, written atomically. The browser never writes the file whole. Places no orders. Orders left open on an
// earlier IST day are closed on read (rollDay); a POST writes that roll with its op.

const LOCK = `${FILE}.lock`;

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ success: true, ledger: read() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let op: RestingOp;
  try { op = await req.json() as RestingOp; } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  try {
    return await withFileLock(LOCK, 5_000, 'P&F resting-orders ledger', () => {
      const led = read();
      const r = applyRestingOp(led, op);
      if (!r.ok) return NextResponse.json({ success: false, error: r.error, ledger: led }, { status: r.status });
      writeJsonAtomic(FILE, r.ledger);
      return NextResponse.json({ success: true, ledger: r.ledger });
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 503 });
  }
}
