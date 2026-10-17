import { NextRequest, NextResponse } from 'next/server';
import { placeKotakOrder } from '@/lib/kotakPlaceOrder';
import { invalidateBrokerCache } from '@/lib/brokerPositionsCache';
import { kotakDerivativeBySymbol } from '@/lib/kotakContracts';
import { kotakUnderlyingOf } from '@/lib/kotakPositionContracts';
// Validation, product, lot cap and tick snapping are shared with /api/options/order (broker 'kotak').
import { buildKotakOrderPayload, type KotakOrderInput } from '@/lib/kotakOrderPayload';

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ready: true });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const body = await req.json() as KotakOrderInput;
  const isDerivative = /_fo$/i.test(String(body.exchange ?? 'nse_fo'));
  const underlying = isDerivative && body.tradingsymbol ? kotakUnderlyingOf(String(body.tradingsymbol)) : null;
  const contract = underlying ? kotakDerivativeBySymbol(String(body.tradingsymbol), underlying) : null;

  const built = buildKotakOrderPayload(body, contract);
  if ('error' in built) return NextResponse.json({ success: false, error: built.error }, { status: 400 });

  const orderPayload = built.payload;
  console.log('[scalper/kotak/order] payload →', JSON.stringify(orderPayload));
  const r = await placeKotakOrder(orderPayload);
  console.log('[scalper/kotak/order] outcome ←', JSON.stringify(r));
  if (r.status === 'placed') {
    invalidateBrokerCache('kotak');
    return NextResponse.json({ success: true, order_id: r.orderId, ...(r.reconciled ? { reconciled: true } : {}) });
  }
  if (r.status === 'unknown') return NextResponse.json({ success: false, unknown: true, error: r.error }, { status: 504 });
  return NextResponse.json({ success: false, error: r.error });
}
