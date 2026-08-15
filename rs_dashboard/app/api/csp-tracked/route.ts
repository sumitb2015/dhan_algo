import { NextRequest, NextResponse } from 'next/server';
import { readTracked, writeTracked, newTrackedId, readSyncCache, type TrackedCsp } from '@/lib/cspTracked';

export async function GET() {
  const sync = readSyncCache();
  return NextResponse.json({
    success: true,
    rows: readTracked(),
    sync: sync?.rows ?? [],
    syncedAt: sync?.asOf ?? null,
  });
}

/** POST — add a tracked put. Works for both order-backed and paper rows; the
 *  broker fields are simply absent on a manual entry. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const symbol = String(b?.symbol ?? '').trim().toUpperCase();
    const strike = Number(b?.strike);
    const expiry = String(b?.expiry ?? '').slice(0, 10);
    const qty = Number(b?.qty);

    if (!symbol || !expiry || !Number.isFinite(strike) || strike <= 0 || !Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json(
        { success: false, error: 'symbol, strike, expiry and qty are required' },
        { status: 400 },
      );
    }

    const now = new Date().toISOString();
    const row: TrackedCsp = {
      id: newTrackedId(),
      symbol,
      strike,
      expiry,
      qty,
      lotSize: Number(b?.lotSize) || 0,
      entrySpot: Number(b?.entrySpot) || 0,
      entryDate: String(b?.entryDate ?? now.slice(0, 10)),
      avgPrice: Number(b?.avgPrice) || 0,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
    };
    for (const k of ['orderId', 'securityId', 'exchangeSegment', 'productType'] as const) {
      if (b?.[k]) row[k] = String(b[k]);
    }
    if (b?.rolledFromId) row.rolledFromId = String(b.rolledFromId);

    const rows = readTracked();
    rows.push(row);
    writeTracked(rows);
    return NextResponse.json({ success: true, row });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

/** PATCH — edit a tracked row, or close it (status CLOSED + exit price). */
export async function PATCH(req: NextRequest) {
  try {
    const b = await req.json();
    const id = String(b?.id ?? '');
    if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });

    const rows = readTracked();
    const row = rows.find((r) => r.id === id);
    if (!row) return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });

    for (const k of ['strike', 'qty', 'lotSize', 'entrySpot', 'avgPrice', 'exitPrice'] as const) {
      if (b?.[k] !== undefined && Number.isFinite(Number(b[k]))) row[k] = Number(b[k]);
    }
    if (b?.expiry !== undefined) row.expiry = String(b.expiry).slice(0, 10);
    if (b?.entryDate !== undefined) row.entryDate = String(b.entryDate);
    if (b?.exitDate !== undefined) row.exitDate = String(b.exitDate);
    if (b?.rolledToId !== undefined) row.rolledToId = String(b.rolledToId);
    if (b?.status !== undefined) {
      const next = String(b.status).toUpperCase();
      if (next !== 'OPEN' && next !== 'CLOSED' && next !== 'ROLLED') {
        return NextResponse.json({ success: false, error: `Invalid status: ${next}` }, { status: 400 });
      }
      row.status = next;
    }

    // Short put: profit is what's left of the premium collected.
    if (row.status === 'CLOSED' && row.exitPrice !== undefined) {
      row.realizedPnl = (row.avgPrice - row.exitPrice) * row.qty;
      if (!row.exitDate) row.exitDate = new Date().toISOString().slice(0, 10);
    }

    row.updatedAt = new Date().toISOString();
    writeTracked(rows);
    return NextResponse.json({ success: true, row });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const b = await req.json();
    const id = String(b?.id ?? '');
    if (!id) return NextResponse.json({ success: false, error: 'id is required' }, { status: 400 });
    writeTracked(readTracked().filter((r) => r.id !== id));
    return NextResponse.json({ success: true });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
