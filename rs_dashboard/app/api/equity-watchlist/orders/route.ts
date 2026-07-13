import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';

const SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'forever_watchlist.py');

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
      transactionType,
      quantity,
      price,
      triggerPrice,
      orderFlag = 'SINGLE',
      price1,
      triggerPrice1,
      quantity1,
    } = body ?? {};

    if (!symbol || !transactionType || !quantity || price == null || triggerPrice == null) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }

    const args = [
      'place',
      '--symbol', String(symbol).toUpperCase(),
      '--transaction', String(transactionType),
      '--quantity', String(quantity),
      '--price', String(price),
      '--trigger-price', String(triggerPrice),
      '--order-flag', String(orderFlag),
    ];
    if (orderFlag === 'OCO') {
      args.push('--price1', String(price1 ?? 0));
      args.push('--trigger-price1', String(triggerPrice1 ?? 0));
      args.push('--quantity1', String(quantity1 ?? 0));
    }

    const result = await runPythonJson<OrderResult>(SCRIPT, args, 20_000);
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const body = await req.json();
    const { orderId, orderFlag, legName, quantity, price, triggerPrice } = body ?? {};

    if (!orderId || !orderFlag || !legName || !quantity || price == null || triggerPrice == null) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }

    const args = [
      'modify',
      '--order-id', String(orderId),
      '--order-flag', String(orderFlag),
      '--leg-name', String(legName),
      '--quantity', String(quantity),
      '--price', String(price),
      '--trigger-price', String(triggerPrice),
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
