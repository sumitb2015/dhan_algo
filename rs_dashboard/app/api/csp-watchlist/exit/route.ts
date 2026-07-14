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
    const { securityId, exchangeSegment, quantity, productType = 'MARGIN' } = body ?? {};

    if (!securityId || !exchangeSegment || !quantity) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }

    const args = [
      'exit',
      '--security-id', String(securityId),
      '--exchange-segment', String(exchangeSegment),
      '--quantity', String(Math.abs(Number(quantity))),
      '--product-type', String(productType).toUpperCase(),
    ];

    const result = await runPythonJson<OrderResult>(SCRIPT, args, 20_000);
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
