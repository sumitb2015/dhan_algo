import { NextResponse } from 'next/server';
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

let cachedQuotes: { data: Record<string, IndexQuote>; ts: number } | null = null;
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

// Shared by CRUDEOIL/CRUDEOILM, which have no historical-CSV close to fall
// back to (unlike NIFTY/SENSEX above) — just the script's own prev_close,
// with a last-resort literal if even that call fails.
function buildIndexQuote(
  res: PromiseSettledResult<{ spot?: number; prev_close?: number; error?: string } | null>,
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

export async function GET() {
  if (cachedQuotes && Date.now() - cachedQuotes.ts < CACHE_TTL_MS) {
    return NextResponse.json({
      success: true,
      quotes: cachedQuotes.data,
      updatedAt: new Date(cachedQuotes.ts).toISOString(),
    });
  }

  const quotes: Record<string, IndexQuote> = {};

  try {
    const [niftyRes, sensexRes, crudeoilRes, crudeoilmRes] = await Promise.allSettled([
      dedupe('indices:nifty', () =>
        spaced('dhan-indices:nifty', () =>
          runPythonJson<{
            spot?: number;
            prev_close?: number;
            change?: number;
            change_pct?: number;
            error?: string;
          }>(FETCH_SCRIPT, ['ltp', '--underlying', 'NIFTY'], 15_000)
        )
      ),
      dedupe('indices:sensex', () =>
        spaced('dhan-indices:sensex', () =>
          runPythonJson<{
            spot?: number;
            prev_close?: number;
            change?: number;
            change_pct?: number;
            error?: string;
          }>(FETCH_SCRIPT, ['ltp', '--underlying', 'SENSEX'], 15_000)
        )
      ),
      // CRUDEOIL/CRUDEOILM have no spot index — 'ltp' resolves the nearest
      // MCX FUTCOM contract and returns its own OHLC prev-close, so there's
      // no local historical-CSV fallback to read the way NIFTY/SENSEX have.
      dedupe('indices:crudeoil', () =>
        spaced('dhan-indices:crudeoil', () =>
          runPythonJson<{
            spot?: number;
            prev_close?: number;
            change?: number;
            change_pct?: number;
            error?: string;
          }>(FETCH_SCRIPT, ['ltp', '--underlying', 'CRUDEOIL'], 15_000)
        )
      ),
      dedupe('indices:crudeoilm', () =>
        spaced('dhan-indices:crudeoilm', () =>
          runPythonJson<{
            spot?: number;
            prev_close?: number;
            change?: number;
            change_pct?: number;
            error?: string;
          }>(FETCH_SCRIPT, ['ltp', '--underlying', 'CRUDEOILM'], 15_000)
        )
      ),
    ]);

    // Handle NIFTY
    let niftySpot = 0;
    let niftyPrev = getHistoricalNiftyClose() || 23779.15;
    let niftyChange = 0;
    let niftyPct = 0;

    if (niftyRes.status === 'fulfilled' && niftyRes.value && !niftyRes.value.error) {
      niftySpot = Number(niftyRes.value.spot ?? 0);
      if (Number(niftyRes.value.prev_close ?? 0) > 0) {
        niftyPrev = Number(niftyRes.value.prev_close);
      }
    }

    if (niftySpot <= 0) {
      niftySpot = niftyPrev;
    }

    if (niftyPrev > 0 && niftySpot > 0) {
      niftyChange = Math.round((niftySpot - niftyPrev) * 100) / 100;
      niftyPct = Math.round(((niftySpot - niftyPrev) / niftyPrev) * 10000) / 100;
    }

    quotes.NIFTY = {
      symbol: 'NIFTY',
      name: 'NIFTY 50',
      spot: niftySpot,
      prevClose: niftyPrev,
      change: niftyChange,
      changePct: niftyPct,
    };

    // Handle SENSEX
    let sensexSpot = 0;
    let sensexPrev = getHistoricalSensexClose() || 76132.81;
    let sensexChange = 0;
    let sensexPct = 0;

    if (sensexRes.status === 'fulfilled' && sensexRes.value && !sensexRes.value.error) {
      sensexSpot = Number(sensexRes.value.spot ?? 0);
      if (Number(sensexRes.value.prev_close ?? 0) > 0) {
        sensexPrev = Number(sensexRes.value.prev_close);
      }
    }

    if (sensexSpot <= 0) {
      sensexSpot = sensexPrev;
    }

    if (sensexPrev > 0 && sensexSpot > 0) {
      sensexChange = Math.round((sensexSpot - sensexPrev) * 100) / 100;
      sensexPct = Math.round(((sensexSpot - sensexPrev) / sensexPrev) * 10000) / 100;
    }

    quotes.SENSEX = {
      symbol: 'SENSEX',
      name: 'SENSEX',
      spot: sensexSpot,
      prevClose: sensexPrev,
      change: sensexChange,
      changePct: sensexPct,
    };

    quotes.CRUDEOIL = buildIndexQuote(crudeoilRes, 'CRUDEOIL', 'Crude Oil', 6000);
    quotes.CRUDEOILM = buildIndexQuote(crudeoilmRes, 'CRUDEOILM', 'Crude Oil Mini', 6000);

    cachedQuotes = { data: quotes, ts: Date.now() };

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
