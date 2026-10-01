import { NextResponse } from 'next/server';
import { readEquityPortfolio, type EquityHolding } from '@/lib/dhanEquityPortfolio';
import { dedupe } from '@/lib/pyExec';

// Read-only: current Dhan holdings + today's NSE equity positions, keyed by symbol, so a screener
// table can show "what do I already own" next to each row. Short server cache keeps several tabs
// (and the table's own poll) from hammering Dhan's data API.

const TTL_MS = 10_000;
let cache: { at: number; data: Record<string, EquityHolding> } | null = null;

export async function GET(req: Request) {
  const fresh = new URL(req.url).searchParams.get('refresh') === 'true';
  try {
    if (!fresh && cache && Date.now() - cache.at < TTL_MS) {
      return NextResponse.json({ success: true, data: cache.data, asOf: cache.at });
    }
    const data = await dedupe('eq-holdings', () => readEquityPortfolio());
    cache = { at: Date.now(), data };
    return NextResponse.json({ success: true, data, asOf: cache.at });
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not read Dhan holdings: ${String((e as Error).message ?? e)}` }, { status: 502 });
  }
}
