import { NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';
import { readTracked, writeTracked } from '@/lib/cspTracked';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');

interface ReconcileRow {
  id: string;
  found: boolean;
  netQty: number;
  avgPrice: number;
  productType: string;
}

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
}

/** POST — replace every order-backed OPEN row's quantity and entry price with
 *  the broker's own figures.
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

  const payload = open.map((r) => ({ id: r.id, securityId: r.securityId }));

  try {
    const parsed = await dedupe('csp-tracked-reconcile', () =>
      runPythonJson<{
        success: boolean; rows?: ReconcileRow[]; untracked?: UntrackedPosition[];
        asOf?: string; error?: string;
      }>(SCRIPT, ['reconcile', '--positions', JSON.stringify(payload)], 60_000),
    );
    if (!parsed.success) {
      return NextResponse.json({ success: false, error: parsed.error ?? 'Unknown error' }, { status: 500 });
    }

    const byId = new Map((parsed.rows ?? []).map((r) => [r.id, r]));
    const now = parsed.asOf ?? new Date().toISOString();
    // Re-read: the broker round-trip is long enough for a concurrent sell or
    // delete to have landed since the snapshot above.
    const fresh = readTracked();
    const changes: string[] = [];

    for (const row of fresh) {
      const broker = byId.get(row.id);
      if (!broker || row.status !== 'OPEN') continue;
      row.reconciledAt = now;

      if (!broker.found || broker.netQty >= 0) {
        // Deliberately not auto-closed: with no fill price and no exit time,
        // any P&L booked here would be invented. Flag it for the operator.
        row.reconcileNote = 'Broker reports no open short for this contract — close or delete the row.';
        changes.push(`${row.symbol} ${row.strike}PE: broker shows flat`);
        continue;
      }

      const brokerQty = Math.abs(broker.netQty);
      if (brokerQty !== row.qty) {
        changes.push(`${row.symbol} ${row.strike}PE: qty ${row.qty} → ${brokerQty}`);
        row.qty = brokerQty;
      }
      if (broker.avgPrice > 0 && broker.avgPrice !== row.avgPrice) {
        changes.push(`${row.symbol} ${row.strike}PE: avg ${row.avgPrice} → ${broker.avgPrice}`);
        row.avgPrice = broker.avgPrice;
      }
      if (broker.productType && broker.productType !== row.productType) {
        row.productType = broker.productType;
      }
      delete row.reconcileNote;
      // Only a positive average actually resolves the unknown; a zero here means
      // the broker has no price for it either, so the row stays flagged.
      if (broker.avgPrice > 0) delete row.needsReconcile;
      row.updatedAt = new Date().toISOString();
    }

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
