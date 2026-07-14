import { NextRequest, NextResponse } from 'next/server';
import { readStockCSVAsync, readNifty50Index, readNifty500Index, readNifty500List } from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { alignByDate, computeCurrentRS, buildRSResult, assignRSScores, RSResult } from '@/lib/rs';
import { getSector } from '@/lib/sectors';

const DEFAULT_LOOKBACK = 252; // default 1 year lookback for RS

// ─── Leaderboard cache ────────────────────────────────────────────────────────
interface LeaderboardCache {
  data: RSResult[];
  ts: number;
}
const lbCache = new Map<string, LeaderboardCache>();
const LB_TTL = 5 * 60 * 1000;

async function getLeaderboard(indexType: 'nifty50' | 'nifty500', lookback: number): Promise<RSResult[]> {
  const cacheKey = `${indexType}_${lookback}`;
  const cached = lbCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < LB_TTL) return cached.data;

  const symbols = indexType === 'nifty50' ? NIFTY50_SYMBOLS : readNifty500List();

  // Load benchmark
  const benchmarkRows =
    indexType === 'nifty50'
      ? readNifty50Index()
      : await readNifty500Index(readNifty500List());

  if (benchmarkRows.length === 0) {
    return [];
  }

  // Compute RS for each stock
  const partials: Array<Omit<RSResult, 'rsScore' | 'rsRating' | 'rsRank' | 'rsMomentum'>> = [];
  const ratios: Array<{ symbol: string; rsRatio: number }> = [];

  await Promise.all(
    symbols.map(async (symbol) => {
      const stockRows = await readStockCSVAsync(symbol);
      if (stockRows.length < 20) return;

      const aligned = alignByDate(stockRows, benchmarkRows);
      if (aligned.length < 20) return;

      const partial = buildRSResult(symbol, aligned, lookback);
      partials.push(partial);
      ratios.push({ symbol, rsRatio: partial.rsRatio });
    })
  );

  const scores = assignRSScores(ratios);

  const totalStocks = partials.length;
  const results: RSResult[] = partials.map((p) => {
    const s = scores.get(p.symbol) ?? { rsScore: 50, rsRating: 'C' as const, rsRank: Math.ceil(totalStocks / 2) };
    const rsMomentum: RSResult['rsMomentum'] =
      p.rsChange1W > 0.005 ? 'rising' : p.rsChange1W < -0.005 ? 'falling' : 'neutral';
    return {
      ...p,
      rsScore: s.rsScore,
      rsRating: s.rsRating,
      rsRank: s.rsRank,
      rsMomentum,
      sector: getSector(p.symbol),
    } as RSResult;
  });

  // Sort by RS score descending
  results.sort((a, b) => b.rsScore - a.rsScore);

  lbCache.set(cacheKey, { data: results, ts: Date.now() });
  return results;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const indexType = (searchParams.get('index') ?? 'nifty50') as 'nifty50' | 'nifty500';
  const lookbackStr = searchParams.get('lookback') ?? String(DEFAULT_LOOKBACK);
  let lookback = parseInt(lookbackStr, 10);
  if (isNaN(lookback) || ![50, 100, 252].includes(lookback)) {
    lookback = DEFAULT_LOOKBACK;
  }

  try {
    const data = await getLeaderboard(indexType, lookback);
    return NextResponse.json({ success: true, data, count: data.length });
  } catch (err) {
    console.error('[/api/stocks] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
