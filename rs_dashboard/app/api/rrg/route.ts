// rs_dashboard/app/api/rrg/route.ts
import { NextRequest, NextResponse } from 'next/server';
import {
  KNOWN_INDICES,
  readIndexCSV,
  readNifty50Index,
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
 * Computes JdK RS-Ratio and RS-Momentum using the BennyThadikaran RRG-Lite formulas.
 */
function computeJdK(
  aligned: Array<{ date: string; stockClose: number; indexClose: number }>,
  lookback: number,
  windowSize: number,
  periodSize: number,
  method: 'EMA' | 'SMA'
): RRGPoint[] {
  const n = aligned.length;
  if (n === 0) return [];
  const rsRaw = aligned.map(r => (r.stockClose / r.indexClose) * 100);

  const rsRatioArr = new Array<number>(n).fill(NaN);
  
  if (method === 'EMA') {
    const alpha = 2 / (windowSize + 1);
    let mean = rsRaw[0];
    let variance = 0;
    rsRatioArr[0] = 100;
    
    for (let i = 1; i < n; i++) {
      mean = alpha * rsRaw[i] + (1 - alpha) * mean;
      variance = alpha * ((rsRaw[i] - mean) ** 2) + (1 - alpha) * variance;
      const std = Math.sqrt(variance);
      rsRatioArr[i] = std < 1e-8 ? 100 : 100 + (rsRaw[i] - mean) / std;
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
  const startIdx = method === 'EMA' ? periodSize + 1 : periodSize + 2 * windowSize - 2;
  
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
        if (i > firstValidIdx) {
          mean = alpha * rsRocArr[i] + (1 - alpha) * mean;
          variance = alpha * ((rsRocArr[i] - mean) ** 2) + (1 - alpha) * variance;
        }
        const std = Math.sqrt(variance);
        const momentum = std < 1e-8 ? 100 : 100 + (rsRocArr[i] - mean) / std;
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
  const method = (searchParams.get('method') ?? 'EMA') as 'EMA' | 'SMA';
  const lookback = Math.max(1, Math.min(1260, parseInt(searchParams.get('lookback') ?? '252', 10)));
  
  // Dynamic defaults: Weekly EMA: w=125, p=12; Daily EMA: w=100, p=14; Weekly SMA: w=14, p=52; Daily SMA: w=10, p=14
  const defaultWindow = timeframe === 'weekly' ? (method === 'EMA' ? 125 : 14) : (method === 'EMA' ? 100 : 10);
  const defaultPeriod = timeframe === 'weekly' ? (method === 'EMA' ? 12 : 52) : 14;

  const window = Math.max(2, Math.min(200, parseInt(searchParams.get('window') ?? String(defaultWindow), 10)));
  const period = Math.max(1, Math.min(200, parseInt(searchParams.get('period') ?? String(defaultPeriod), 10)));

  const cacheKey = `${universe}:${timeframe}:${window}:${period}:${method}`;
  const cached = rrgCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < TTL) {
    const sliced: RRGResponse = {
      ...cached.data,
      symbols: cached.data.symbols.map(s => ({ ...s, history: s.history.slice(-lookback) })),
    };
    return NextResponse.json({ success: true, data: sliced });
  }

  try {
    const benchmarkRows = readNifty50Index();

    // Build benchmark history (last 252 points, daily close)
    const benchmarkHistory = benchmarkRows.slice(-252).map(r => ({ date: r.date, close: r.close }));

    const symbolEntries: Array<{ symbol: string; label: string; rows: ReturnType<typeof readNifty50Index> }> =
      universe === 'indices'
        ? KNOWN_INDICES
            .filter(m => m.key !== 'INDIA_VIX' && m.key !== 'NIFTY50')
            .map(m => ({ symbol: m.key, label: m.label, rows: readIndexCSV(m) }))
        : await Promise.all(
            NIFTY50_SYMBOLS.map(async sym => ({ symbol: sym, label: sym, rows: await readStockCSVAsync(sym) }))
          );

    const seriesList: RRGSeries[] = [];
    for (let idx = 0; idx < symbolEntries.length; idx++) {
      const { symbol, label, rows } = symbolEntries[idx];
      if (rows.length === 0) continue;
      let aligned = alignByDate(rows, benchmarkRows);
      if (timeframe === 'weekly') aligned = toWeekly(aligned);
      const history = computeJdK(aligned, 1260, window, period, method); // cache full history; trim per-request
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

    const response: RRGResponse = { universe, timeframe, dataDate, symbols: seriesList, benchmarkHistory };
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
