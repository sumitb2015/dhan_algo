import { NextRequest, NextResponse } from 'next/server';
import { searchEquities } from '@/lib/equityMaster';
import { cleanQuery, matchIndices, type PnfPick } from '@/lib/straddlePnfSearch';

// Read-only instrument search for the Straddle P&F page: indices first, then NSE cash equities from master_list.csv.
export async function GET(request: NextRequest) {
  const q = cleanQuery(new URL(request.url).searchParams.get('q') ?? '');
  if (!q) return NextResponse.json({ success: true, results: [] satisfies PnfPick[] });
  try {
    const equities: PnfPick[] = searchEquities(q, 8).map(e => ({ kind: 'equity', symbol: e.symbol, name: e.name }));
    return NextResponse.json({ success: true, results: [...matchIndices(q), ...equities].slice(0, 10) });
  } catch (e) {
    return NextResponse.json({ success: false, error: `Search failed: ${(e as Error).message}`, results: [] }, { status: 500 });
  }
}
