import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV, readNifty500List, getTodayQuotesMeta } from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { getSector } from '@/lib/sectors';
import { OHLCVRow } from '@/lib/rs';

export interface MoverResult {
  symbol: string;
  sector: string;
  latestClose: number;
  latestDate: string;
  latestVolume: number;
  avgVolume20D: number;
  volumeRatio: number;       // latestVolume / avgVolume20D
  priceChange1D: number;     // %
  priceChange1W: number;     // %
  priceChange1M: number;     // %
  priceChange3M: number;     // % (~65 bars)
  priceChange5M: number;     // % (~108 bars)
  priceChange1Y: number;     // % (~252 bars)
  high52W: number;
  low52W: number;
  pctFrom52WHigh: number;    // 0 = at high, negative = below
  pctFrom52WLow: number;     // 0 = at low, positive = above
  ma20: number;
  ma50: number;
  ma200: number;
  aboveMa20: boolean;
  aboveMa50: boolean;
  aboveMa200: boolean;
  rsi14: number;             // 14-period Wilder RSI
  isRising5D: boolean;       // closed higher than prev day for last 5 consecutive days
  isFalling5D: boolean;      // closed lower than prev day for last 5 consecutive days
  isNR4: boolean;            // today's range is narrowest of last 4 days
  isNR7: boolean;            // today's range is narrowest of last 7 days
  nr7Range: number;          // today's High - Low
  maxRange4D: number;        // largest range in last 4 days
  maxRange7D: number;        // largest range in last 7 days
}

export interface MoversResponse {
  gainers: MoverResult[];
  losers: MoverResult[];
  high52W: MoverResult[];
  low52W: MoverResult[];
  highVolume: MoverResult[];
  rising5D: MoverResult[];
  falling5D: MoverResult[];
  bigGainers1W: MoverResult[];   // >5% gain in last 1W
  bigLosers1W: MoverResult[];    // >5% drop in last 1W
  aboveAllMAs: MoverResult[];    // above 20d, 50d, and 200d MA
  aboveMa200: MoverResult[];
  nr4: MoverResult[];            // NR4: today's range is the narrowest of last 4 days
  nr7: MoverResult[];            // NR7: today's range is the narrowest of last 7 days
  allMovers: MoverResult[];      // full list for client-side custom filtering
  dataDate: string;              // latest date present in the underlying data
  liveQuotesMeta: { date: string; updatedAt: string; count: number } | null;
}

// ─── Cache ────────────────────────────────────────────────────────────────────
interface MoversCache { data: MoversResponse; ts: number; }
const moversCache = new Map<string, MoversCache>();
const MOVERS_TTL = 5 * 60 * 1000;

function simpleMA(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Wilder's smoothed RSI (14-period)
function wilderRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? Math.abs(diff) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function pctChg(rows: OHLCVRow[], n: number): number {
  if (rows.length < 2) return 0;
  const slice = rows.slice(-Math.min(n, rows.length));
  const first = slice[0].close;
  const last = slice[slice.length - 1].close;
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}

/**
 * 1-day % change, robust to the Dhan API quirk where today's OHLCV candle
 * carries the PREVIOUS session's settlement price in the `close` field until
 * EOD processing runs.  When `curr.close === prev.close` we fall back to
 * `curr.open` (the actual opening price) as the current-price proxy, then to
 * the high/low midpoint, so the value is always meaningful intraday.
 */
function pctChg1D(rows: OHLCVRow[]): number {
  if (rows.length < 2) return 0;
  const curr = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  if (prev.close === 0) return 0;

  let currPrice = curr.close;
  if (currPrice === prev.close) {
    // close hasn't been updated yet — use open as intraday proxy
    if (curr.open > 0) {
      currPrice = curr.open;
    } else if (curr.high > 0 && curr.low > 0) {
      currPrice = (curr.high + curr.low) / 2;
    } else {
      return 0;
    }
  }
  return ((currPrice - prev.close) / prev.close) * 100;
}

function computeMover(symbol: string, rows: OHLCVRow[]): MoverResult | null {
  if (rows.length < 22) return null;

  const latest = rows[rows.length - 1];
  const closes = rows.map((r) => r.close);

  // Moving averages
  const ma20 = simpleMA(closes, 20);
  const ma50 = simpleMA(closes, 50);
  const ma200 = simpleMA(closes, 200);

  // 52-week high & low
  const last252 = rows.slice(-252);
  const high52W = Math.max(...last252.map((r) => r.high));
  const low52W = Math.min(...last252.map((r) => r.low));
  const pctFrom52WHigh = high52W > 0 ? ((latest.close - high52W) / high52W) * 100 : 0;
  const pctFrom52WLow = low52W > 0 ? ((latest.close - low52W) / low52W) * 100 : 0;

  // Volume
  const latestVolume = latest.volume;
  const vol20 = rows.slice(-20).map((r) => r.volume);
  const avgVolume20D = vol20.reduce((a, b) => a + b, 0) / vol20.length;
  const volumeRatio = avgVolume20D > 0 ? latestVolume / avgVolume20D : 0;

  // Consecutive rising 5 days: each day's close > previous day's close
  let isRising5D = false;
  if (rows.length >= 6) {
    isRising5D = true;
    for (let i = rows.length - 5; i < rows.length; i++) {
      if (rows[i].close <= rows[i - 1].close) { isRising5D = false; break; }
    }
  }

  // Consecutive falling 5 days: each day's close < previous day's close
  let isFalling5D = false;
  if (rows.length >= 6) {
    isFalling5D = true;
    for (let i = rows.length - 5; i < rows.length; i++) {
      if (rows[i].close >= rows[i - 1].close) { isFalling5D = false; break; }
    }
  }

  // RSI-14 (Wilder) — use last 60 closes for accuracy
  const rsi14 = wilderRSI(closes.slice(-60));

  // NR4 / NR7: today's High-Low range is the smallest of the last N days
  const last7 = rows.slice(-7);
  const ranges7 = last7.map((r) => r.high - r.low);
  const nr7Range = ranges7[ranges7.length - 1];
  const maxRange7D = Math.max(...ranges7);
  const isNR7 = ranges7.length === 7 && ranges7.slice(0, 6).every((r) => nr7Range < r);
  const ranges4 = ranges7.slice(-4);
  const maxRange4D = Math.max(...ranges4);
  const isNR4 = ranges4.length === 4 && ranges4.slice(0, 3).every((r) => nr7Range < r);

  return {
    symbol,
    sector: getSector(symbol),
    latestClose: latest.close,
    latestDate: latest.date,
    latestVolume,
    avgVolume20D,
    volumeRatio,
    priceChange1D: pctChg1D(rows),
    priceChange1W: pctChg(rows, 6),
    priceChange1M: pctChg(rows, 22),
    priceChange3M: pctChg(rows, 65),
    priceChange5M: pctChg(rows, 108),
    priceChange1Y: pctChg(rows, 252),
    high52W,
    low52W,
    pctFrom52WHigh,
    pctFrom52WLow,
    ma20,
    ma50,
    ma200,
    aboveMa20: latest.close > ma20,
    aboveMa50: latest.close > ma50 && ma50 > 0,
    aboveMa200: latest.close > ma200 && ma200 > 0,
    rsi14,
    isRising5D,
    isFalling5D,
    isNR4,
    isNR7,
    nr7Range,
    maxRange4D,
    maxRange7D,
  };
}

async function getMovers(indexType: 'nifty50' | 'nifty500'): Promise<MoversResponse> {
  const cached = moversCache.get(indexType);
  if (cached && Date.now() - cached.ts < MOVERS_TTL) return cached.data;

  const symbols = indexType === 'nifty50' ? NIFTY50_SYMBOLS : readNifty500List();

  const movers: MoverResult[] = [];
  await Promise.all(
    symbols.map(async (symbol) => {
      const rows = readStockCSV(symbol);
      const m = computeMover(symbol, rows);
      if (m) movers.push(m);
    })
  );

  const gainers = [...movers]
    .sort((a, b) => b.priceChange1D - a.priceChange1D)
    .slice(0, 10);

  const losers = [...movers]
    .sort((a, b) => a.priceChange1D - b.priceChange1D)
    .slice(0, 10);

  // Near 52W high: within 2% of 52W high (pctFrom52WHigh >= -2)
  const high52W = [...movers]
    .filter((m) => m.pctFrom52WHigh >= -2)
    .sort((a, b) => b.pctFrom52WHigh - a.pctFrom52WHigh)
    .slice(0, 20);

  // Near 52W low: within 5% of 52W low (pctFrom52WLow <= 5)
  const low52W = [...movers]
    .filter((m) => m.pctFrom52WLow <= 5)
    .sort((a, b) => a.pctFrom52WLow - b.pctFrom52WLow)
    .slice(0, 20);

  // Highest volume by volumeRatio vs 20D avg
  const highVolume = [...movers]
    .filter((m) => m.avgVolume20D > 0)
    .sort((a, b) => b.volumeRatio - a.volumeRatio)
    .slice(0, 10);

  const rising5D = [...movers]
    .filter((m) => m.isRising5D)
    .sort((a, b) => b.priceChange1W - a.priceChange1W);

  const falling5D = [...movers]
    .filter((m) => m.isFalling5D)
    .sort((a, b) => a.priceChange1W - b.priceChange1W);

  // Stocks that moved >5% in either direction over the last week
  const bigGainers1W = [...movers]
    .filter((m) => m.priceChange1W > 5)
    .sort((a, b) => b.priceChange1W - a.priceChange1W);

  const bigLosers1W = [...movers]
    .filter((m) => m.priceChange1W < -5)
    .sort((a, b) => a.priceChange1W - b.priceChange1W);

  // Above all MAs + RSI > 50 filter
  const aboveAllMAs = [...movers]
    .filter((m) => m.aboveMa20 && m.aboveMa50 && m.aboveMa200 && m.rsi14 > 50)
    .sort((a, b) => b.priceChange1M - a.priceChange1M);

  const aboveMa200 = [...movers]
    .filter((m) => m.aboveMa200)
    .sort((a, b) => b.priceChange1M - a.priceChange1M);

  // NR4 / NR7: sort by Range % ascending (today's range / max N-day range) — tightest compression first
  const nr4 = [...movers].filter((m) => m.isNR4).sort((a, b) => (a.nr7Range / a.maxRange4D) - (b.nr7Range / b.maxRange4D));
  const nr7 = [...movers].filter((m) => m.isNR7).sort((a, b) => (a.nr7Range / a.maxRange7D) - (b.nr7Range / b.maxRange7D));

  // Full list sorted alphabetically — used by client-side custom filter
  const allMovers = [...movers].sort((a, b) => a.symbol.localeCompare(b.symbol));

  // Determine the latest data date from the first mover result
  const dataDate = movers.length > 0
    ? movers.reduce((latest, m) => m.latestDate > latest ? m.latestDate : latest, movers[0].latestDate)
    : '';

  const liveQuotesMeta = getTodayQuotesMeta();

  const data: MoversResponse = {
    gainers, losers, high52W, low52W, highVolume,
    rising5D, falling5D, bigGainers1W, bigLosers1W,
    aboveAllMAs, aboveMa200, nr4, nr7, allMovers,
    dataDate,
    liveQuotesMeta,
  };
  moversCache.set(indexType, { data, ts: Date.now() });
  return data;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const indexType = (searchParams.get('index') ?? 'nifty50') as 'nifty50' | 'nifty500';

  try {
    const data = await getMovers(indexType);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/movers] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
