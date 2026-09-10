import { NextRequest, NextResponse } from 'next/server';
import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT, runPythonJson, dedupe, spaced } from '@/lib/pyExec';
import { readNifty50Index } from '@/lib/dataLoader';

const FETCH_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'options_data_fetch.py');
const SENSEX_CSV   = path.join(PROJECT_ROOT, 'Historical Data', 'Indices', 'SENSEX.csv');

interface IndexQuote {
  symbol: string;
  name: string;
  spot: number;
  prevClose: number;
  change: number;
  changePct: number;
  high?: number;
  low?: number;
}

type LtpResult = { spot?: number; prev_close?: number; change?: number; change_pct?: number; error?: string } | null;

// NIFTY + SENSEX feed the always-visible ticker strip, so every request
// fetches both. CRUDEOIL/CRUDEOILM are only ever needed when that's the
// underlying actually selected on the page, so they're fetched on demand via
// ?underlying= rather than unconditionally quadrupling the Python spawns
// (and MCX_COMM API calls) on every ~4s poll from every open tab.
const CRUDE_SYMBOLS = new Set(['CRUDEOIL', 'CRUDEOILM']);
const CRUDE_NAMES: Record<string, string> = { CRUDEOIL: 'Crude Oil', CRUDEOILM: 'Crude Oil Mini' };

// Keyed by the extra crude symbol requested (or 'base' for none) rather than
// true per-symbol caching — bounded to 3 possible keys, simple, and still
// eliminates the unconditional 4-spawns-per-poll cost.
const cache = new Map<string, { data: Record<string, IndexQuote>; ts: number }>();
const CACHE_TTL_MS = 2500; // 2.5 seconds cache

function getHistoricalNiftyClose(): number {
  try {
    const rows = readNifty50Index();
    if (rows.length >= 2) {
      const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
      const prevRows = rows.filter(r => r.date < today);
      return prevRows.length > 0 ? prevRows[prevRows.length - 1].close : rows[rows.length - 2].close;
    }
  } catch {}
  return 0;
}

function getHistoricalSensexClose(): number {
  try {
    if (!fs.existsSync(SENSEX_CSV)) return 0;
    const lines = fs.readFileSync(SENSEX_CSV, 'utf8').trim().split('\n');
    if (lines.length >= 2) {
      const lastLine = lines[lines.length - 1].split(',');
      const close = parseFloat(lastLine[4]);
      return isNaN(close) ? 0 : close;
    }
  } catch {}
  return 0;
}

function buildIndexQuote(
  res: PromiseSettledResult<LtpResult>,
  symbol: string,
  name: string,
  fallbackPrev: number,
): IndexQuote {
  let spot = 0;
  let prev = fallbackPrev;
  if (res.status === 'fulfilled' && res.value && !res.value.error) {
    spot = Number(res.value.spot ?? 0);
    if (Number(res.value.prev_close ?? 0) > 0) prev = Number(res.value.prev_close);
  }
  if (spot <= 0) spot = prev;
  let change = 0;
  let changePct = 0;
  if (prev > 0 && spot > 0) {
    change = Math.round((spot - prev) * 100) / 100;
    changePct = Math.round(((spot - prev) / prev) * 10000) / 100;
  }
  return { symbol, name, spot, prevClose: prev, change, changePct };
}

function fetchLtp(underlying: string): Promise<LtpResult> {
  return dedupe(`indices:${underlying.toLowerCase()}`, () =>
    spaced(`dhan-indices:${underlying.toLowerCase()}`, () =>
      runPythonJson<LtpResult>(FETCH_SCRIPT, ['ltp', '--underlying', underlying], 15_000)
    )
  );
}

export async function GET(request: NextRequest) {
  const requested = (request.nextUrl.searchParams.get('underlying') ?? '').toUpperCase();
  const extraSymbol = CRUDE_SYMBOLS.has(requested) ? requested : null;
  const cacheKey = extraSymbol ?? 'base';

  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) {
    return NextResponse.json({
      success: true,
      quotes: hit.data,
      updatedAt: new Date(hit.ts).toISOString(),
    });
  }

  const quotes: Record<string, IndexQuote> = {};

  try {
    const [niftyRes, sensexRes, extraRes] = await Promise.allSettled([
      fetchLtp('NIFTY'),
      fetchLtp('SENSEX'),
      // CRUDEOIL/CRUDEOILM have no spot index — 'ltp' resolves the nearest
      // MCX FUTCOM contract and returns its own OHLC prev-close, so there's
      // no local historical-CSV fallback to read the way NIFTY/SENSEX have.
      // Only fetched when actually requested — see CRUDE_SYMBOLS above.
      extraSymbol ? fetchLtp(extraSymbol) : Promise.resolve(null),
    ]);

    quotes.NIFTY = buildIndexQuote(niftyRes, 'NIFTY', 'NIFTY 50', getHistoricalNiftyClose() || 23779.15);
    quotes.SENSEX = buildIndexQuote(sensexRes, 'SENSEX', 'SENSEX', getHistoricalSensexClose() || 76132.81);

    if (extraSymbol) {
      quotes[extraSymbol] = buildIndexQuote(extraRes, extraSymbol, CRUDE_NAMES[extraSymbol], 6000);
    }

    cache.set(cacheKey, { data: quotes, ts: Date.now() });

    return NextResponse.json({
      success: true,
      quotes,
      updatedAt: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[/api/synthetic-futures/indices] error:', err);
    return NextResponse.json({
      success: false,
      error: 'Failed to fetch index quotes',
    }, { status: 500 });
  }
}
