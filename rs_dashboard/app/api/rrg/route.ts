// rs_dashboard/app/api/rrg/route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  KNOWN_INDICES,
  readIndexCSV,
  readNifty50Index,
  readStockCSV,
} from '@/lib/dataLoader';
import { alignByDate } from '@/lib/rs';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface RRGPoint {
  date: string;
  rsRatio: number;
  rsMomentum: number;
}

export interface RRGSeries {
  symbol: string;
  label: string;
  color: string;
  history: RRGPoint[];
}

export interface RRGResponse {
  universe: 'indices' | 'nifty50';
  timeframe: 'daily' | 'weekly';
  dataDate: string;
  symbols: RRGSeries[];
}

// ── Palette ───────────────────────────────────────────────────────────────────

const PALETTE = [
  '#60a5fa', '#f59e0b', '#a78bfa', '#34d399', '#f87171',
  '#fb923c', '#94a3b8', '#e879f9', '#fbbf24', '#4ade80',
  '#38bdf8', '#c084fc', '#fdba74', '#86efac', '#fca5a5',
  '#6ee7b7', '#93c5fd', '#fb7185', '#a3e635', '#fde68a',
  '#d8b4fe', '#cbd5e1', '#99f6e4', '#e9d5ff', '#c4b5fd',
  '#fcd34d', '#7dd3fc',
];

// ── Math ──────────────────────────────────────────────────────────────────────

const WINDOW = 10;

function rollingMean(arr: number[], i: number): number {
  let sum = 0;
  for (let j = i - WINDOW + 1; j <= i; j++) sum += arr[j];
  return sum / WINDOW;
}

function rollingStd(arr: number[], i: number): number {
  const mean = rollingMean(arr, i);
  let sq = 0;
  for (let j = i - WINDOW + 1; j <= i; j++) sq += (arr[j] - mean) ** 2;
  return Math.sqrt(sq / WINDOW);
}

/**
 * Computes JdK RS-Ratio and RS-Momentum for a symbol aligned with benchmark.
 * Returns last `lookback` valid points (chronological).
 *
 * RS_raw(t)      = stockClose(t) / indexClose(t) × 100
 * RS_Ratio(t)    = 100 + (RS_raw(t) − SMA10(RS_raw)(t)) / STDEV10(RS_raw)(t)
 * RS_Momentum(t) = 100 + (RS_Ratio(t) − SMA10(RS_Ratio)(t)) / STDEV10(RS_Ratio)(t)
 *
 * First valid RS_Ratio: i = WINDOW-1 = 9
 * First valid RS_Momentum: i = 2*WINDOW-2 = 18  (needs STDEV of RS_Ratio over 10 pts)
 */
function computeJdK(
  aligned: Array<{ date: string; stockClose: number; indexClose: number }>,
  lookback: number
): RRGPoint[] {
  const n = aligned.length;
  const rsRaw = aligned.map(r => (r.stockClose / r.indexClose) * 100);

  const rsRatioArr = new Array<number>(n).fill(NaN);
  for (let i = WINDOW - 1; i < n; i++) {
    const std = rollingStd(rsRaw, i);
    rsRatioArr[i] = std === 0 ? 100 : 100 + (rsRaw[i] - rollingMean(rsRaw, i)) / std;
  }

  const result: RRGPoint[] = [];
  for (let i = 2 * WINDOW - 2; i < n; i++) {
    const std = rollingStd(rsRatioArr, i);
    const momentum = std === 0 ? 100 : 100 + (rsRatioArr[i] - rollingMean(rsRatioArr, i)) / std;
    result.push({ date: aligned[i].date, rsRatio: rsRatioArr[i], rsMomentum: momentum });
  }

  return result.slice(-lookback);
}

// ── Weekly downsampling ───────────────────────────────────────────────────────

function toWeekly<T extends { date: string }>(rows: T[]): T[] {
  const weeks = new Map<string, T>();
  for (const row of rows) {
    const d = new Date(row.date);
    const monday = new Date(row.date);  // fresh Date from string
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    weeks.set(key, row); // last trading day of each week wins
  }
  return [...weeks.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ── Cache ─────────────────────────────────────────────────────────────────────

interface RRGCacheEntry { data: RRGResponse; ts: number; }
const rrgCache = new Map<string, RRGCacheEntry>();
const TTL = 5 * 60 * 1000;

// ── Handler ───────────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const universe = (searchParams.get('universe') ?? 'indices') as 'indices' | 'nifty50';
  const timeframe = (searchParams.get('timeframe') ?? 'daily') as 'daily' | 'weekly';
  const lookback = Math.max(1, Math.min(1260, parseInt(searchParams.get('lookback') ?? '252', 10)));

  const cacheKey = `${universe}:${timeframe}`;
  const cached = rrgCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL) {
    const sliced = {
      ...cached.data,
      symbols: cached.data.symbols.map(s => ({ ...s, history: s.history.slice(-lookback) })),
    };
    return NextResponse.json({ success: true, data: sliced });
  }

  try {
    const benchmarkRows = readNifty50Index();

    const symbolEntries: Array<{ symbol: string; label: string; rows: ReturnType<typeof readNifty50Index> }> =
      universe === 'indices'
        ? KNOWN_INDICES
            .filter(m => m.key !== 'INDIA_VIX' && m.key !== 'NIFTY50')
            .map(m => ({ symbol: m.key, label: m.label, rows: readIndexCSV(m) }))
        : NIFTY50_SYMBOLS.map(sym => ({ symbol: sym, label: sym, rows: readStockCSV(sym) }));

    const seriesList: RRGSeries[] = [];
    for (let idx = 0; idx < symbolEntries.length; idx++) {
      const { symbol, label, rows } = symbolEntries[idx];
      if (rows.length === 0) continue;
      let aligned = alignByDate(rows, benchmarkRows);
      if (timeframe === 'weekly') aligned = toWeekly(aligned);
      const history = computeJdK(aligned, 1260); // cache full history; trim per-request
      if (history.length === 0) continue;
      seriesList.push({ symbol, label, color: PALETTE[idx % PALETTE.length], history });
    }

    const dataDate = seriesList.reduce((best, s) => {
      const last = s.history[s.history.length - 1]?.date ?? '';
      return last > best ? last : best;
    }, '');

    const response: RRGResponse = { universe, timeframe, dataDate, symbols: seriesList };
    rrgCache.set(cacheKey, { data: response, ts: Date.now() });

    const sliced = {
      ...response,
      symbols: response.symbols.map(s => ({ ...s, history: s.history.slice(-lookback) })),
    };
    return NextResponse.json({ success: true, data: sliced });
  } catch (err) {
    return NextResponse.json(
      { success: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    );
  }
}
