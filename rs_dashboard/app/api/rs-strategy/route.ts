import { NextRequest, NextResponse } from 'next/server';
import { runRsStrategy, DEFAULT_PARAMS } from '@/lib/rsStrategy';

function intParam(v: string | null, def: number, min: number, max: number): number {
  const n = v === null ? NaN : parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
}

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const period = intParam(sp.get('period'), DEFAULT_PARAMS.period, 5, 250);
    const rsiMin = intParam(sp.get('rsiMin'), DEFAULT_PARAMS.rsiMin, 0, 90);
    const emaGate = sp.get('emaGate') !== 'false'; // default on
    const forceRefresh = sp.get('refresh') === 'true';
    const data = await runRsStrategy({ period, rsiMin, emaGate }, forceRefresh);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Failed to run RS strategy scan:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to run the RS strategy scan' },
      { status: 500 },
    );
  }
}
