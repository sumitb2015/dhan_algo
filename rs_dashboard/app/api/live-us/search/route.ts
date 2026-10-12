import { NextRequest, NextResponse } from 'next/server';
import { searchUs } from '@/lib/usStocks';
import { getUsMaster } from '@/lib/usStocksServer';

export const dynamic = 'force-dynamic';

// GET /api/live-us/search?q=apple  - symbol/name search over Dhan's US instrument list (read-only).
export async function GET(req: NextRequest): Promise<NextResponse> {
  const q = (req.nextUrl.searchParams.get('q') ?? '').slice(0, 40);
  try {
    const m = await getUsMaster();
    return NextResponse.json({ success: true, results: searchUs(m.list, q, 15), total: m.list.length });
  } catch (err) {
    return NextResponse.json({ success: false, error: err instanceof Error ? err.message : 'Instrument list unavailable' }, { status: 502 });
  }
}
