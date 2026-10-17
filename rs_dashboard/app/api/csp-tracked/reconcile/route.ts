import { NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { readTracked, writeTracked } from '@/lib/cspTracked';
import { reconcileCspRows, type CspBrokerRow } from '@/lib/cspReconcile';
import { kotakReconcile } from '@/lib/cspKotak';
import { isKotakTokenValid } from '@/lib/kotakToken';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');


interface UntrackedPosition {
  securityId: string;
  tradingSymbol: string;
  symbol: string;
  netQty: number;
  avgPrice: number;
  strike: number;
  expiry: string;
  productType: string;
  exchangeSegment: string;
  lotSize: number;
  /** Which account shows this short (Kotak rows carry the trading symbol in securityId). Absent = Dhan. */
  broker?: 'dhan' | 'kotak';
}

/** POST — bring every order-backed OPEN row in line with the broker. The
 *  rules (own order first, quantity only down, own average kept) are in
 *  lib/cspReconcile.ts — the broker's position figures are pooled across
 *  everything on the contract, so they never overwrite a row directly.
 *
 *  Three things put the local record out of step with reality, and none of them
 *  can be fixed from the order response alone: an order that fills after its
 *  route timed out, an entry that only part-fills, and a fill confirmed later
 *  than the 25s wait window (which stores avgPrice 0). This is the single place
 *  that resolves all three, and it also reports shorts the dashboard has no row
 *  for at all so they can be adopted rather than silently run untracked. */
export async function POST() {
  const rows = readTracked();
  const open = rows.filter((r) => r.status === 'OPEN' && r.securityId);
  if (open.length === 0) {
    return NextResponse.json({ success: true, updated: 0, rows: [], untracked: [] });
  }

  // Each row against ITS account: Dhan rows through the Python CLI, Kotak rows through lib/cspKotak (same shapes).
  const dhanOpen = open.filter((r) => (r.broker ?? 'dhan') === 'dhan');
  const kotakOpen = open.filter((r) => r.broker === 'kotak');
  const payloadOf = (list: typeof open) => list.map((r) => ({ id: r.id, securityId: r.securityId, orderId: r.orderId, needOrder: !!r.needsReconcile }));

  try {
    const empty = { success: true, rows: [] as CspBrokerRow[], untracked: [] as UntrackedPosition[], asOf: undefined as string | undefined, error: undefined as string | undefined };
    const parsed = dhanOpen.length === 0 ? empty : await dedupe('csp-tracked-reconcile', () =>
      runPythonJson<{
        success: boolean; rows?: CspBrokerRow[]; untracked?: UntrackedPosition[];
        asOf?: string; error?: string;
      }>(SCRIPT, ['reconcile', '--positions', JSON.stringify(payloadOf(dhanOpen))], 60_000),
    );
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error ?? 'Unknown error' }, { status: 500 });
    }
    if (kotakOpen.length > 0) {
      // An unreadable Kotak book touches nothing (reconcile only ever acts on a successful read).
      if (!isKotakTokenValid()) return NextResponse.json({ success: false, error: 'Kotak session is not valid - Kotak rows not reconciled' }, { status: 500 });
      const k = await kotakReconcile(payloadOf(kotakOpen));
      parsed.rows = [...(parsed.rows ?? []), ...k.rows];
      parsed.untracked = [...(parsed.untracked ?? []), ...k.untracked.map((u) => ({ ...u, broker: 'kotak' as const }))];
    }

    const now = parsed.asOf ?? new Date().toISOString();
    // Re-read: the broker round-trip is long enough for a concurrent sell or
    // delete to have landed since the snapshot above.
    const fresh = readTracked();
    const { changes } = reconcileCspRows(fresh, parsed.rows ?? [], now);

    writeTracked(fresh);

    return NextResponse.json({
      success: true,
      asOf: now,
      updated: changes.length,
      changes,
      untracked: parsed.untracked ?? [],
    });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
