import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { isPidRunning } from '@/lib/processCheck';
import { readNifty500List } from '@/lib/dataLoader';
import { readIndexConstituents } from '@/lib/indexConstituents';
import { buildIndiaDashboard, buildIndiaRow, parseConstituentRows, type RawDailyQuote, type RawIndexQuote } from '@/lib/indiaMarkets';

export const dynamic = 'force-dynamic';

// GET /api/india-markets - the India Markets dashboard view. READ-ONLY, no orders.
//   stocks:  debug/daily_market_quotes.json  (scripts/tools/daily_market_ws.py, started/stopped via /api/daily-market)
//   indices: debug/live_indices_quotes.json `indices` (scripts/tools/live_indices_ws.py, via /api/live-indices)
// Both files survive their bridge, so each feed reports its own state and age; the page must not call old quotes live.
const DEBUG_DIR = path.join(path.resolve(process.cwd(), '..'), 'debug');
const STOCK_QUOTES = path.join(DEBUG_DIR, 'daily_market_quotes.json');
const STOCK_STATUS = path.join(DEBUG_DIR, 'daily_market_status.json');
const INDEX_QUOTES = path.join(DEBUG_DIR, 'live_indices_quotes.json');
const INDEX_STATUS = path.join(DEBUG_DIR, 'live_indices_status.json');
const NIFTY500_CSV = path.join(path.resolve(process.cwd(), '..'), 'ind_nifty500list.csv');
const FRESH_MS = 15_000;

/** Symbol -> {company, industry} from NSE's Nifty 500 list (reference data), cached on mtime. */
let meta: { mtime: number; map: Map<string, { company: string; industry: string }> } | null = null;
function nifty500Meta(): Map<string, { company: string; industry: string }> {
  try {
    const mtime = fs.statSync(NIFTY500_CSV).mtimeMs;
    if (meta && meta.mtime === mtime) return meta.map;
    const map = new Map(parseConstituentRows(fs.readFileSync(NIFTY500_CSV, 'utf8')).map(r => [r.symbol, { company: r.company, industry: r.industry }]));
    meta = { mtime, map };
    return map;
  } catch { return meta?.map ?? new Map(); }
}

function readJson<T>(file: string): T | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return null; }
}

type FeedState = 'live' | 'starting' | 'stale' | 'stopped';
interface FeedInfo { state: FeedState; updatedAt: number | null; ageMs: number | null }

/** RUNNING with a live pid and a fresh snapshot = live; a live pid with an old snapshot = stale (wedged, or outside hours). */
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

export async function GET(): Promise<NextResponse> {
  const now = Date.now();
  const stocks = readJson<{ updated_at?: string; quotes?: Record<string, RawDailyQuote> }>(STOCK_QUOTES);
  const indices = readJson<{ updated_at?: string; indices?: Record<string, RawIndexQuote> }>(INDEX_QUOTES);

  // The universe is NSE's Nifty 500 list, so a stock the bridge has not sent yet still shows (as "no quote"), never vanishes.
  const universe = readNifty500List();
  const info = nifty500Meta();
  const rows = universe.map(sym => buildIndiaRow(sym, stocks?.quotes?.[sym], info.get(sym)?.industry || null, info.get(sym)?.company));
  const lists = new Map(readIndexConstituents().map(i => [i.key, i.symbols]));
  const dash = buildIndiaDashboard(rows, indices?.indices ?? {}, lists);

  return NextResponse.json({
    success: true,
    serverTime: now,
    feeds: {
      stocks: feed(STOCK_STATUS, stocks?.updated_at, now),
      indices: { ...feed(INDEX_STATUS, indices?.updated_at, now), hasAll: !!indices?.indices },
    },
    rows,
    ...dash,
  });
}
