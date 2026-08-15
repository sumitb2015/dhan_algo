import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';
import { readTracked, writeTracked } from '@/lib/cspTracked';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');

interface OrderOutcome {
  success: boolean;
  orderId?: string;
  status?: string;
  tradedPrice?: number | null;
  error?: string;
}

/** Leg 1 of a Shift — BUY back the currently sold PE at market.
 *
 *  On a confirmed fill this immediately books the row CLOSED using the real
 *  traded price. That ordering matters: if the row stayed OPEN until leg 2
 *  succeeded, a failed leg 2 would leave a phantom open short put that a retry
 *  would "exit" a second time, opening a real long position. */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = String(body?.id ?? '');
    const row = readTracked().find((r) => r.id === id);
    if (!row) {
      return NextResponse.json({ success: false, error: 'Tracked position not found' }, { status: 404 });
    }
    if (row.status !== 'OPEN') {
      return NextResponse.json({ success: false, error: `Position is already ${row.status}` }, { status: 409 });
    }
    if (!row.securityId || !row.exchangeSegment) {
      return NextResponse.json({
        success: false,
        error: 'This is a manually tracked (paper) row with no broker contract — close it manually instead',
      }, { status: 400 });
    }

    const result = await runPythonJson<OrderOutcome>(
      SCRIPT,
      [
        'exit',
        '--security-id', row.securityId,
        '--exchange-segment', row.exchangeSegment,
        '--quantity', String(row.qty),
        '--product-type', row.productType ?? 'MARGIN',
        '--wait-fill',
      ],
      45_000,
    );

    if (!result.success) {
      return NextResponse.json(result, { status: 500 });
    }
    // Accepted but not filled within the wait window. The position may or may
    // not be flat, so booking it either way would be a lie — stop the roll and
    // make the operator reconcile.
    if (result.status !== 'TRADED') {
      return NextResponse.json({
        success: false,
        orderId: result.orderId,
        status: result.status,
        error: `Exit order ${result.orderId} is ${result.status ?? 'unconfirmed'} — not filled yet. `
          + 'Check Orders/Positions before retrying; the roll has been stopped.',
      }, { status: 409 });
    }

    // Re-read immediately before writing so the order round-trip doesn't
    // clobber concurrent adds/deletes to the tracked file.
    const rows = readTracked();
    const fresh = rows.find((r) => r.id === id);
    if (!fresh) {
      return NextResponse.json({
        success: false,
        error: `Exit filled (order ${result.orderId}) but the tracked row disappeared — reconcile manually`,
      }, { status: 500 });
    }

    const now = new Date().toISOString();
    const exitPrice = typeof result.tradedPrice === 'number' ? result.tradedPrice : undefined;
    fresh.status = 'CLOSED';
    fresh.exitDate = now.slice(0, 10);
    fresh.updatedAt = now;
    if (exitPrice !== undefined) {
      fresh.exitPrice = exitPrice;
      fresh.realizedPnl = (fresh.avgPrice - exitPrice) * fresh.qty;
    }
    writeTracked(rows);

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      status: result.status,
      tradedPrice: result.tradedPrice ?? null,
    });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
