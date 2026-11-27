import { NextRequest, NextResponse } from 'next/server';
import { derivativeLot } from '@/lib/derivativeTick';

// Read-only: each contract's own lot size (units per lot) from master_list.csv, for /index-scalper legs in an expiry
// other than the one on screen (SENSEX: 20 to Dec 2026, 25 from Jan 2027). ?segment=NSE_FNO|BSE_FNO|MCX_COMM&ids=1,2,3
// (numeric Dhan security ids, at most 200). Unknown ids are left out, never guessed.
export async function GET(req: NextRequest) {
  const segment = req.nextUrl.searchParams.get('segment') ?? '';
  if (!['NSE_FNO', 'BSE_FNO', 'MCX_COMM'].includes(segment)) {
    return NextResponse.json({ success: false, error: 'segment must be NSE_FNO, BSE_FNO or MCX_COMM' }, { status: 400 });
  }
  const ids = (req.nextUrl.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean);
  if (ids.length === 0 || ids.length > 200 || ids.some(id => !/^\d{1,12}$/.test(id))) {
    return NextResponse.json({ success: false, error: 'ids must be 1..200 numeric security ids' }, { status: 400 });
  }
  const lots: Record<string, number> = {};
  for (const id of ids) {
    const lot = derivativeLot(id, segment);
    if (lot !== null) lots[id] = lot;
  }
  return NextResponse.json({ success: true, lots }, { headers: { 'Cache-Control': 'no-store' } });
}
