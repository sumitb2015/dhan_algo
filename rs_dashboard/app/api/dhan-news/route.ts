import { NextRequest, NextResponse } from 'next/server';
import { parseNewsRequest } from '@/lib/dhanAnalytics';
import { fetchNews, describeUpstreamError } from '@/lib/dhanAnalyticsServer';

export const dynamic = 'force-dynamic';

// GET /api/dhan-news?categories=COMPANIES,IPO&limit=30&universe=PORTFOLIO|WATCHLIST&stocks=1333,12489
// Read-only proxy for Dhan's Live News Headline API (Pro Traders plan). Auth is the proxy.ts gate.
export async function GET(req: NextRequest): Promise<NextResponse> {
  const parsed = parseNewsRequest(req.nextUrl.searchParams);
  if (!parsed.ok) return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
  try {
    const r = await fetchNews(parsed.value);
    return NextResponse.json({ success: true, items: r.value, fetchedAt: r.fetchedAt, stale: r.stale });
  } catch (err) {
    const { status, message } = describeUpstreamError(err);
    return NextResponse.json({ success: false, error: message }, { status });
  }
}
