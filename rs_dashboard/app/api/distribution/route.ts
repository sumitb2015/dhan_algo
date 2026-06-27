import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV, readNifty50Index, readNifty500List } from '@/lib/dataLoader';
import { OHLCVRow } from '@/lib/rs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DistributionStats {
  n: number;
  mean: number;
  std: number;
  skewness: number;
  kurtosis: number;    // excess kurtosis (normal = 0)
  minVal: number;
  maxVal: number;
  minDate: string;
  maxDate: string;
  within1SD: number;   // % of days
  within2SD: number;
  within3SD: number;
  sd1Low: number; sd1High: number;
  sd2Low: number; sd2High: number;
  sd3Low: number; sd3High: number;
}

export interface HistogramBin {
  binCenter: number;
  binLeft: number;
  binRight: number;
  count: number;
  density: number;   // count / (n * binWidth)
}

export interface NormalPoint {
  x: number;
  y: number;
}

export interface OutlierDay {
  date: string;
  change: number;     // daily % change
  close: number;
}

export interface DistributionResponse {
  symbol: string;
  label: string;
  period: string;
  startDate: string;
  endDate: string;
  daysRequested: number;
  daysAvailable: number;
  stats: DistributionStats;
  histogram: HistogramBin[];
  normalCurve: NormalPoint[];
  topGains: OutlierDay[];
  topLosses: OutlierDay[];
}

export interface SymbolListItem {
  value: string;
  label: string;
  isIndex: boolean;
}

// ─── Period config ────────────────────────────────────────────────────────────

const PERIOD_DAYS: Record<string, number> = {
  '1M': 22, '3M': 65, '6M': 130, '1Y': 252, '2Y': 504, '5Y': 1260,
};

// ─── Cache ────────────────────────────────────────────────────────────────────

interface DistCache { data: DistributionResponse; ts: number; }
const distCache = new Map<string, DistCache>();
const DIST_TTL = 5 * 60 * 1000;

// ─── Math helpers ─────────────────────────────────────────────────────────────

function normalPDF(x: number, mean: number, std: number): number {
  return (1 / (std * Math.sqrt(2 * Math.PI))) * Math.exp(-0.5 * ((x - mean) / std) ** 2);
}

function computeHistogram(returns: number[], numBins: number): HistogramBin[] {
  const min = Math.min(...returns);
  const max = Math.max(...returns);
  const range = max - min;
  if (range === 0 || numBins < 2) return [];

  const binWidth = range / numBins;
  const counts = new Array<number>(numBins).fill(0);

  for (const r of returns) {
    const i = Math.min(Math.floor((r - min) / binWidth), numBins - 1);
    counts[i]++;
  }

  const n = returns.length;
  return counts.map((count, i) => ({
    binCenter: min + (i + 0.5) * binWidth,
    binLeft: min + i * binWidth,
    binRight: min + (i + 1) * binWidth,
    count,
    density: count / (n * binWidth),
  }));
}

function computeStats(
  returnRows: { date: string; change: number; close: number }[],
): DistributionStats | null {
  const returns = returnRows.map((r) => r.change);
  const n = returns.length;
  if (n < 5) return null;

  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = returns.reduce((a, b) => a + (b - mean) ** 2, 0) / n;
  const std = Math.sqrt(variance);
  if (std === 0) return null;

  const skewness = returns.reduce((a, b) => a + ((b - mean) / std) ** 3, 0) / n;
  const kurtosis = returns.reduce((a, b) => a + ((b - mean) / std) ** 4, 0) / n - 3;

  const minRow = returnRows.reduce((a, b) => (b.change < a.change ? b : a));
  const maxRow = returnRows.reduce((a, b) => (b.change > a.change ? b : a));

  const sd1Low = mean - std; const sd1High = mean + std;
  const sd2Low = mean - 2 * std; const sd2High = mean + 2 * std;
  const sd3Low = mean - 3 * std; const sd3High = mean + 3 * std;

  const within1SD = (returns.filter((r) => r >= sd1Low && r <= sd1High).length / n) * 100;
  const within2SD = (returns.filter((r) => r >= sd2Low && r <= sd2High).length / n) * 100;
  const within3SD = (returns.filter((r) => r >= sd3Low && r <= sd3High).length / n) * 100;

  return {
    n, mean, std, skewness, kurtosis,
    minVal: minRow.change, maxVal: maxRow.change,
    minDate: minRow.date, maxDate: maxRow.date,
    within1SD, within2SD, within3SD,
    sd1Low, sd1High, sd2Low, sd2High, sd3Low, sd3High,
  };
}

// ─── Core computation ─────────────────────────────────────────────────────────

function buildReturnRows(
  rows: OHLCVRow[],
  periodStart: string,
): { date: string; change: number; close: number }[] {
  const sliced = rows.filter((r) => r.date >= periodStart);
  const result: { date: string; change: number; close: number }[] = [];
  for (let i = 1; i < sliced.length; i++) {
    const prev = sliced[i - 1];
    const curr = sliced[i];
    if (prev.close === 0) continue;
    result.push({
      date: curr.date,
      change: ((curr.close - prev.close) / prev.close) * 100,
      close: curr.close,
    });
  }
  return result;
}

function subtractCalendarDays(dateStr: string, calendarDays: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - calendarDays);
  return d.toISOString().slice(0, 10);
}

async function computeDistribution(
  symbol: string,
  period: string,
): Promise<DistributionResponse> {
  const cacheKey = `${symbol}:${period}`;
  const cached = distCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < DIST_TTL) return cached.data;

  const tradingDays = PERIOD_DAYS[period] ?? 252;
  const calendarDays = Math.ceil(tradingDays * 1.43);

  // Load raw rows
  let rows: OHLCVRow[];
  let label: string;

  if (symbol === 'NIFTY50') {
    rows = readNifty50Index();
    label = 'NIFTY 50 Index';
  } else {
    rows = readStockCSV(symbol);
    label = symbol;
  }

  if (rows.length < 5) {
    throw new Error(`No data available for ${symbol}`);
  }

  // Determine period bounds
  const latestDate = rows[rows.length - 1].date;
  const periodStart = subtractCalendarDays(latestDate, calendarDays);

  // Build daily % return rows
  const returnRows = buildReturnRows(rows, periodStart);
  if (returnRows.length < 5) {
    throw new Error(`Insufficient data for ${symbol} over ${period} period`);
  }

  // Stats
  const stats = computeStats(returnRows);
  if (!stats) throw new Error(`Could not compute stats for ${symbol}`);

  // Histogram: use sqrt-rule bins, clamped to [20, 80]
  const numBins = Math.max(20, Math.min(80, Math.round(Math.sqrt(stats.n) * 3.5)));
  const histogram = computeHistogram(returnRows.map((r) => r.change), numBins);

  // Normal curve: 300 points across a generous x range
  const xMin = Math.min(stats.minVal - 0.5, stats.sd3Low - 0.3);
  const xMax = Math.max(stats.maxVal + 0.5, stats.sd3High + 0.3);
  const step = (xMax - xMin) / 299;
  const normalCurve: NormalPoint[] = Array.from({ length: 300 }, (_, i) => {
    const x = xMin + i * step;
    return { x, y: normalPDF(x, stats.mean, stats.std) };
  });

  // Outliers: top 5 gains and losses
  const sorted = [...returnRows].sort((a, b) => b.change - a.change);
  const topGains: OutlierDay[] = sorted.slice(0, 5).map(({ date, change, close }) => ({ date, change, close }));
  const topLosses: OutlierDay[] = sorted.slice(-5).reverse().map(({ date, change, close }) => ({ date, change, close }));

  const data: DistributionResponse = {
    symbol,
    label,
    period,
    startDate: returnRows[0].date,
    endDate: returnRows[returnRows.length - 1].date,
    daysRequested: tradingDays,
    daysAvailable: returnRows.length,
    stats,
    histogram,
    normalCurve,
    topGains,
    topLosses,
  };

  distCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);

  // Symbol list endpoint
  if (searchParams.get('list') === 'true') {
    const nifty500 = readNifty500List();
    const symbols: SymbolListItem[] = [
      { value: 'NIFTY50', label: 'NIFTY 50 Index', isIndex: true },
      ...nifty500.map((s) => ({ value: s, label: s, isIndex: false })),
    ];
    return NextResponse.json({ success: true, symbols });
  }

  // Distribution endpoint
  const symbol = searchParams.get('symbol') ?? 'NIFTY50';
  const period = searchParams.get('period') ?? '1Y';

  if (!Object.keys(PERIOD_DAYS).includes(period)) {
    return NextResponse.json({ success: false, error: 'Invalid period' }, { status: 400 });
  }

  try {
    const data = await computeDistribution(symbol, period);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/distribution]', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
