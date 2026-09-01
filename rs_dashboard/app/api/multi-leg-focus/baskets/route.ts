import { NextRequest, NextResponse } from 'next/server';
import { readBaskets, upsertBasket, deleteBasket } from '@/lib/multiLegFocusStore';
import type { MultiLegBasket } from '@/lib/multiLegFocus';

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, data: readBaskets() });
  } catch (err) {
    console.error('[/api/multi-leg-focus/baskets GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as Partial<MultiLegBasket> & { id?: string };
    const baskets = upsertBasket(body);
    return NextResponse.json({ success: true, data: baskets });
  } catch (err) {
    console.error('[/api/multi-leg-focus/baskets POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const { id } = await req.json() as { id: string };
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const baskets = deleteBasket(id);
    return NextResponse.json({ success: true, data: baskets });
  } catch (err) {
    console.error('[/api/multi-leg-focus/baskets DELETE]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
