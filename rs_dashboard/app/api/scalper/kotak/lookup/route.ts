import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'kotak_instruments_cache.py');
// Shorter than the Zerodha cache's 24h: Kotak's master is published per trading
// day and carries the freeze quantity, so a day-old copy can misprice a slice.
const CACHE_MAX_AGE_MS = 12 * 60 * 60 * 1000;

function cacheFileFor(underlying: string): string {
  return path.join(PROJECT_ROOT, 'debug', `kotak_${underlying.toLowerCase()}_instruments.json`);
}

interface CachedInstrument {
  tradingsymbol: string;
  instrument_token: string;
  strike: number;
  expiry: string;
  instrument_type: 'CE' | 'PE';
  lot_size: number;
  exchange_segment: string;
  freeze_qty: number;
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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const underlying = (searchParams.get('underlying') ?? 'NIFTY').toUpperCase();
  const expiry = searchParams.get('expiry') ?? '';

  if (!expiry) {
    return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
  }

  try {
    const all = await ensureCache(underlying);
    const rows = all.filter(r => r.expiry === expiry);
    if (!rows.length) {
      return NextResponse.json({ success: false, error: `No Kotak options found for ${underlying} ${expiry}` });
    }

    const strikes: Record<string, { ceSymbol?: string; peSymbol?: string }> = {};
    let lotSize = 75;
    let exchangeSegment = 'nse_fo';
    for (const r of rows) {
      lotSize = r.lot_size || lotSize;
      exchangeSegment = r.exchange_segment || exchangeSegment;
      const key = String(Math.round(r.strike));
      if (!strikes[key]) strikes[key] = {};
      if (r.instrument_type === 'CE') strikes[key].ceSymbol = r.tradingsymbol;
      else strikes[key].peSymbol = r.tradingsymbol;
    }

    return NextResponse.json({ success: true, data: { lotSize, strikes, exchangeSegment } });
  } catch (err) {
    console.error('[scalper/kotak/lookup] error:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
