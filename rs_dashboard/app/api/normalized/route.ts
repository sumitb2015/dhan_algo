import { NextRequest, NextResponse } from 'next/server';
import { readStockCSVAsync, readNifty500List, readIndexCSV, KNOWN_INDICES } from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { getSector } from '@/lib/sectors';
import { OHLCVRow } from '@/lib/rs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface StockSeries {
  symbol: string;
  sector: string;
  finalReturn: number;     // % return from period start to end
  values: (number | null)[];  // parallel to shared dates, % from base (0 at first point)
  hasFullHistory: boolean; // false if stock has less history than requested period
}

export interface NormalizedResponse {
  dates: string[];           // shared canonical date labels (sampled)
  stocks: StockSeries[];
  periodLabel: string;
  requestedStart: string;   // what was asked for
  actualStart: string;      // earliest date available across all stocks
  actualEnd: string;
  totalScanned: number;
}

// ─── Period config ────────────────────────────────────────────────────────────

// Approximate trading days per period
const PERIOD_DAYS: Record<string, number> = {
  '1M': 22, '3M': 65, '6M': 130, '1Y': 252,
  '2Y': 504, '3Y': 756, '4Y': 1008, '5Y': 1260,
};

// Target number of chart data points (after sampling)
const TARGET_POINTS = 80;

// ─── Cache ────────────────────────────────────────────────────────────────────

interface NormCache { data: NormalizedResponse; ts: number; }
const normCache = new Map<string, NormCache>();
const NORM_TTL = 5 * 60 * 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Add calendar days to a YYYY-MM-DD string */
function subtractCalendarDays(dateStr: string, calendarDays: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - calendarDays);
  return d.toISOString().slice(0, 10);
}

/** Convert trading-day count to approximate calendar days (add ~40% for weekends/holidays) */
function tradingToCalendar(tradingDays: number): number {
  return Math.ceil(tradingDays * 1.43);
}

/**
 * Sample an array of rows to at most targetPoints, always keeping first + last.
 * Uses a fixed step so sampled dates are evenly spread.
 */
function sampleRows(rows: OHLCVRow[], targetPoints: number): OHLCVRow[] {
  if (rows.length <= targetPoints) return rows;
  const step = Math.floor(rows.length / (targetPoints - 1));
  const out: OHLCVRow[] = [];
  for (let i = 0; i < rows.length - 1; i += step) out.push(rows[i]);
  out.push(rows[rows.length - 1]); // always include last
  return out;
}

/** Build a date → close map for fast lookup */
function buildDateMap(rows: OHLCVRow[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of rows) m.set(r.date, r.close);
  return m;
}

/**
 * For each canonical date, find the stock's value.
 * Uses exact match, then falls back to the most recent prior date.
 */
function alignToCanonical(
  dateMap: Map<string, number>,
  allStockRows: OHLCVRow[],
  canonicalDates: string[],
  base: number,
): (number | null)[] {
  // Build sorted date→close for nearest-prior lookup
  const sorted = allStockRows; // already sorted ascending

  let ptr = 0;
  return canonicalDates.map((cd) => {
    // Advance pointer to the last row whose date <= cd
    while (ptr < sorted.length - 1 && sorted[ptr + 1].date <= cd) ptr++;
    const row = sorted[ptr];
    if (!row || row.date > cd) return null;
    return ((row.close / base) - 1) * 100;
  });
}

// ─── Core computation ─────────────────────────────────────────────────────────

async function computeNormalized(
  indexType: 'nifty50' | 'nifty500' | 'indices',
  period: string,
): Promise<NormalizedResponse> {
  const cacheKey = `${indexType}:${period}`;
  const cached = normCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < NORM_TTL) return cached.data;

  const tradingDays = PERIOD_DAYS[period] ?? 252;
  const calendarDays = tradingToCalendar(tradingDays);

  // Load rows — indices use readIndexCSV; stocks use readStockCSV
  let allData: { symbol: string; label: string; rows: OHLCVRow[] }[];

  if (indexType === 'indices') {
    allData = KNOWN_INDICES.map((meta) => ({
      symbol: meta.key,
      label: meta.label,
      rows: readIndexCSV(meta),
    }));
  } else {
    const symbols = indexType === 'nifty50' ? NIFTY50_SYMBOLS : readNifty500List();
    allData = await Promise.all(
      symbols.map(async (symbol) => ({
        symbol,
        label: getSector(symbol),
        rows: await readStockCSVAsync(symbol),
      }))
    );
  }

  // Find the latest end date (most recent trading day across all stocks)
  let globalEnd = '';
  for (const { rows } of allData) {
    if (rows.length > 0) {
      const last = rows[rows.length - 1].date;
      if (last > globalEnd) globalEnd = last;
    }
  }
  const totalScanned = allData.length;
  if (!globalEnd) return { dates: [], stocks: [], periodLabel: period, requestedStart: '', actualStart: '', actualEnd: '', totalScanned };

  const requestedStart = subtractCalendarDays(globalEnd, calendarDays);

  // Determine canonical dates from the series with the most data in the period
  let canonicalSource: OHLCVRow[] = [];
  for (const { rows } of allData) {
    const sliced = rows.filter((r) => r.date >= requestedStart);
    if (sliced.length > canonicalSource.length) canonicalSource = sliced;
  }
  const sampledCanonical = sampleRows(canonicalSource, TARGET_POINTS);
  const canonicalDates = sampledCanonical.map((r) => r.date);

  if (canonicalDates.length === 0) {
    return { dates: [], stocks: [], periodLabel: period, requestedStart, actualStart: '', actualEnd: globalEnd, totalScanned };
  }

  const periodStart = canonicalDates[0];
  const periodEnd = canonicalDates[canonicalDates.length - 1];

  // Compute each stock's normalized series
  const stocks: StockSeries[] = [];

  for (const { symbol, label, rows } of allData) {
    if (rows.length < 5) continue;

    const sliced = rows.filter((r) => r.date >= requestedStart);
    if (sliced.length < 5) {
      // Not enough data for this period — skip
      continue;
    }

    const base = sliced[0].close;
    if (base === 0) continue;

    const hasFullHistory = sliced[0].date <= requestedStart || tradingDays <= 504;
    const finalClose = sliced[sliced.length - 1].close;
    const finalReturn = ((finalClose / base) - 1) * 100;

    const values = alignToCanonical(buildDateMap(sliced), sliced, canonicalDates, base);

    stocks.push({
      symbol,
      sector: label,
      finalReturn,
      values,
      hasFullHistory,
    });
  }

  // Sort by finalReturn descending (best performers first)
  stocks.sort((a, b) => b.finalReturn - a.finalReturn);

  const data: NormalizedResponse = {
    dates: canonicalDates,
    stocks,
    periodLabel: period,
    requestedStart,
    actualStart: periodStart,
    actualEnd: periodEnd,
    totalScanned,
  };

  normCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const indexType = (searchParams.get('index') ?? 'nifty50') as 'nifty50' | 'nifty500' | 'indices';
  const period = searchParams.get('period') ?? '1Y';

  try {
    const data = await computeNormalized(indexType, period);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/normalized] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
