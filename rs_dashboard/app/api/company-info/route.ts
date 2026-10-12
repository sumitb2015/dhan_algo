import { NextRequest, NextResponse } from 'next/server';
import { parseCompanyInfoRequest } from '@/lib/dhanAnalytics';
import { fetchCompanyInfo, describeUpstreamError } from '@/lib/dhanAnalyticsServer';

export const dynamic = 'force-dynamic';

// GET /api/company-info?securityId=1333&exchangeSegment=NSE_EQ&metrics=CO,RATIOS,SHP
// Read-only proxy for Dhan's Company Info API. `info: null` = Dhan has nothing for this security.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const parsed = parseCompanyInfoRequest(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  try {
    const r = await fetchCompanyInfo(parsed.value);
    return NextResponse.json({ success: true, info: r.value, fetchedAt: r.fetchedAt, stale: r.stale });
  } catch (err) {
    const { status, message } = describeUpstreamError(err);
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
