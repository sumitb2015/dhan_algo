import { NextRequest, NextResponse } from 'next/server';
import {
  readStockCSV,
  readNifty500List,
  readNifty50Index,
  readNifty500Index,
} from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { smaArray, emaArray, rsiArray, macdSeries, adxArray, smoothArray } from '@/lib/indicators';
import type { OHLCVRow } from '@/lib/rs';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DiffusionResponse {
  dates: string[];
  indexSeries: number[];

  // SMA % (0-100)
  pctAboveSma20: number[];
  pctAboveSma50: number[];
  pctAboveSma100: number[];
  pctAboveSma200: number[];

  // Momentum indicators % (0-100)
  pctMacdBullish: number[];
  pctRsiAbove50: number[];
  pctAdxAbove25: number[];

  // Periodical highs — 9-day smoothed % of universe (always >= 0)
  new1MHighPct9d: number[];
  new1QHighPct9d: number[];
  new1YHighPct9d: number[];

  // Periodical lows — 9-day smoothed % of universe (always >= 0)
  new1MLowPct9d: number[];
  new1QLowPct9d: number[];
  new1YLowPct9d: number[];

  dataDate: string;
  universe: 'nifty50' | 'nifty500';
  totalScanned: number;
}

// ─── Cache ────────────────────────────────────────────────────────────────────

interface CacheEntry { data: DiffusionResponse; ts: number; }
const cache = new Map<string, CacheEntry>();
const TTL = 5 * 60 * 1000;

// ─── Per-date accumulator ─────────────────────────────────────────────────────

interface DayAcc {
  n: number;                          // stocks with any data
  sma20v: number; aboveSma20: number; // valid, above
  sma50v: number; aboveSma50: number;
  sma100v: number; aboveSma100: number;
  sma200v: number; aboveSma200: number;
  macdBullish: number;                // uses total n as denom (no hard null)
  rsiV: number; rsiAbove50: number;
  adxV: number; adxAbove25: number;
  new1MH: number; new1ML: number;    // raw counts (need 20 prior bars)
  new1QH: number; new1QL: number;    // 63 prior bars
  new1YH: number; new1YL: number;    // 252 prior bars
  highValidN: number;                 // stocks with enough bars for any high window
}

function makeAcc(): DayAcc {
  return {
    n: 0,
    sma20v: 0, aboveSma20: 0,
    sma50v: 0, aboveSma50: 0,
    sma100v: 0, aboveSma100: 0,
    sma200v: 0, aboveSma200: 0,
    macdBullish: 0,
    rsiV: 0, rsiAbove50: 0,
    adxV: 0, adxAbove25: 0,
    new1MH: 0, new1ML: 0,
    new1QH: 0, new1QL: 0,
    new1YH: 0, new1YL: 0,
    highValidN: 0,
  };
}

// ─── Core computation ─────────────────────────────────────────────────────────

async function computeDiffusion(universe: 'nifty50' | 'nifty500'): Promise<DiffusionResponse> {
  const symbols = universe === 'nifty50' ? [...NIFTY50_SYMBOLS] : readNifty500List();

  // Load index and all stock CSVs in parallel
  const [indexRows, ...stockRows] = await Promise.all([
    universe === 'nifty50'
      ? Promise.resolve(readNifty50Index())
      : readNifty500Index(symbols),
    ...symbols.map((s) => Promise.resolve(readStockCSV(s))),
  ]);

  // Build index close lookup by date
  const idxMap = new Map<string, number>();
  for (const row of indexRows as OHLCVRow[]) idxMap.set(row.date, row.close);

  // Accumulate per-date signals across all stocks
  const acc = new Map<string, DayAcc>();

  for (const rows of stockRows as OHLCVRow[][]) {
    if (rows.length < 20) continue;

    const closes = rows.map((r) => r.close);
    const highs = rows.map((r) => r.high);
    const lows = rows.map((r) => r.low);

    // Compute indicator series
    const sma20s = smaArray(closes, 20);
    const sma50s = smaArray(closes, 50);
    const sma100s = smaArray(closes, 100);
    const sma200s = smaArray(closes, 200);
    const rsis = rsiArray(closes, 14);
    const { macdLine, signalLine } = macdSeries(closes, 12, 26, 9);
    const adxs = adxArray(highs, lows, closes, 14);

    const n = rows.length;
    for (let i = 0; i < n; i++) {
      const date = rows[i].date;
      if (!acc.has(date)) acc.set(date, makeAcc());
      const day = acc.get(date)!;
      day.n++;

      const c = closes[i];
      const h = highs[i];
      const l = lows[i];

      // SMA signals (only when SMA is valid)
      if (sma20s[i] !== null) { day.sma20v++; if (c > sma20s[i]!) day.aboveSma20++; }
      if (sma50s[i] !== null) { day.sma50v++; if (c > sma50s[i]!) day.aboveSma50++; }
      if (sma100s[i] !== null) { day.sma100v++; if (c > sma100s[i]!) day.aboveSma100++; }
      if (sma200s[i] !== null) { day.sma200v++; if (c > sma200s[i]!) day.aboveSma200++; }

      // MACD — uses EMA cold-start, so no hard null; use n as denom
      if (macdLine[i] > signalLine[i]) day.macdBullish++;

      // RSI
      if (rsis[i] !== null) { day.rsiV++; if (rsis[i]! >= 50) day.rsiAbove50++; }

      // ADX
      if (adxs[i] !== null) { day.adxV++; if (adxs[i]! > 25) day.adxAbove25++; }

      // Periodical highs — need prior bars in this stock's own array
      if (i >= 21) {
        // 1-month: max of prior 20 bars (not including today)
        let maxH1M = -Infinity, minL1M = Infinity;
        for (let j = i - 20; j < i; j++) {
          if (highs[j] > maxH1M) maxH1M = highs[j];
          if (lows[j] < minL1M) minL1M = lows[j];
        }
        day.new1MH += h >= maxH1M ? 1 : 0;
        day.new1ML += l <= minL1M ? 1 : 0;
        day.highValidN++;
      }
      if (i >= 64) {
        let maxH1Q = -Infinity, minL1Q = Infinity;
        for (let j = i - 63; j < i; j++) {
          if (highs[j] > maxH1Q) maxH1Q = highs[j];
          if (lows[j] < minL1Q) minL1Q = lows[j];
        }
        day.new1QH += h >= maxH1Q ? 1 : 0;
        day.new1QL += l <= minL1Q ? 1 : 0;
      }
      if (i >= 253) {
        let maxH1Y = -Infinity, minL1Y = Infinity;
        for (let j = i - 252; j < i; j++) {
          if (highs[j] > maxH1Y) maxH1Y = highs[j];
          if (lows[j] < minL1Y) minL1Y = lows[j];
        }
        day.new1YH += h >= maxH1Y ? 1 : 0;
        day.new1YL += l <= minL1Y ? 1 : 0;
      }
    }
  }

  // ─── Build canonical date series ─────────────────────────────────────────────
  const dates = Array.from(acc.keys()).sort();
  const len = dates.length;

  // Raw series for smoothing
  const raw1MHigh = new Array<number>(len).fill(0);
  const raw1MLow = new Array<number>(len).fill(0);
  const raw1QHigh = new Array<number>(len).fill(0);
  const raw1QLow = new Array<number>(len).fill(0);
  const raw1YHigh = new Array<number>(len).fill(0);
  const raw1YLow = new Array<number>(len).fill(0);

  const pctAboveSma20 = new Array<number>(len).fill(0);
  const pctAboveSma50 = new Array<number>(len).fill(0);
  const pctAboveSma100 = new Array<number>(len).fill(0);
  const pctAboveSma200 = new Array<number>(len).fill(0);
  const pctMacdBullish = new Array<number>(len).fill(0);
  const pctRsiAbove50 = new Array<number>(len).fill(0);
  const pctAdxAbove25 = new Array<number>(len).fill(0);
  const indexSeries = new Array<number>(len).fill(0);

  for (let i = 0; i < len; i++) {
    const d = dates[i];
    const day = acc.get(d)!;

    pctAboveSma20[i] = day.sma20v > 0 ? (day.aboveSma20 / day.sma20v) * 100 : 0;
    pctAboveSma50[i] = day.sma50v > 0 ? (day.aboveSma50 / day.sma50v) * 100 : 0;
    pctAboveSma100[i] = day.sma100v > 0 ? (day.aboveSma100 / day.sma100v) * 100 : 0;
    pctAboveSma200[i] = day.sma200v > 0 ? (day.aboveSma200 / day.sma200v) * 100 : 0;
    pctMacdBullish[i] = day.n > 0 ? (day.macdBullish / day.n) * 100 : 0;
    pctRsiAbove50[i] = day.rsiV > 0 ? (day.rsiAbove50 / day.rsiV) * 100 : 0;
    pctAdxAbove25[i] = day.adxV > 0 ? (day.adxAbove25 / day.adxV) * 100 : 0;

    // Use the same denominator (n) for high series so percentages are comparable
    const base = day.n > 0 ? day.n : 1;
    raw1MHigh[i] = (day.new1MH / base) * 100;
    raw1MLow[i] = (day.new1ML / base) * 100;
    raw1QHigh[i] = (day.new1QH / base) * 100;
    raw1QLow[i] = (day.new1QL / base) * 100;
    raw1YHigh[i] = (day.new1YH / base) * 100;
    raw1YLow[i] = (day.new1YL / base) * 100;

    indexSeries[i] = idxMap.get(d) ?? (i > 0 ? indexSeries[i - 1] : 0);
  }

  // 9-day smoothing of high series
  const sm9 = (arr: number[]) => smoothArray(arr, 9).map((v) => v ?? 0);
  const s1MH = sm9(raw1MHigh);
  const s1ML = sm9(raw1MLow);
  const s1QH = sm9(raw1QHigh);
  const s1QL = sm9(raw1QLow);
  const s1YH = sm9(raw1YHigh);
  const s1YL = sm9(raw1YLow);

  const new1MHighPct9d = s1MH;
  const new1QHighPct9d = s1QH;
  const new1YHighPct9d = s1YH;
  const new1MLowPct9d = s1ML;
  const new1QLowPct9d = s1QL;
  const new1YLowPct9d = s1YL;

  const dataDate = dates[dates.length - 1] ?? '';

  return {
    dates,
    indexSeries,
    pctAboveSma20,
    pctAboveSma50,
    pctAboveSma100,
    pctAboveSma200,
    pctMacdBullish,
    pctRsiAbove50,
    pctAdxAbove25,
    new1MHighPct9d,
    new1QHighPct9d,
    new1YHighPct9d,
    new1MLowPct9d,
    new1QLowPct9d,
    new1YLowPct9d,
    dataDate,
    universe,
    totalScanned: symbols.length,
  };
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl;
  const universe = (searchParams.get('index') === 'nifty500' ? 'nifty500' : 'nifty50') as
    'nifty50' | 'nifty500';

  const cached = cache.get(universe);
  if (cached && Date.now() - cached.ts < TTL) {
    return NextResponse.json(cached.data);
  }

  try {
    const data = await computeDiffusion(universe);
    cache.set(universe, { data, ts: Date.now() });
    return NextResponse.json(data);
  } catch (err) {
    console.error('[diffusion]', err);
    return NextResponse.json({ error: 'Failed to compute diffusion data' }, { status: 500 });
  }
}
