import { NextRequest, NextResponse } from 'next/server';
import { runHighsLowsAnalysis } from '@/lib/highsLows';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const forceRefresh = searchParams.get('refresh') === 'true';
    const tierFilter = searchParams.get('tier') || 'all'; // 'all' | 'AT_HIGH' | 'IN_BASE' | 'CONSOLIDATING' | 'CORRECTING' | 'BROKEN_STAGE4'
    const sectorFilter = searchParams.get('sector') || 'all';
    const query = (searchParams.get('q') || '').toLowerCase().trim();

    const data = await runHighsLowsAnalysis(forceRefresh);

    let filtered = [...data.stocks];

    if (tierFilter !== 'all') {
      filtered = filtered.filter((s) => s.tier === tierFilter);
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
    console.error('Failed to run highs/lows analysis:', error);
    return NextResponse.json(
      { error: 'Failed to run 52-week high/low and proximity analysis' },
      { status: 500 }
    );
  }
}
