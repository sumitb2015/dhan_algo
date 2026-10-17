import { NextResponse } from 'next/server';
import { readEquityPortfolio, type EquityHolding } from '@/lib/dhanEquityPortfolio';
import { readKotakEquityPortfolio } from '@/lib/kotakEquityPortfolio';
import { dedupe } from '@/lib/pyExec';

// Read-only: current Dhan holdings + today's NSE equity positions, keyed by symbol, so a screener
// table can show "what do I already own" next to each row. Short server cache keeps several tabs
// (and the table's own poll) from hammering Dhan's data API.

const TTL_MS = 10_000;
const cache: Record<'dhan' | 'kotak', { at: number; data: Record<string, EquityHolding> } | null> = { dhan: null, kotak: null };

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const fresh = params.get('refresh') === 'true';
  const broker = params.get('broker') === 'kotak' ? 'kotak' : 'dhan';
  try {
    const hit = cache[broker];
    if (!fresh && hit && Date.now() - hit.at < TTL_MS) {
      return NextResponse.json({ success: true, data: hit.data, asOf: hit.at, broker });
    }
    const data = await dedupe(`eq-holdings:${broker}`, () => (broker === 'kotak' ? readKotakEquityPortfolio() : readEquityPortfolio()));
    cache[broker] = { at: Date.now(), data };
    return NextResponse.json({ success: true, data, asOf: cache[broker]!.at, broker });
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not read ${broker === 'kotak' ? 'Kotak' : 'Dhan'} holdings: ${String((e as Error).message ?? e)}` }, { status: 502 });
  }
}
