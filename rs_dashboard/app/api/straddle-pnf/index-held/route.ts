import { NextRequest, NextResponse } from 'next/server';
import { withFileLock, writeJsonAtomic } from '@/lib/lockedJsonFile';
import { applyHeldOp, parseHeldOp, type HeldOp } from '@/lib/pnfIndexHeld';
import { indexHeldFileFor, readIndexHeld } from '@/lib/pnfIndexHeldServer';
import { parseScope } from '@/lib/pnfScope';

// Which option each REAL index chart holds (lib/pnfIndexHeld.ts): debug/renko_index_held.json (or pnf_index_held.json for the P&F page).
// GET returns the ledger; POST applies ONE validated op. Both under the file lock, so a read never lands between an op's read and its
// write (a poll overlapping an op would otherwise hand the page the state from before it). Places no orders.

const LABEL = 'index held-option ledger';

export async function GET(req: NextRequest): Promise<NextResponse> {
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  try {
    return await withFileLock(`${indexHeldFileFor(scope)}.lock`, 5_000, LABEL, () => NextResponse.json({ success: true, ledger: readIndexHeld(scope) }));
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 503 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try { body = await req.json(); } catch { return NextResponse.json({ success: false, error: 'Invalid JSON' }, { status: 400 }); }
  const op = parseHeldOp(body);
  if (typeof op === 'string') return NextResponse.json({ success: false, error: op }, { status: 400 });
  const scope = parseScope(req.nextUrl.searchParams.get('scope'));
  const FILE = indexHeldFileFor(scope);
  try {
    return await withFileLock(`${FILE}.lock`, 5_000, LABEL, () => {
      const led = readIndexHeld(scope);
      const r = applyHeldOp(led, { ...op, now: Math.floor(Date.now() / 1000) } as HeldOp);
      if (!r.ok) return NextResponse.json({ success: false, error: r.error, ledger: led }, { status: r.status });
      if (r.ledger !== led) writeJsonAtomic(FILE, r.ledger);
      return NextResponse.json({ success: true, ledger: r.ledger, row: r.row ?? null });
    });
  } catch (e) {
    return NextResponse.json({ success: false, error: (e as Error).message }, { status: 503 });
  }
}
