import { NextRequest, NextResponse } from 'next/server';
import { readStockCSVAsync, readNifty500List, readIndexCSV, KNOWN_INDICES, clearCache } from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { getSector } from '@/lib/sectors';
import type { OHLCVRow } from '@/lib/rs';

export interface DayEntry {
  date: string;
  pctChange: number;
  isUp: boolean;
}

export interface PersistenceResult {
  symbol: string;
  sector: string;
  latestClose: number;
  latestDate: string;
  days: DayEntry[];
  upCount: number;
  downCount: number;
  cumulative: number;
}

export interface MoversPlusResponse {
  winners: PersistenceResult[];
  losers: PersistenceResult[];
  sessions: number;
  minAppearances: number;
  dataDate: string;
  /** stocks dropped because their latest date was behind the consensus */
  staleCount: number;
}

// ─── Cache ─────────────────────────────────────────────────────────────────────
interface Cache { data: MoversPlusResponse; ts: number }
const cache = new Map<string, Cache>();
const TTL = 5 * 60 * 1000;

function buildPersistence(
  symbol: string,
  label: string,
  rows: OHLCVRow[],
  sessions: number,
): PersistenceResult | null {
  if (rows.length < sessions + 1) return null;

  const slice = rows.slice(-(sessions + 1));
  if (slice[0].close <= 0) return null;
  const days: DayEntry[] = [];
  for (let i = 1; i < slice.length; i++) {
    const prev = slice[i - 1].close;
    const curr = slice[i].close;
    if (prev <= 0) continue;
    const pct = ((curr - prev) / prev) * 100;
    // pct > 0 → up (gain), pct < 0 → down (loss), pct === 0 → flat (neutral)
    days.push({ date: slice[i].date, pctChange: pct, isUp: pct > 0 });
  }

  if (days.length === 0) return null;

  const upCount = days.filter((d) => d.isUp).length;
  // Flat sessions are neutral; they must not make a stock appear in losers.
  const downCount = days.filter((d) => d.pctChange < 0).length;
  // End-to-end return is compounded through the window. Summing daily
  // percentages is only an approximation and can be materially misleading.
  const cumulative = ((slice[slice.length - 1].close / slice[0].close) - 1) * 100;
  const last = slice[slice.length - 1];

  return {
    symbol,
    sector: label,
    latestClose: last.close,
    latestDate: last.date,
    days,
    upCount,
    downCount,
    cumulative,
  };
}

async function computeStockPersistence(symbol: string, sessions: number): Promise<PersistenceResult | null> {
  const rows = await readStockCSVAsync(symbol);
  return buildPersistence(symbol, getSector(symbol), rows, sessions);
}

function computeIndexPersistence(sessions: number): PersistenceResult[] {
  const out: PersistenceResult[] = [];
  for (const meta of KNOWN_INDICES) {
    const rows = readIndexCSV(meta);
    const r = buildPersistence(meta.key, meta.label, rows, sessions);
    if (r) out.push(r);
  }
  return out;
}

async function getMoversPlus(
  indexType: string,
  sessions: number,
  minAppearances: number,
): Promise<MoversPlusResponse> {
  const cacheKey = `${indexType}:${sessions}:${minAppearances}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.ts < TTL) return hit.data;

  let results: PersistenceResult[];
  if (indexType === 'indices') {
    results = computeIndexPersistence(sessions);
  } else {
    const symbols = indexType === 'nifty50' ? NIFTY50_SYMBOLS : readNifty500List();
    results = [];
    await Promise.all(
      symbols.map(async (sym) => {
        const r = await computeStockPersistence(sym, sessions);
        if (r) results.push(r);
      })
    );
  }

  // Consensus latest date = the most recent date present across all stocks.
  // Stocks that lag behind (suspended, delisted, or data not yet refreshed) are
  // excluded so that their squares don't represent different trading days to others.
  const dataDate = results.reduce(
    (best, r) => (r.latestDate > best ? r.latestDate : best),
    '',
  );

  const fresh = results.filter((r) => r.latestDate === dataDate);
  const staleCount = results.length - fresh.length;

  const winners = fresh
    .filter((r) => r.upCount >= minAppearances)
    .sort((a, b) => b.upCount - a.upCount || b.cumulative - a.cumulative);

  const losers = fresh
    .filter((r) => r.downCount >= minAppearances)
    .sort((a, b) => b.downCount - a.downCount || a.cumulative - b.cumulative);

  const response: MoversPlusResponse = {
    winners,
    losers,
    sessions,
    minAppearances,
    dataDate,
    staleCount,
  };

  cache.set(cacheKey, { data: response, ts: Date.now() });
  return response;
}

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const requestedIndex = searchParams.get('index');
  const indexType = requestedIndex === 'nifty50' || requestedIndex === 'nifty500' || requestedIndex === 'indices'
    ? requestedIndex
    : 'nifty50';
  const parsedSessions = Number.parseInt(searchParams.get('sessions') ?? '', 10);
  const sessions = Number.isFinite(parsedSessions)
    ? Math.min(60, Math.max(3, parsedSessions))
    : 10;
  const parsedMin = Number.parseInt(searchParams.get('min') ?? '', 10);
  const minAppearances = Number.isFinite(parsedMin)
    ? Math.min(sessions, Math.max(1, parsedMin))
    : 2;
  const bust = searchParams.has('bust');

  if (bust) {
    cache.clear();
    clearCache(); // flush readStockCSV + today_quotes caches in dataLoader
  }

  try {
    const data = await getMoversPlus(indexType, sessions, minAppearances);
    return NextResponse.json(data);
  } catch (err) {
    console.error('[movers-plus]', err);
    return NextResponse.json({ error: 'Failed' }, { status: 500 });
  }
}
