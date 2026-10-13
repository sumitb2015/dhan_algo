import { NextRequest, NextResponse } from 'next/server';
import { derivativeTick } from '@/lib/derivativeTick';

/** GET ?securityId=&segment= -> { success, tick } (rupees, from master_list.csv). Read-only. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = req.nextUrl.searchParams;
  const securityId = q.get('securityId') ?? '';
  const tick = /^\d+$/.test(securityId) ? derivativeTick(securityId, q.get('segment') ?? '') : null;
  return tick
    ? NextResponse.json({ success: true, tick })
    : NextResponse.json({ success: false, error: 'Tick size not found for this contract' }, { status: 404 });
}
