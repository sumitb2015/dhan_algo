import { NextRequest, NextResponse } from 'next/server';
import { findEquity, searchEquities } from '@/lib/equityMaster';
import { fnoUnderlyings } from '@/lib/pnfContracts';
import { cleanQuery, matchIndices, type PnfPick } from '@/lib/straddlePnfSearch';

// Read-only instrument search for the Point & Figure page, scoped to the chosen segment: indices, NSE cash equities, or the
// underlyings that have live futures / options (NSE index and stock F&O, MCX commodities). No segment = indices then equities.
export async function GET(request: NextRequest) {
  const p = new URL(request.url).searchParams;
  const q = cleanQuery(p.get('q') ?? '');
  const segment = p.get('segment');
  if (!q) return NextResponse.json({ success: true, results: [] satisfies PnfPick[] });
  try {
    if (segment === 'futures' || segment === 'options') {
      const results: PnfPick[] = fnoUnderlyings(segment, q, 10).map(u => ({
        kind: segment, symbol: u.symbol,
        name: u.exch === 'MCX' ? 'MCX commodity' : u.instrument.endsWith('IDX') ? 'NSE index' : findEquity(u.symbol)?.name ?? 'NSE stock',
      }));
      return NextResponse.json({ success: true, results });
    }
    const indices = segment === 'equity' ? [] : matchIndices(q);
    const equities: PnfPick[] = segment === 'index' ? [] : searchEquities(q, 8).map(e => ({ kind: 'equity', symbol: e.symbol, name: e.name }));
    return NextResponse.json({ success: true, results: [...indices, ...equities].slice(0, 10) });
  } catch (e) {
    return NextResponse.json({ success: false, error: `Search failed: ${(e as Error).message}`, results: [] }, { status: 500 });
  }
}
