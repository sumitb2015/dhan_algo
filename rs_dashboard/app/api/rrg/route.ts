export const dynamic = 'force-dynamic';
export const revalidate = 0;

import { NextRequest, NextResponse } from 'next/server';
import {
  KNOWN_INDICES,
  readIndexCSV,
  readNifty50Index,
  readNifty500IndexSync,
  readStockCSVAsync,
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
  latestClose: number;
  priceChange1D: number; // percent
}

export interface RRGResponse {
  universe: 'indices' | 'nifty50';
  timeframe: 'daily' | 'weekly';
  benchmark: 'nifty500' | 'nifty50';
  dataDate: string;
  symbols: RRGSeries[];
  benchmarkHistory: Array<{ date: string; close: number }>;
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

function rollingMean(arr: number[], i: number, windowSize: number): number {
  let sum = 0;
  for (let j = i - windowSize + 1; j <= i; j++) sum += arr[j];
  return sum / windowSize;
}

function rollingStd(arr: number[], i: number, windowSize: number): number {
  const mean = rollingMean(arr, i, windowSize);
  let sq = 0;
  for (let j = i - windowSize + 1; j <= i; j++) {
    if (!isNaN(arr[j])) {
      sq += (arr[j] - mean) ** 2;
    }
  }
  const divisor = windowSize - 1;
  return divisor <= 0 ? 0 : Math.sqrt(sq / divisor);
}

/**
 * Computes JdK RS-Ratio and RS-Momentum using:
 * 1. RATIO: Dhan Broker / Optuma Official Formula (EMA 14 / EMA 125 Ratio)
 * 2. EMA: Exponential Moving Z-score
 * 3. SMA: Simple Moving Z-score
 */
function computeJdK(
  aligned: Array<{ date: string; stockClose: number; indexClose: number }>,
  lookback: number,
  windowSize: number,
  periodSize: number,
  method: 'RATIO' | 'EMA' | 'SMA'
): RRGPoint[] {
  const n = aligned.length;
  if (n === 0) return [];
  const rsRaw = aligned.map(r => (r.stockClose / r.indexClose) * 100);

  if (method === 'RATIO') {
    // Dhan Broker / Optuma Ratio Formula:
    // RS-Raw = 100 * (Stock / Benchmark)
    // Strength Trend (RS-Ratio) = 100 * (EMA(RS_raw, 10) / EMA(RS_raw, 17))
    // Strength Momentum (RS-Momentum) = 100 + 10 * (Strength Trend(t) - Strength Trend(t-2))
    const fastAlpha = 2 / (10 + 1);
    const slowAlpha = 2 / (17 + 1);

    let emaFast = rsRaw[0];
    let emaSlow = rsRaw[0];
    const rsRatioArr = new Array<number>(n).fill(100);

    for (let i = 0; i < n; i++) {
      emaFast = fastAlpha * rsRaw[i] + (1 - fastAlpha) * emaFast;
      emaSlow = slowAlpha * rsRaw[i] + (1 - slowAlpha) * emaSlow;
      rsRatioArr[i] = emaSlow === 0 ? 100 : 100 * (emaFast / emaSlow);
    }

    const result: RRGPoint[] = [];
    const startIdx = Math.min(100, Math.floor(n / 3));

    for (let i = 0; i < n; i++) {
      const prevTrend = i >= 2 ? rsRatioArr[i - 2] : rsRatioArr[i];
      const momentum = 100.0 + 10.0 * (rsRatioArr[i] - prevTrend);
      if (i >= startIdx) {
        result.push({ date: aligned[i].date, rsRatio: rsRatioArr[i], rsMomentum: momentum });
      }
    }
    return result.slice(-lookback);
  }

  const rsRatioArr = new Array<number>(n).fill(NaN);
  
  if (method === 'EMA') {
    const alpha = 2 / (windowSize + 1);
    let mean = rsRaw[0];
    let variance = 0;
    
    for (let i = 0; i < n; i++) {
      const val = rsRaw[i];
      const delta = val - mean;
      mean += alpha * delta;
      variance = (1 - alpha) * (variance + alpha * (delta ** 2));
      const std = Math.sqrt(Math.max(0, variance));
      rsRatioArr[i] = std < 1e-8 ? 100 : 100 + delta / std;
    }
  } else {
    for (let i = windowSize - 1; i < n; i++) {
      const std = rollingStd(rsRaw, i, windowSize);
      rsRatioArr[i] = std === 0 ? 100 : 100 + (rsRaw[i] - rollingMean(rsRaw, i, windowSize)) / std;
    }
  }

  const rsRocArr = new Array<number>(n).fill(NaN);
  for (let i = periodSize; i < n; i++) {
    const baseRs = rsRatioArr[i - periodSize];
    if (isNaN(baseRs) || baseRs === 0) continue;
    rsRocArr[i] = ((rsRatioArr[i] / baseRs) - 1) * 100;
  }

  const result: RRGPoint[] = [];
  const startIdx = method === 'EMA' ? Math.max(periodSize + 10, windowSize) : periodSize + 2 * windowSize - 2;
  
  if (method === 'EMA') {
    const alpha = 2 / (windowSize + 1);
    let firstValidIdx = -1;
    for (let i = 0; i < n; i++) {
      if (!isNaN(rsRocArr[i])) {
        firstValidIdx = i;
        break;
      }
    }
    
    if (firstValidIdx !== -1) {
      let mean = rsRocArr[firstValidIdx];
      let variance = 0;
      
      for (let i = firstValidIdx; i < n; i++) {
        const val = rsRocArr[i];
        const delta = val - mean;
        mean += alpha * delta;
        variance = (1 - alpha) * (variance + alpha * (delta ** 2));
        const std = Math.sqrt(Math.max(0, variance));
        const momentum = std < 1e-8 ? 100 : 100 + delta / std;
        if (!isNaN(rsRatioArr[i]) && !isNaN(momentum) && i >= startIdx) {
          result.push({ date: aligned[i].date, rsRatio: rsRatioArr[i], rsMomentum: momentum });
        }
      }
    }
  } else {
    for (let i = startIdx; i < n; i++) {
      const std = rollingStd(rsRocArr, i, windowSize);
      const momentum = std === 0 ? 100 : 100 + (rsRocArr[i] - rollingMean(rsRocArr, i, windowSize)) / std;
      if (isNaN(rsRatioArr[i]) || isNaN(momentum)) continue;
      result.push({ date: aligned[i].date, rsRatio: rsRatioArr[i], rsMomentum: momentum });
    }
  }

  return result.slice(-lookback);
}

// ── Weekly downsampling ───────────────────────────────────────────────────────

function toWeekly<T extends { date: string }>(rows: T[]): T[] {
  const weeks = new Map<string, T>();
  for (const row of rows) {
    const d = new Date(row.date);
    const monday = new Date(row.date);
    monday.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
    const key = monday.toISOString().slice(0, 10);
    weeks.set(key, row);
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
  const method = (searchParams.get('method') ?? 'RATIO') as 'RATIO' | 'EMA' | 'SMA';
  const benchmarkParam = (searchParams.get('benchmark') ?? (universe === 'indices' ? 'nifty500' : 'nifty50')) as 'nifty500' | 'nifty50';
  const lookback = Math.max(1, Math.min(1260, parseInt(searchParams.get('lookback') ?? '252', 10)));
  
  const defaultWindow = 14;
  const defaultPeriod = 1;

  const window = Math.max(2, Math.min(200, parseInt(searchParams.get('window') ?? String(defaultWindow), 10)));
  const period = Math.max(1, Math.min(200, parseInt(searchParams.get('period') ?? String(defaultPeriod), 10)));

  const cacheKey = `${universe}:${timeframe}:${benchmarkParam}:${window}:${period}:${method}`;
  const cached = rrgCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL) {
    const sliced: RRGResponse = {
      ...cached.data,
      symbols: cached.data.symbols.map(s => ({ ...s, history: s.history.slice(-lookback) })),
    };
    return NextResponse.json({ success: true, data: sliced });
  }

  try {
    const benchmarkRows = benchmarkParam === 'nifty500' ? readNifty500IndexSync() : readNifty50Index();

    // Build benchmark history
    const benchmarkHistory = benchmarkRows.slice(-252).map(r => ({ date: r.date, close: r.close }));

    const nifty50Rows = readNifty50Index();

    const symbolEntries: Array<{ symbol: string; label: string; rows: ReturnType<typeof readNifty50Index> }> =
      universe === 'indices'
        ? [
            // Include Nifty 50 as one of the sectors so it rotates against Nifty 500
            { symbol: 'NIFTY50', label: 'Nifty 50', rows: nifty50Rows },
            ...KNOWN_INDICES
              .filter(m => m.key !== 'INDIA_VIX' && m.key !== 'NIFTY50')
              .map(m => ({ symbol: m.key, label: m.label, rows: readIndexCSV(m) }))
          ]
        : await Promise.all(
            NIFTY50_SYMBOLS.map(async sym => ({ symbol: sym, label: sym, rows: await readStockCSVAsync(sym) }))
          );

    const seriesList: RRGSeries[] = [];
    for (let idx = 0; idx < symbolEntries.length; idx++) {
      const { symbol, label, rows } = symbolEntries[idx];
      if (rows.length === 0) continue;
      let aligned = alignByDate(rows, benchmarkRows);
      if (timeframe === 'weekly') aligned = toWeekly(aligned);
      const history = computeJdK(aligned, 1260, window, period, method);
      if (history.length === 0) continue;
      const latestClose = rows[rows.length - 1]?.close ?? 0;
      const prevClose = rows[rows.length - 2]?.close ?? latestClose;
      const priceChange1D = prevClose === 0 ? 0 : ((latestClose - prevClose) / prevClose) * 100;
      seriesList.push({ symbol, label, color: PALETTE[idx % PALETTE.length], history, latestClose, priceChange1D });
    }

    const dataDate = seriesList.reduce((best, s) => {
      const last = s.history[s.history.length - 1]?.date ?? '';
      return last > best ? last : best;
    }, '');

    const response: RRGResponse = { universe, timeframe, benchmark: benchmarkParam, dataDate, symbols: seriesList, benchmarkHistory };
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

