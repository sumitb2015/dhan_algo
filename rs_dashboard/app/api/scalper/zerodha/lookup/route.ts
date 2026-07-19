import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const CACHE_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'zerodha_instruments_cache.py');
const CACHE_FILE = path.join(PROJECT_ROOT, 'debug', 'zerodha_nifty_instruments.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedInstrument {
  tradingsymbol: string;
  instrument_token: number;
  strike: number;
  expiry: string;
  instrument_type: 'CE' | 'PE';
  lot_size: number;
}

async function ensureCache(): Promise<CachedInstrument[]> {
  const stale = !fs.existsSync(CACHE_FILE) ||
    Date.now() - fs.statSync(CACHE_FILE).mtimeMs > CACHE_MAX_AGE_MS;

  if (stale) {
    await dedupe('zerodha-instruments-cache', () =>
      runPythonJson<{ success: boolean; error?: string }>(CACHE_SCRIPT, [], 60_000));
  }
  return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')) as CachedInstrument[];
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(req.url);
  const expiry = searchParams.get('expiry') ?? '';

  if (!expiry) {
    return NextResponse.json({ success: false, error: 'expiry required' }, { status: 400 });
  }

  try {
    const all = await ensureCache();
    const rows = all.filter(r => r.expiry === expiry);
    if (!rows.length) {
      return NextResponse.json({ success: false, error: `No Zerodha options found for NIFTY ${expiry}` });
    }

    const strikes: Record<string, { ceSymbol?: string; peSymbol?: string }> = {};
    let lotSize = 75;
    for (const r of rows) {
      lotSize = r.lot_size || lotSize;
      const key = String(Math.round(r.strike));
      if (!strikes[key]) strikes[key] = {};
      if (r.instrument_type === 'CE') strikes[key].ceSymbol = r.tradingsymbol;
      else strikes[key].peSymbol = r.tradingsymbol;
    }

    return NextResponse.json({ success: true, data: { lotSize, strikes } });
  } catch (err) {
    console.error('[scalper/zerodha/lookup] error:', err);
    return NextResponse.json({ success: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
}
