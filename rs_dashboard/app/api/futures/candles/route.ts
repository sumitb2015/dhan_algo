import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';
import type { CandleData } from '@/app/api/nifty-oi-profile/route';

const SCRIPT_PATH = path.join(PROJECT_ROOT, 'scripts', 'tools', 'futures_candles_fetch.py');

interface FuturesCandlesResult {
  candles: CandleData[];
  source: 'future' | 'index' | null;
  error?: string;
}

interface CacheEntry {
  data: FuturesCandlesResult;
  ts: number;
}

const serverCache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 30_000;

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const symbol = (searchParams.get('symbol') ?? 'NIFTY').toUpperCase();
  if (symbol !== 'NIFTY' && symbol !== 'BANKNIFTY') {
    return NextResponse.json({ success: false, error: 'symbol must be NIFTY or BANKNIFTY' }, { status: 400 });
  }
  const days = searchParams.get('days') ?? '5';

  const cacheKey = `futures-candles:${symbol}:${days}`;
  const hit = serverCache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json({ success: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
  }

  try {
    const data = await dedupe(cacheKey, () =>
      spaced('dhan-spawn:futures-candles', () =>
        runPythonJson<FuturesCandlesResult>(
          SCRIPT_PATH,
          ['--symbol', symbol, '--days', days],
          30_000
        )
      )
    );

    if (data.error) {
      return NextResponse.json({ success: false, error: data.error }, { status: 500 });
    }

    serverCache.set(cacheKey, { data, ts: Date.now() });
    return NextResponse.json({ success: true, ...data }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (hit) {
      return NextResponse.json({ success: true, ...hit.data }, { headers: { 'Cache-Control': 'no-store' } });
    }
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
