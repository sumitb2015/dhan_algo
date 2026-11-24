import { NextRequest, NextResponse } from 'next/server';
import { derivativeTick } from '@/lib/derivativeTick';

// Read-only: one NSE F&O contract's tick size in rupees, from master_list.csv (lib/derivativeTick.ts), for the
// /index-scalper ticket's price check. null when the contract is unknown (the ticket then uses Rs 0.05).
export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get('securityId') ?? '';
  if (!/^\d{1,12}$/.test(id)) return NextResponse.json({ success: false, error: 'securityId must be numeric' }, { status: 400 });
  return NextResponse.json({ success: true, tick: derivativeTick(id, 'NSE_FNO') }, { headers: { 'Cache-Control': 'no-store' } });
}
