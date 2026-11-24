import { NextResponse } from 'next/server';
import { fetchHoldingsLive } from '@/lib/dhanEquityPortfolio';
import { dedupe } from '@/lib/pyExec';

// Read-only: the Dhan demat holdings (with Dhan's lastTradedPrice) for /index-scalper's Portfolio tab and Holding P&L.
// Display only; nothing sizes an order from it (the equity ticket keeps its own live read).
const TTL_MS = 15_000;
let cache: { at: number; data: Record<string, unknown>[] } | null = null;

export async function GET() {
  try {
    if (!cache || Date.now() - cache.at > TTL_MS) {
      const data = await dedupe('index-scalper:holdings', () => fetchHoldingsLive());
      cache = { at: Date.now(), data };
    }
    return NextResponse.json({ success: true, data: cache.data, asOf: cache.at }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    return NextResponse.json({ success: false, error: `Could not read Dhan holdings: ${String((e as Error).message ?? e)}` }, { status: 502 });
  }
}
