import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';
import { readTracked, writeTracked, newTrackedId, type TrackedCsp } from '@/lib/cspTracked';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');

interface OrderOutcome {
  success: boolean;
  orderId?: string;
  status?: string;
  tradedPrice?: number | null;
  error?: string;
}

/** Leg 2 of a Shift — SELL the new PE at market.
 *
 *  Leg 1 has already closed the old row, so this only ever *adds* the new
 *  position. If it fails the operator is simply flat, which the error says
 *  plainly rather than leaving a half-rolled record behind. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = String(body?.id ?? '');
    const newStrike = Number(body?.newStrike);
    const newExpiry = String(body?.newExpiry ?? '').slice(0, 10);

    const prior = readTracked().find((r) => r.id === id);
    if (!prior) {
      return NextResponse.json({ success: false, error: 'Tracked position not found' }, { status: 404 });
    }
    // Only reachable straight after a confirmed leg 1. Guards against the entry
    // leg being fired on its own, which would open a naked short put.
    if (prior.status !== 'CLOSED') {
      return NextResponse.json({
        success: false,
        error: `Expected the exit leg to have completed first (row is ${prior.status})`,
      }, { status: 409 });
    }
    if (!Number.isFinite(newStrike) || newStrike <= 0 || !newExpiry) {
      return NextResponse.json({ success: false, error: 'newStrike and newExpiry are required' }, { status: 400 });
    }

    const result = await runPythonJson<OrderOutcome>(
      SCRIPT,
      [
        'place',
        '--symbol', prior.symbol,
        '--expiry', newExpiry,
        '--strike', String(newStrike),
        '--quantity', String(prior.qty),
        '--order-type', 'MARKET',
        '--product-type', prior.productType ?? 'MARGIN',
        '--wait-fill',
      ],
      45_000,
    );

    if (!result.success) {
      return NextResponse.json({
        ...result,
        error: `${result.error ?? 'Entry leg failed'} — the old put is already closed, so the position is FLAT.`,
      }, { status: 500 });
    }

    // Re-read right before writing: the order round-trip is long enough for a
    // concurrent add/delete to land.
    const rows = readTracked();
    const old = rows.find((r) => r.id === id);
    const now = new Date().toISOString();

    const newRow: TrackedCsp = {
      id: newTrackedId(),
      symbol: prior.symbol,
      strike: newStrike,
      expiry: newExpiry,
      qty: prior.qty,
      lotSize: prior.lotSize,
      entrySpot: Number(body?.entrySpot) || 0,
      entryDate: now.slice(0, 10),
      // The real fill, never the UI's chain mark. A traded price is only
      // missing when the order is still working, which is surfaced below.
      avgPrice: typeof result.tradedPrice === 'number' ? result.tradedPrice : 0,
      productType: prior.productType,
      status: 'OPEN',
      rolledFromId: prior.id,
      createdAt: now,
      updatedAt: now,
    };
    if (result.orderId) newRow.orderId = result.orderId;
    if (prior.securityId) newRow.exchangeSegment = prior.exchangeSegment;

    if (old) {
      old.status = 'ROLLED';
      old.rolledToId = newRow.id;
      old.updatedAt = now;
    }
    rows.push(newRow);
    writeTracked(rows);

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      status: result.status,
      tradedPrice: result.tradedPrice ?? null,
      row: newRow,
      // The new row has no securityId until it is reconciled against positions,
      // so it cannot itself be Shifted yet — say so instead of failing later.
      warning: result.status !== 'TRADED'
        ? `Entry order ${result.orderId} is ${result.status ?? 'unconfirmed'} — average price will be wrong until it fills.`
        : undefined,
    });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
