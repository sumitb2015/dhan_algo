import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { isPidRunning } from '@/lib/processCheck';
import { readNiftyWeights } from '@/lib/niftyWeights';
import { computeContributions, type QuoteIn } from '@/lib/niftyContribution';

export const dynamic = 'force-dynamic';

// GET /api/nifty-contribution - per-stock Nifty 50 point contribution. READ-ONLY, no orders.
//   stocks: debug/daily_market_quotes.json (scripts/tools/daily_market_ws.py, via /api/daily-market) - the Nifty 500
//           feed, which carries every current Nifty 50 name; live_equity_quotes.json is not used because its
//           hardcoded list predates the latest rebalance.
//   index:  debug/live_indices_quotes.json `quotes.NIFTY` (scripts/tools/live_indices_ws.py, via /api/live-indices)
//   weights: index_constituents/nifty50_weights.csv (reference data)
// Both quote files outlive their bridge, so each feed reports its own state and age.
const DEBUG_DIR = path.join(path.resolve(process.cwd(), '..'), 'debug');
const STOCK_QUOTES = path.join(DEBUG_DIR, 'daily_market_quotes.json');
const STOCK_STATUS = path.join(DEBUG_DIR, 'daily_market_status.json');
const INDEX_QUOTES = path.join(DEBUG_DIR, 'live_indices_quotes.json');
const INDEX_STATUS = path.join(DEBUG_DIR, 'live_indices_status.json');
const FRESH_MS = 15_000;

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

type FeedState = 'live' | 'starting' | 'stale' | 'stopped';
interface FeedInfo { state: FeedState; updatedAt: number | null; ageMs: number | null }

/** RUNNING with a live pid and a fresh snapshot = live; a live pid with an old snapshot = stale. */
function feed(statusFile: string, updatedAt: string | undefined, now: number): FeedInfo {
  const st = readJson<{ status?: string; pid?: number }>(statusFile);
  const t = updatedAt ? Date.parse(updatedAt) : NaN;
  const at = Number.isFinite(t) ? t : null;
  const ageMs = at != null ? Math.max(0, now - at) : null;
  const alive = typeof st?.pid === 'number' && (st.status === 'RUNNING' || st.status === 'STARTING') && isPidRunning(st.pid);
  let state: FeedState = 'stopped';
  if (alive) state = st?.status === 'STARTING' ? 'starting' : ageMs != null && ageMs < FRESH_MS ? 'live' : 'stale';
  return { state, updatedAt: at, ageMs };
}

const pos = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null);

interface RawStock { source?: string; ltp?: number; prev_close?: number }
interface RawIndex { ltp?: number; prev_close?: number | null; change?: number | null }

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  const stocks = readJson<{ updated_at?: string; quotes?: Record<string, RawStock> }>(STOCK_QUOTES);
  const indices = readJson<{ updated_at?: string; quotes?: Record<string, RawIndex> }>(INDEX_QUOTES);
  const weights = readNiftyWeights();
  if (weights.rows.length === 0) {
    return NextResponse.json({
      success: false,
      error: 'index_constituents/nifty50_weights.csv is missing or empty - run scripts/tools/refresh_nifty_weights.py',
    }, { status: 500 });
  }

  // source 'none' = no price today (the LTP is just yesterday's close), so it is a missing quote, not a flat one.
  const quotes: Record<string, QuoteIn | undefined> = {};
  for (const [sym, q] of Object.entries(stocks?.quotes ?? {})) {
    const ltp = pos(q.ltp), prevClose = pos(q.prev_close);
    if (q.source !== 'none' && ltp != null && prevClose != null) quotes[sym] = { ltp, prevClose };
  }

  const n = indices?.quotes?.NIFTY;
  const nLtp = pos(n?.ltp), nPrev = pos(n?.prev_close);
  const nifty = nLtp != null && nPrev != null ? { ltp: nLtp, prevClose: nPrev, change: nLtp - nPrev } : null;

  return NextResponse.json({
    success: true,
    serverTime: now,
    weightsAsOf: weights.asOf,
    feeds: {
      stocks: feed(STOCK_STATUS, stocks?.updated_at, now),
      indices: feed(INDEX_STATUS, indices?.updated_at, now),
    },
    nifty: nifty && { ...nifty, changePct: (nifty.change / nifty.prevClose) * 100 },
    result: computeContributions(weights.rows, quotes, nifty),
  });
}
