import { NextRequest, NextResponse } from 'next/server';
import { readNifty50Index, readNifty500IndexSync } from '@/lib/dataLoader';
import { calculateMarketRegime, MarketRegimeAnalysis } from '@/lib/marketRegime';

interface CacheEntry {
  data: {
    selected: MarketRegimeAnalysis;
    nifty50: {
      status: string;
      statusLabel: string;
      tone: string;
      activeCount: number;
      price: number;
      change1D: number;
    };
    nifty500: {
      status: string;
      statusLabel: string;
      tone: string;
      activeCount: number;
      price: number;
      change1D: number;
    };
    dataDate: string;
  };
  ts: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60 * 1000; // 1 minute

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = req.nextUrl;
    const indexParam = (searchParams.get('index') || 'NIFTY50').toUpperCase();
    const lookback = parseInt(searchParams.get('lookback') || '250', 10);
    const forceRefresh = searchParams.get('refresh') === 'true';

    const cacheKey = `${indexParam}_${lookback}`;
    const now = Date.now();

    if (!forceRefresh) {
      const cached = cache.get(cacheKey);
      if (cached && now - cached.ts < CACHE_TTL_MS) {
        return NextResponse.json(cached.data);
      }
    }

    const n50Rows = readNifty50Index();
    const n500Rows = readNifty500IndexSync();

    const n50Analysis = calculateMarketRegime(n50Rows, 'NIFTY50', lookback);
    const n500Analysis = calculateMarketRegime(n500Rows, 'NIFTY500', lookback);

    const selected = indexParam === 'NIFTY500' ? n500Analysis : n50Analysis;

    const responsePayload = {
      selected,
      nifty50: {
        status: n50Analysis.status,
        statusLabel: n50Analysis.statusLabel,
        tone: n50Analysis.tone,
        activeCount: n50Analysis.activeDistributionCount,
        price: n50Analysis.currentPrice,
        change1D: n50Analysis.change1D,
      },
      nifty500: {
        status: n500Analysis.status,
        statusLabel: n500Analysis.statusLabel,
        tone: n500Analysis.tone,
        activeCount: n500Analysis.activeDistributionCount,
        price: n500Analysis.currentPrice,
        change1D: n500Analysis.change1D,
      },
      dataDate: selected.dataDate,
    };

    cache.set(cacheKey, { data: responsePayload, ts: now });

    return NextResponse.json(responsePayload);
  } catch (error) {
    console.error('Failed to calculate market regime:', error);
    return NextResponse.json(
      { error: 'Failed to calculate institutional market regime' },
      { status: 500 }
    );
  }
}
