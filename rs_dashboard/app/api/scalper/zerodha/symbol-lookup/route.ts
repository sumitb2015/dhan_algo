import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'zerodha_instruments_cache.py');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SUPPORTED = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX']);

interface CachedInstrument { tradingsymbol: string; strike: number; expiry: string; instrument_type: 'CE' | 'PE' }

async function ensureCache(underlying: string): Promise<CachedInstrument[]> {
  const cacheFile = path.join(PROJECT_ROOT, 'debug', `zerodha_${underlying.toLowerCase()}_instruments.json`);
  const stale = !fs.existsSync(cacheFile) || Date.now() - fs.statSync(cacheFile).mtimeMs > CACHE_MAX_AGE_MS;
  if (stale) {
    await dedupe(`zerodha-instruments-cache:${underlying}`, () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, ['--underlying', underlying], 60_000));
  }
  return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CachedInstrument[];
}

/**
 * tradingsymbol -> {expiry, strike, side} across EVERY cached expiry for `underlying`. A Kite position row carries
 * only a trading symbol, and a weekly one (NIFTY2610624500CE) holds no readable expiry, so Add Lots on a leg outside
 * the selected expiry resolves its contract here, from the instrument cache, never from a symbol parse.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const underlying = (new URL(req.url).searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  if (!SUPPORTED.has(underlying)) return NextResponse.json({ success: true, data: {} });
  try {
    const symbols: Record<string, { expiry: string; strike: number; side: 'CE' | 'PE' }> = {};
    for (const r of await ensureCache(underlying)) symbols[r.tradingsymbol] = { expiry: r.expiry, strike: r.strike, side: r.instrument_type };
    return NextResponse.json({ success: true, data: symbols });
  } catch (err) {
    console.error('[scalper/zerodha/symbol-lookup] error:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
