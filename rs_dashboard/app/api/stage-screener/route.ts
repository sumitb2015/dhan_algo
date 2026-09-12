import { NextRequest, NextResponse } from 'next/server';
import { runStageScreener } from '@/lib/stageScreener';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const forceRefresh = searchParams.get('refresh') === 'true';
    const filterTab = searchParams.get('tab') || 'all'; // 'all' | 'stage2' | 'strict8' | 'vcp' | 'stage1'
    const sectorFilter = searchParams.get('sector') || 'all';
    const query = (searchParams.get('q') || '').toLowerCase().trim();

    const data = await runStageScreener(forceRefresh);

    let filtered = [...data.stocks];

    // Filter by tab
    if (filterTab === 'stage2') {
      filtered = filtered.filter((s) => s.stage === 'Stage 2 (Markup)');
    } else if (filterTab === 'strict8') {
      filtered = filtered.filter((s) => s.score === 8);
    } else if (filterTab === 'vcp') {
      filtered = filtered.filter((s) => s.vcp.isVCP);
    } else if (filterTab === 'stage1') {
      filtered = filtered.filter((s) => s.stage === 'Stage 1 (Basing)');
    }

    // Filter by sector
    if (sectorFilter !== 'all') {
      filtered = filtered.filter(
        (s) => s.sector.toLowerCase() === sectorFilter.toLowerCase()
      );
    }

    // Search query
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
    console.error('Failed to run stage screener:', error);
    return NextResponse.json(
      { error: 'Failed to run Minervini Stage 2 screener' },
      { status: 500 }
    );
  }
}
