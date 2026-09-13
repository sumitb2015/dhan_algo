import { NextRequest, NextResponse } from 'next/server';
import { runSectorBreadthAnalysis } from '@/lib/sectorBreadth';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const forceRefresh = searchParams.get('refresh') === 'true';
    const sectorFilter = searchParams.get('sector');
    const filterType = searchParams.get('filter')?.toLowerCase();

    const data = await runSectorBreadthAnalysis(forceRefresh);

    let sectors = data.sectors;

    if (sectorFilter && sectorFilter !== 'all') {
      const matched = sectors.find(
        (s) => s.sector.toLowerCase() === sectorFilter.toLowerCase()
      );
      sectors = matched ? [matched] : [];
    }

    if (filterType) {
      if (filterType === 'thrust') {
        sectors = sectors.filter((s) => s.hasInternalThrust);
      } else if (filterType === 'oversold') {
        sectors = sectors.filter((s) => s.pctAbove20 <= 25);
      } else if (filterType === 'accumulation') {
        sectors = sectors.filter((s) => s.accDistScore >= 55);
      } else if (filterType === 'distribution') {
        sectors = sectors.filter((s) => s.accDistScore <= 45);
      } else if (filterType === 'positive_rs') {
        sectors = sectors.filter((s) => s.sectorRS > 0);
      }
    }

    return NextResponse.json({
      ...data,
      totalSectors: sectors.length,
      sectors,
    });
  } catch (error) {
    console.error('Failed to run sector breadth analysis:', error);
    return NextResponse.json(
      { error: 'Failed to run sector depth and participation analysis' },
      { status: 500 }
    );
  }
}
