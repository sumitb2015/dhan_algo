import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';
import { readTracked, writeTracked, newTrackedId, type TrackedCsp } from '@/lib/cspTracked';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');

interface PlaceOutcome {
  success: boolean;
  orderId?: string;
  status?: string;
  tradedPrice?: number | null;
  securityId?: string;
  exchangeSegment?: string;
  lotSize?: number;
  error?: string;
}

/** Sell a cash-secured put straight off a scanner row and start tracking it.
 *
 *  Placing and tracking are one step on purpose: a row created here carries the
 *  broker's securityId, which is what makes it closeable and Shift-able later.
 *  Rows added by hand have no contract and can only be paper-tracked. */
export async function POST(req: NextRequest) {
  try {
    const b = await req.json();
    const symbol = String(b?.symbol ?? '').trim().toUpperCase();
    const expiry = String(b?.expiry ?? '').slice(0, 10);
    const strike = Number(b?.strike);
    const qty = Number(b?.qty);
    const productType = String(b?.productType ?? 'MARGIN').toUpperCase();

    if (!symbol || !expiry || !Number.isFinite(strike) || strike <= 0 || !Number.isFinite(qty) || qty <= 0) {
      return NextResponse.json(
        { success: false, error: 'symbol, expiry, strike and qty are required' },
        { status: 400 },
      );
    }

    const result = await runPythonJson<PlaceOutcome>(
      SCRIPT,
      [
        'place',
        '--symbol', symbol,
        '--expiry', expiry,
        '--strike', String(strike),
        '--quantity', String(qty),
        '--order-type', 'MARKET',
        '--product-type', productType,
        '--wait-fill',
      ],
      // Must exceed the Python side's own budget (auth + master list ~5s, then
      // a 25s wait_for_fill). If this fires first the child is killed with the
      // order already at the exchange, which is precisely the untracked-position
      // case this route exists to prevent.
      90_000,
    );

    if (!result.success) {
      return NextResponse.json(result, { status: 500 });
    }

    const now = new Date().toISOString();
    const row: TrackedCsp = {
      id: newTrackedId(),
      symbol,
      strike,
      expiry,
      qty,
      lotSize: Number(result.lotSize) || Number(b?.lotSize) || 0,
      entrySpot: Number(b?.entrySpot) || 0,
      entryDate: now.slice(0, 10),
      avgPrice: typeof result.tradedPrice === 'number' ? result.tradedPrice : 0,
      productType,
      status: 'OPEN',
      createdAt: now,
      updatedAt: now,
    };
    if (result.orderId) row.orderId = result.orderId;
    if (result.securityId) row.securityId = result.securityId;
    if (result.exchangeSegment) row.exchangeSegment = result.exchangeSegment;
    // Unconfirmed fill: avgPrice is 0 and qty is what was asked for, not what
    // filled. Flagged rather than silently stored, so the UI can prompt for a
    // reconcile instead of reporting the whole premium as a loss forever.
    if (result.status !== 'TRADED') row.needsReconcile = true;

    const rows = readTracked();
    rows.push(row);
    writeTracked(rows);

    return NextResponse.json({
      success: true,
      orderId: result.orderId,
      status: result.status,
      tradedPrice: result.tradedPrice ?? null,
      row,
      warning: result.status !== 'TRADED'
        ? `Order ${result.orderId} is ${result.status ?? 'unconfirmed'} — the tracked average price and `
          + 'quantity are the requested ones. Run Reconcile once it settles.'
        : undefined,
    });
  } catch (err: unknown) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : String(err) }, { status: 500 });
  }
}
