import { NextRequest, NextResponse } from 'next/server';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyRestingOp, type RestingOp } from '@/lib/pnfRestingLedger';
import { readRestingLedger as read, restingFileFor } from '@/lib/pnfRestingServer';
import { parseScope } from '@/lib/pnfScope';

// The P&F resting-orders ledger (debug/pnf_resting_state.json). GET returns it; POST applies ONE op (lib/pnfRestingLedger.ts applyRestingOp)
// under a file lock, written atomically. The browser never writes the file whole. Places no orders. Orders left open on an
// earlier IST day are closed on read (rollDay); a POST writes that roll with its op. `?scope=renko` is the Renko page's own
// ledger (debug/renko_resting_state.json, lib/pnfScope.ts).

export async function GET(req: NextRequest): Promise<NextResponse> {
  return NextResponse.json({ success: true, ledger: read(parseScope(req.nextUrl.searchParams.get('scope'))) });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let op: RestingOp;
  try { op = await req.json() as RestingOp; } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const FILE = restingFileFor(scope);
  try {
    return await withFileLock(`${FILE}.lock`, 5_000, scope === 'renko' ? 'Renko resting-orders ledger' : 'P&F resting-orders ledger', () => {
      const led = read(scope);
      const r = applyRestingOp(led, op);
      if (!r.ok) return NextResponse.json({ success: false, error: r.error, ledger: led }, { status: r.status });
      writeJsonAtomic(FILE, r.ledger);
      return NextResponse.json({ success: true, ledger: r.ledger });
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 503 });
  }
}
