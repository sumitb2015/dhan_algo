import { NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { readTracked, writeSyncCache, type SyncRow } from '@/lib/cspTracked';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');

/** POST — live spot + PE mark for every OPEN tracked row, so the client can
 *  compute Current/Open P&L and the no-hit probability against fresh prices.
 *  The option-chain call self-throttles to 3s per symbol+expiry, so this is
 *  slow by design and must not be put on a fast poll. */
export async function POST() {
  const open = readTracked().filter((r) => r.status === 'OPEN');
  if (open.length === 0) {
    return NextResponse.json({ success: true, rows: [] });
  }

  const positions = open.map((r) => ({
    id: r.id, symbol: r.symbol, expiry: r.expiry, strike: r.strike,
  }));

  try {
    const parsed = await dedupe('csp-tracked-sync', () =>
      runPythonJson<{ success: boolean; rows?: SyncRow[]; asOf?: string; error?: string }>(
        SCRIPT,
        ['sync', '--positions', JSON.stringify(positions)],
        // 3s throttle per distinct symbol+expiry, plus auth and master-list load.
        Math.max(60_000, positions.length * 5_000),
      ),
    );
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error ?? 'Unknown error' }, { status: 500 });
    }
    const asOf = parsed.asOf ?? new Date().toISOString();
    const rows = parsed.rows ?? [];
    writeSyncCache({ asOf, rows });
    return NextResponse.json({ success: true, rows, asOf });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
