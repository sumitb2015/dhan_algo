import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'csp_watchlist.py');

interface OrderResult {
  success: boolean;
  orderId?: string;
  error?: string;
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const {
      symbol,
      expiry,
      strike,
      quantity,
      orderType = 'MARKET',
      price,
      productType = 'MARGIN',
    } = body ?? {};

    if (!symbol || !expiry || strike == null || !quantity) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    if (String(orderType).toUpperCase() === 'LIMIT' && price == null) {
      return NextResponse.json({ success: false, error: 'price is required for LIMIT orders' }, { status: 400 });
    }

    const args = [
      'place',
      '--symbol', String(symbol).toUpperCase(),
      '--expiry', String(expiry),
      '--strike', String(strike),
      '--quantity', String(quantity),
      '--order-type', String(orderType).toUpperCase(),
      '--price', String(price ?? 0),
      '--product-type', String(productType).toUpperCase(),
    ];

    const result = await runPythonJson<OrderResult>(SCRIPT, args, 20_000);
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const body = await req.json();
    const orderId = body?.orderId;
    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }

    const result = await runPythonJson<OrderResult>(SCRIPT, ['cancel', '--order-id', String(orderId)], 20_000);
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
