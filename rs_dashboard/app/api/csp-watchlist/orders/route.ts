import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson } from '@/lib/pyExec';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { kotakPlacePut } from '@/lib/cspKotak';
import { kotakPost, KOTAK_PATHS, isKotakTokenValid } from '@/lib/kotakToken';

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
      triggerPrice,
      afterMarketOrder = false,
      amoTime = 'OPEN',
      productType = 'MARGIN',
    } = body ?? {};

    if (!symbol || !expiry || strike == null || !quantity) {
      return NextResponse.json({ success: false, error: 'Missing required fields' }, { status: 400 });
    }
    const orderTypeUpper = String(orderType).toUpperCase();
    if (orderTypeUpper === 'LIMIT' && price == null) {
      return NextResponse.json({ success: false, error: 'price is required for LIMIT orders' }, { status: 400 });
    }
    if ((orderTypeUpper === 'STOP_LOSS' || orderTypeUpper === 'STOP_LOSS_MARKET') && triggerPrice == null) {
      return NextResponse.json({ success: false, error: 'triggerPrice is required for STOP_LOSS orders' }, { status: 400 });
    }

    if (body?.broker === 'kotak') {
      const r = await kotakPlacePut({
        symbol: String(symbol).toUpperCase(), expiry: String(expiry), strike: Number(strike), quantity: Number(quantity),
        productType: String(productType), orderType: orderTypeUpper, price: Number(price ?? 0), triggerPrice: Number(triggerPrice ?? 0),
        afterMarketOrder: !!afterMarketOrder,
      });
      if (r.success) invalidateBrokerCache('kotak');
      return NextResponse.json(r, { status: r.success ? 200 : 500 });
    }

    const args = [
      'place',
      '--symbol', String(symbol).toUpperCase(),
      '--expiry', String(expiry),
      '--strike', String(strike),
      '--quantity', String(quantity),
      '--order-type', orderTypeUpper,
      '--price', String(price ?? 0),
      '--trigger-price', String(triggerPrice ?? 0),
      '--product-type', String(productType).toUpperCase(),
    ];
    if (afterMarketOrder) {
      args.push('--after-market-order', '--amo-time', String(amoTime).toUpperCase());
    }

    const result = await runPythonJson<OrderResult>(SCRIPT, args, 20_000);
    if (result.success) invalidateBrokerCache('dhan');
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

    if (body?.broker === 'kotak') {
      if (!isKotakTokenValid()) return NextResponse.json({ success: false, error: 'Kotak session is not valid' }, { status: 401 });
      try {
        await kotakPost(KOTAK_PATHS.cancelOrder, { on: String(orderId), am: 'NO' });
        invalidateBrokerCache('kotak');
        return NextResponse.json({ success: true });
      } catch (e) {
        return NextResponse.json({ success: false, error: `Failed to cancel order: ${String((e as Error).message ?? e)}` }, { status: 500 });
      }
    }
    const result = await runPythonJson<OrderResult>(SCRIPT, ['cancel', '--order-id', String(orderId)], 20_000);
    // Cancelling a resting order releases the margin it was blocking.
    if (result.success) invalidateBrokerCache('dhan');
    return NextResponse.json(result, { status: result.success ? 200 : 500 });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}
