import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'kotak_instruments_cache.py');
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function cacheFileFor(underlying: string): string {
  return path.join(PROJECT_ROOT, 'debug', `kotak_${underlying.toLowerCase()}_instruments.json`);
}

interface CachedInstrument {
  tradingsymbol: string;
  strike: number;
  expiry: string;
  instrument_type: 'CE' | 'PE';
}

async function ensureCache(underlying: string): Promise<CachedInstrument[]> {
  const cacheFile = cacheFileFor(underlying);
  const stale = !fs.existsSync(cacheFile) ||
    Date.now() - fs.statSync(cacheFile).mtimeMs > CACHE_MAX_AGE_MS;

  if (stale) {
    await dedupe(`kotak-instruments-cache:${underlying}`, () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, ['--underlying', underlying], 120_000));
  }
  return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CachedInstrument[];
}

/**
 * tradingSymbol -> {expiry, strike, side} across EVERY cached expiry for
 * `underlying`, not just one. Kotak's positions payload carries a trading
 * symbol and nothing else — no expiry, no strike, no side (see
 * lib/kotakShape.ts) — so a position on an expiry other than the one
 * currently selected in the scalper UI can't otherwise be identified well
 * enough to ask the live-quotes bridge for its price (see
 * /api/options/live's `watchExtra` action). Decoding the expiry out of the
 * symbol string itself would require reimplementing Kotak's epoch-based
 * expiry math client-side — exactly the kind of subtle date bug
 * kotak_instruments_cache.py's map_expiry_date already had to get right
 * once; reusing that cache sidesteps doing it again.
 */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();

  try {
    const all = await ensureCache(underlying);
    const symbols: Record<string, { expiry: string; strike: number; side: 'CE' | 'PE' }> = {};
    for (const r of all) {
      symbols[r.tradingsymbol] = { expiry: r.expiry, strike: r.strike, side: r.instrument_type };
    }
    return NextResponse.json({ success: true, data: symbols });
  } catch (err) {
    console.error('[scalper/kotak/symbol-lookup] error:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
