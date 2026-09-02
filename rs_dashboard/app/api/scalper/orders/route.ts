import { NextRequest, NextResponse } from 'next/server';
import { dhanGet, dhanPut, dhanDelete } from '@/lib/dhanToken';

// Direct Dhan REST call for fetching orders.
export async function GET(): Promise<NextResponse> {
  try {
    const data = await dhanGet('/orders');
    return NextResponse.json({ success: true, data: Array.isArray(data) ? data : [] });
  } catch (err) {
    console.error('[/api/scalper/orders] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to fetch orders', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Modify an existing pending order (e.g. change limit price or quantity).
export async function PATCH(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json();
    const {
      orderId,
      price,
      quantity,
      orderType = 'LIMIT',
      triggerPrice = 0,
      validity = 'DAY',
      legName = 'ENTRY_LEG',
      broker = 'dhan',
    } = body ?? {};

    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }
    const newPrice = Number(price);
    if (isNaN(newPrice) || newPrice <= 0) {
      return NextResponse.json({ success: false, error: `Invalid price: ${price}` }, { status: 400 });
    }
    const qty = Number(quantity);
    if (isNaN(qty) || qty <= 0) {
      return NextResponse.json({ success: false, error: `Invalid quantity: ${quantity}` }, { status: 400 });
    }

    if (broker === 'dhan') {
      const payload = {
        orderId: String(orderId),
        orderType: String(orderType).toUpperCase(),
        legName: String(legName).toUpperCase(),
        quantity: Math.round(qty),
        price: Number(newPrice.toFixed(2)),
        disclosedQuantity: 0,
        triggerPrice: Number(triggerPrice) || 0,
        validity: String(validity).toUpperCase(),
      };
      const res = await dhanPut(`/orders/${orderId}`, payload);
      return NextResponse.json({ success: true, data: res });
    }

    return NextResponse.json({ success: false, error: `Broker ${broker} order modification not yet supported` }, { status: 400 });
  } catch (err) {
    console.error('[/api/scalper/orders PATCH] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to modify order', detail: String((err as Error).message) }, { status: 500 });
  }
}

// Cancel a pending order by ID.
export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json().catch(() => ({}));
    const searchParams = req.nextUrl.searchParams;
    const orderId = body?.orderId || searchParams.get('orderId');
    const broker = body?.broker || searchParams.get('broker') || 'dhan';

    if (!orderId) {
      return NextResponse.json({ success: false, error: 'orderId is required' }, { status: 400 });
    }

    if (broker === 'dhan') {
      const res = await dhanDelete(`/orders/${orderId}`);
      return NextResponse.json({ success: true, data: res });
    }

    return NextResponse.json({ success: false, error: `Broker ${broker} order cancellation not yet supported` }, { status: 400 });
  } catch (err) {
    console.error('[/api/scalper/orders DELETE] error:', err);
    return NextResponse.json({ success: false, error: 'Failed to cancel order', detail: String((err as Error).message) }, { status: 500 });
  }
}

