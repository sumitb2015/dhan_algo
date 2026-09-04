import { NextRequest, NextResponse } from 'next/server';
import { readBaskets, upsertBasket, deleteBasket } from '@/lib/basketStore';
import type { SavedBasket } from '@/lib/basketStorage';

export async function GET(): Promise<NextResponse> {
  try {
    return NextResponse.json({ success: true, data: readBaskets() });
  } catch (err) {
    console.error('[/api/baskets GET]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as { basket?: SavedBasket };
    if (!body?.basket?.id) {
      return NextResponse.json({ success: false, error: 'basket (with id) is required' }, { status: 400 });
    }
    const baskets = upsertBasket(body.basket);
    return NextResponse.json({ success: true, data: baskets });
  } catch (err) {
    console.error('[/api/baskets POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  try {
    const { id } = await req.json() as { id?: string };
    if (!id) return NextResponse.json({ success: false, error: 'id required' }, { status: 400 });
    const baskets = deleteBasket(id);
    return NextResponse.json({ success: true, data: baskets });
  } catch (err) {
    console.error('[/api/baskets DELETE]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
