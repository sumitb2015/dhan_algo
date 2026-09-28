import { NextRequest, NextResponse } from 'next/server';
import { readStockCSVAsync, readNifty500List, clearCache } from '@/lib/dataLoader';
import { computeRankingStock, modalDate, type RankingStock } from '@/lib/rankingFactors';

export interface RankingStockWithStatus extends RankingStock {
  /** Last session is older than the universe's data date — its returns are measured to a different day. */
  stale: boolean;
}

export interface StockRankingResponse {
  dataDate: string;
  stocks: RankingStockWithStatus[];
  /** Universe symbols with no CSV, or fewer than 2 real sessions. */
  missing: string[];
}

const TTL_MS = 5 * 60 * 1000;
let cached: { data: StockRankingResponse; ts: number } | null = null;
let inflight: Promise<StockRankingResponse> | null = null;
// Bumped on ?bust so a build that started before the bust can neither be
// handed to the busting caller nor write its pre-bust result into the cache.
let generation = 0;

async function build(): Promise<StockRankingResponse> {
  const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
  const symbols = readNifty500List();
  const results = await Promise.all(
    symbols.map(async symbol => computeRankingStock(symbol, await readStockCSVAsync(symbol), todayIST)),
  );

  const loaded = results.filter((s): s is RankingStock => s !== null);
  const missing = symbols.filter((_, i) => results[i] === null);
  const dataDate = modalDate(loaded.map(s => s.latestDate));

  return {
    dataDate,
    stocks: loaded
      .map(s => ({ ...s, stale: s.latestDate < dataDate }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol)),
    missing,
  };
}

async function getRanking(): Promise<StockRankingResponse> {
  if (cached && Date.now() - cached.ts < TTL_MS) return cached.data;
  if (!inflight) {
    const gen = generation;
    const p: Promise<StockRankingResponse> = build()
      .then(data => {
        if (gen === generation) cached = { data, ts: Date.now() };
        return data;
      })
      .finally(() => { if (inflight === p) inflight = null; });
    inflight = p;
  }
  return inflight;
}

export async function GET(request: NextRequest) {
  if (new URL(request.url).searchParams.has('bust')) {
    generation++;
    cached = null;
    inflight = null;
    clearCache();
  }
  try {
    return NextResponse.json({ success: true, data: await getRanking() });
  } catch (err) {
    console.error('[/api/stock-ranking] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
