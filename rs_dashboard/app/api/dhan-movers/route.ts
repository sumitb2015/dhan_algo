import { NextRequest, NextResponse } from 'next/server';
import { parseMoversRequest } from '@/lib/dhanAnalytics';
import { fetchMovers, describeUpstreamError } from '@/lib/dhanAnalyticsServer';

export const dynamic = 'force-dynamic';

// GET /api/dhan-movers?mode=equity&category=PRICE_GAINERS&universe=NIFTY_500&limit=20
//     /api/dhan-movers?mode=options|futures&category=OI_GAINERS&expiry=2026-10-15&limit=20
// Read-only proxy for Dhan's Market Movers API: exchange-side live ranking. NSE_FNO `expiry` selects
// a MONTH (monthly series); weeklies are not ranked. Separate from /api/movers, which is CSV-based.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const parsed = parseMoversRequest(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  try {
    const r = await fetchMovers(parsed.value);
    return NextResponse.json({ success: true, rows: r.value, request: parsed.value, fetchedAt: r.fetchedAt, stale: r.stale });
  } catch (err) {
    const { status, message } = describeUpstreamError(err);
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
