import { NextRequest, NextResponse } from 'next/server';
import { runTrendConfluenceAnalysis } from '@/lib/trendConfluence';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const forceRefresh = searchParams.get('refresh') === 'true';
    const starsFilter = searchParams.get('stars'); // '5' | '4' | '3' | 'bearish' | 'all'
    const sectorFilter = searchParams.get('sector') || 'all';
    const query = (searchParams.get('q') || '').toLowerCase().trim();

    const data = await runTrendConfluenceAnalysis(forceRefresh);

    let filtered = [...data.stocks];

    if (starsFilter === '5') {
      filtered = filtered.filter((s) => s.stars === 5);
    } else if (starsFilter === '4') {
      filtered = filtered.filter((s) => s.stars === 4);
    } else if (starsFilter === '4plus') {
      filtered = filtered.filter((s) => s.stars >= 4);
    } else if (starsFilter === '3') {
      filtered = filtered.filter((s) => s.stars === 3);
    } else if (starsFilter === 'bearish') {
      filtered = filtered.filter((s) => s.stars <= 2);
    }

    if (sectorFilter !== 'all') {
      filtered = filtered.filter(
        (s) => s.sector.toLowerCase() === sectorFilter.toLowerCase()
      );
    }

    if (query) {
      filtered = filtered.filter(
        (s) =>
          s.symbol.toLowerCase().includes(query) ||
          s.sector.toLowerCase().includes(query)
      );
    }

    return NextResponse.json({
      ...data,
      stocks: filtered,
      filteredCount: filtered.length,
    });
  } catch (error) {
    console.error('Failed to run trend confluence analysis:', error);
    return NextResponse.json(
      { error: 'Failed to run multi-timeframe trend confluence analysis' },
      { status: 500 }
    );
  }
}
