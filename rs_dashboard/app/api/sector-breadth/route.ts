import { NextRequest, NextResponse } from 'next/server';
import { runSectorBreadthAnalysis } from '@/lib/sectorBreadth';

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const forceRefresh = searchParams.get('refresh') === 'true';
    const sectorFilter = searchParams.get('sector');

    const data = await runSectorBreadthAnalysis(forceRefresh);

    if (sectorFilter && sectorFilter !== 'all') {
      const matched = data.sectors.find(
        (s) => s.sector.toLowerCase() === sectorFilter.toLowerCase()
      );
      return NextResponse.json({
        ...data,
        sectors: matched ? [matched] : [],
      });
    }

    return NextResponse.json(data);
  } catch (error) {
    console.error('Failed to run sector breadth analysis:', error);
    return NextResponse.json(
      { error: 'Failed to run sector depth and participation analysis' },
      { status: 500 }
    );
  }
}
