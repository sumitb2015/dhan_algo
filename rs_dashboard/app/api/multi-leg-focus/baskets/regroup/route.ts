import { NextRequest, NextResponse } from 'next/server';
import { regroup } from '@/lib/multiLegFocusStore';
import type { RegroupRequest } from '@/lib/multiLegRegroup';

/** Group / ungroup trades. Moves legs between strategy rows in the ledger file; places no orders. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  try {
    const body = await req.json() as RegroupRequest;
    if (body?.op !== 'group' && body?.op !== 'ungroup') {
      return NextResponse.json({ success: false, error: 'op must be group or ungroup' }, { status: 400 });
    }
    const okIds = (v: unknown) => v === undefined || (Array.isArray(v) && v.every(x => typeof x === 'string'));
    const str = (v: unknown) => v === undefined || typeof v === 'string';
    if (!okIds(body.legIds) || !str((body as { name?: unknown }).name) || !str((body as { targetBasketId?: unknown }).targetBasketId)
      || !str((body as { basketId?: unknown }).basketId)) {
      return NextResponse.json({ success: false, error: 'invalid request' }, { status: 400 });
    }
    const r = regroup(body);
    if (!r.ok) return NextResponse.json({ success: false, error: r.error }, { status: 409 });
    return NextResponse.json({ success: true, data: r.baskets, message: r.message, disarmed: r.disarmed });
  } catch (err) {
    console.error('[/api/multi-leg-focus/baskets/regroup POST]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
