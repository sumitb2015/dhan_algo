import { NextRequest, NextResponse } from 'next/server';
import { readStockCSV, readNifty500List, readNifty50Index, readNifty500Index, listAvailableSymbols } from '@/lib/dataLoader';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { getSector } from '@/lib/sectors';
import { OHLCVRow, alignByDate } from '@/lib/rs';
import type { ScannerParams, ScannerResult, ScannerResponse } from '@/lib/scannerTypes';
import { DEFAULT_SCANNER_PARAMS } from '@/lib/scannerTypes';

// Re-export so existing imports from this route file continue to work
export type { ScannerParams, ScannerResult, ScannerResponse };
export { DEFAULT_SCANNER_PARAMS };

// ─── Cache ────────────────────────────────────────────────────────────────────
interface ScannerCache { data: ScannerResponse; ts: number; }
const scannerCache = new Map<string, ScannerCache>();
const SCANNER_TTL = 5 * 60 * 1000;

// ─── Math helpers ─────────────────────────────────────────────────────────────

function emaArray(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const result = new Array<number>(values.length);
  result[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    result[i] = values[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function simpleMA(values: number[], period: number): number {
  if (values.length < period) return 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

// Wilder's smoothed RSI
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
    avgGain = (avgGain * (period - 1) + Math.max(diff, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-diff, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function computeMACD(
  closes: number[],
  fast = 12,
  slow = 26,
  signal = 9,
): { line: number; signal: number; histogram: number; bullish: boolean; crossover: boolean } {
  const zero = { line: 0, signal: 0, histogram: 0, bullish: false, crossover: false };
  if (closes.length < slow + signal + 2) return zero;

  const ema12arr = emaArray(closes, fast);
  const ema26arr = emaArray(closes, slow);
  const macdArr = ema12arr.map((v, i) => v - ema26arr[i]);
  const signalArr = emaArray(macdArr, signal);

  const n = macdArr.length;
  const line = macdArr[n - 1];
  const sig = signalArr[n - 1];
  const prevLine = n >= 2 ? macdArr[n - 2] : line;
  const prevSignal = n >= 2 ? signalArr[n - 2] : sig;

  const histogram = line - sig;
  const bullish = line > sig;
  const crossover = line > sig && prevLine <= prevSignal;

  return { line, signal: sig, histogram, bullish, crossover };
}

function computeADX(rows: OHLCVRow[], period = 14): { adx: number; plusDI: number; minusDI: number } {
  const zero = { adx: 0, plusDI: 25, minusDI: 25 };
  if (rows.length < period * 2 + 2) return zero;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < rows.length; i++) {
    const { high: h, low: l } = rows[i];
    const { high: ph, low: pl, close: pc } = rows[i - 1];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const upMove = h - ph;
    const downMove = pl - l;
    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }

  // Wilder's initial sums
  let smoothTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxArr: number[] = [];
  let lastPlusDI = 0, lastMinusDI = 0;

  for (let i = period; i < trs.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trs[i];
    smoothPlus = smoothPlus - smoothPlus / period + plusDMs[i];
    smoothMinus = smoothMinus - smoothMinus / period + minusDMs[i];
    lastPlusDI = smoothTR > 0 ? (smoothPlus / smoothTR) * 100 : 0;
    lastMinusDI = smoothTR > 0 ? (smoothMinus / smoothTR) * 100 : 0;
    const diSum = lastPlusDI + lastMinusDI;
    dxArr.push(diSum > 0 ? (Math.abs(lastPlusDI - lastMinusDI) / diSum) * 100 : 0);
  }

  if (dxArr.length < period) return { adx: 0, plusDI: lastPlusDI, minusDI: lastMinusDI };

  let adxVal = dxArr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxArr.length; i++) {
    adxVal = (adxVal * (period - 1) + dxArr[i]) / period;
  }

  return { adx: adxVal, plusDI: lastPlusDI, minusDI: lastMinusDI };
}

// Supertrend
function computeSupertrend(rows: OHLCVRow[], period = 7, multiplier = 3): boolean {
  if (rows.length < period + 1) return false;

  // Wilder ATR
  const trs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    trs.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close),
    ));
  }
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const atrArr = [atr];
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
    atrArr.push(atr);
  }

  // Supertrend bands
  let upperBand = 0, lowerBand = 0, trend = 1;
  for (let i = 0; i < atrArr.length; i++) {
    const ri = i + period;
    const hl2 = (rows[ri].high + rows[ri].low) / 2;
    const basicUpper = hl2 + multiplier * atrArr[i];
    const basicLower = hl2 - multiplier * atrArr[i];

    if (i === 0) {
      upperBand = basicUpper;
      lowerBand = basicLower;
    } else {
      const prevClose = rows[ri - 1].close;
      upperBand = basicUpper < upperBand || prevClose > upperBand ? basicUpper : upperBand;
      lowerBand = basicLower > lowerBand || prevClose < lowerBand ? basicLower : lowerBand;
    }

    if (rows[ri].close > upperBand) trend = 1;
    else if (rows[ri].close < lowerBand) trend = -1;
  }

  return trend === 1;
}

function computeBollingerBands(closes: number[], period = 20): { upper: number; middle: number; lower: number; bbExpanding: boolean } {
  const zero = { upper: 0, middle: 0, lower: 0, bbExpanding: false };
  if (closes.length < period + 1) return zero;

  function bandwidth(slice: number[]): number {
    const mean = slice.reduce((a, b) => a + b, 0) / slice.length;
    const stdDev = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / slice.length);
    return mean > 0 ? (4 * stdDev) / mean : 0;
  }

  const curr = closes.slice(-period);
  const prev = closes.slice(-period - 1, -1);

  const mean = curr.reduce((a, b) => a + b, 0) / curr.length;
  const stdDev = Math.sqrt(curr.reduce((a, b) => a + (b - mean) ** 2, 0) / curr.length);

  return {
    upper: mean + 2 * stdDev,
    middle: mean,
    lower: mean - 2 * stdDev,
    bbExpanding: bandwidth(curr) > bandwidth(prev),
  };
}

function computeATR(rows: OHLCVRow[], period = 14): { atr: number; expanding: boolean } {
  if (rows.length < period + 20) return { atr: 0, expanding: false };

  const trs: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    trs.push(Math.max(
      rows[i].high - rows[i].low,
      Math.abs(rows[i].high - rows[i - 1].close),
      Math.abs(rows[i].low - rows[i - 1].close),
    ));
  }

  let atrVal = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  const atrArr = [atrVal];
  for (let i = period; i < trs.length; i++) {
    atrVal = (atrVal * (period - 1) + trs[i]) / period;
    atrArr.push(atrVal);
  }

  const current = atrArr[atrArr.length - 1];
  const avg20 = atrArr.slice(-20).reduce((a, b) => a + b, 0) / Math.min(20, atrArr.length);
  return { atr: current, expanding: current > avg20 };
}

function computeRS(
  stockRows: OHLCVRow[],
  indexRows: OHLCVRow[],
  lookback = 252,
): { rsRatio: number; rsRising20: boolean; rsAboveMA: boolean } {
  const aligned = alignByDate(stockRows, indexRows);
  if (aligned.length < lookback + 21) return { rsRatio: 0, rsRising20: false, rsAboveMA: false };

  const rsValues: number[] = [];
  const n = aligned.length;
  const start = Math.max(lookback, n - 21);
  for (let i = start; i < n; i++) {
    const curr = aligned[i];
    const base = aligned[i - lookback];
    if (base.stockClose === 0 || base.indexClose === 0) continue;
    rsValues.push(((curr.stockClose / base.stockClose) / (curr.indexClose / base.indexClose)) - 1);
  }

  if (rsValues.length === 0) return { rsRatio: 0, rsRising20: false, rsAboveMA: false };

  const rsRatio = rsValues[rsValues.length - 1];
  const rsRising20 = rsValues.length >= 2 && rsRatio > rsValues[0];
  const rsSMA = rsValues.reduce((a, b) => a + b, 0) / rsValues.length;
  const rsAboveMA = rsRatio > rsSMA;

  return { rsRatio, rsRising20, rsAboveMA };
}

function pctChg(rows: OHLCVRow[], n: number): number {
  if (rows.length < 2) return 0;
  const slice = rows.slice(-Math.min(n, rows.length));
  const first = slice[0].close;
  const last = slice[slice.length - 1].close;
  return first === 0 ? 0 : ((last - first) / first) * 100;
}

function pctChg1D(rows: OHLCVRow[]): number {
  if (rows.length < 2) return 0;
  const curr = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  if (prev.close === 0) return 0;
  let currPrice = curr.close;
  if (currPrice === prev.close && curr.open > 0) currPrice = curr.open;
  return ((currPrice - prev.close) / prev.close) * 100;
}

const MAX_SCORE = 15;

function computeScore(r: Omit<ScannerResult, 'score' | 'scorePercent'>): { score: number; scorePercent: number } {
  let score = 0;
  if (r.aboveEma20) score += 1;
  if (r.aboveEma50) score += 1;
  if (r.aboveEma200) score += 2;
  if (r.supertrendBullish) score += 2;
  if (r.rsi14 > 60) score += 1;
  if (r.macdBullish) score += 2;
  if (r.adx14 > 25) score += 1;
  if (r.volumeRatio > 1.5) score += 1;
  if (r.rsRising20) score += 2;
  if (r.rsAboveMA) score += 2;
  return { score, scorePercent: Math.round((score / MAX_SCORE) * 1000) / 10 };
}

// ─── Per-stock computation ────────────────────────────────────────────────────

function computeScanner(
  symbol: string,
  rows: OHLCVRow[],
  indexRows: OHLCVRow[],
  params: ScannerParams,
): ScannerResult | null {
  if (rows.length < 60) return null;

  const latest = rows[rows.length - 1];
  const closes = rows.map((r) => r.close);

  // EMA
  const ema1arr = emaArray(closes, params.emaPeriod1);
  const ema2arr = emaArray(closes, params.emaPeriod2);
  const ema3arr = emaArray(closes, params.emaPeriod3);
  const ema20 = ema1arr[ema1arr.length - 1];
  const ema50 = ema2arr[ema2arr.length - 1];
  const ema200 = rows.length >= params.emaPeriod3 ? ema3arr[ema3arr.length - 1] : 0;

  // RSI
  const rsiLookback = Math.max(60, params.rsiPeriod * 3);
  const rsi14 = wilderRSI(closes.slice(-rsiLookback), params.rsiPeriod);

  // MACD
  const macd = computeMACD(closes, params.macdFast, params.macdSlow, params.macdSignal);

  // ADX
  const adx = computeADX(rows, params.adxPeriod);

  // Supertrend
  const supertrendBullish = computeSupertrend(rows, params.stPeriod, params.stMultiplier);

  // Bollinger Bands
  const bb = computeBollingerBands(closes, params.bbPeriod);

  // ATR
  const atrData = computeATR(rows, params.atrPeriod);

  // Volume
  const latestVolume = latest.volume;
  const volSlice = rows.slice(-params.volMaPeriod).map((r) => r.volume);
  const avgVolume20D = volSlice.reduce((a, b) => a + b, 0) / volSlice.length;
  const volumeRatio = avgVolume20D > 0 ? latestVolume / avgVolume20D : 0;

  // NR patterns
  const last7 = rows.slice(-7);
  const ranges = last7.map((r) => r.high - r.low);
  const nr7Range = ranges[ranges.length - 1];
  const isNR7 = ranges.length === 7 && ranges.slice(0, 6).every((r) => nr7Range < r);
  const ranges4 = ranges.slice(-4);
  const isNR4 = ranges4.length === 4 && ranges4.slice(0, 3).every((r) => nr7Range < r);

  // RS
  const rs = computeRS(rows, indexRows);

  const partial: Omit<ScannerResult, 'score' | 'scorePercent'> = {
    symbol,
    sector: getSector(symbol),
    latestClose: latest.close,
    latestDate: latest.date,

    ema20,
    ema50,
    ema200,
    aboveEma20: ema20 > 0 && latest.close > ema20,
    aboveEma50: ema50 > 0 && latest.close > ema50,
    aboveEma200: ema200 > 0 && latest.close > ema200,
    ema20AboveEma50: ema20 > 0 && ema50 > 0 && ema20 > ema50,
    ema50AboveEma200: ema50 > 0 && ema200 > 0 && ema50 > ema200,

    rsi14,

    macdLine: macd.line,
    macdSignal: macd.signal,
    macdHistogram: macd.histogram,
    macdBullish: macd.bullish,
    macdCrossover: macd.crossover,

    adx14: adx.adx,
    plusDI: adx.plusDI,
    minusDI: adx.minusDI,

    supertrendBullish,

    bbUpper: bb.upper,
    bbMiddle: bb.middle,
    bbLower: bb.lower,
    bbExpanding: bb.bbExpanding,

    atr14: atrData.atr,
    atrExpanding: atrData.expanding,

    latestVolume,
    avgVolume20D,
    volumeRatio,

    isNR4,
    isNR7,

    rsRatio: rs.rsRatio,
    rsRising20: rs.rsRising20,
    rsAboveMA: rs.rsAboveMA,
    rsScore: 0,

    priceChange1D: pctChg1D(rows),
    priceChange1W: pctChg(rows, 6),
    priceChange1M: pctChg(rows, 22),
    priceChange3M: pctChg(rows, 65),
  };

  const { score, scorePercent } = computeScore(partial);
  return { ...partial, score, scorePercent };
}

// ─── Main scanner function ────────────────────────────────────────────────────

async function runScanner(indexType: string, params: ScannerParams): Promise<ScannerResponse> {
  const cacheKey = `${indexType}:${Object.values(params).join(',')}`;
  const cached = scannerCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < SCANNER_TTL) return cached.data;

  let symbols: string[];
  let indexRows: OHLCVRow[];

  if (indexType === 'nifty50') {
    symbols = NIFTY50_SYMBOLS;
    indexRows = readNifty50Index();
  } else if (indexType === 'nifty500') {
    const list = readNifty500List();
    symbols = list;
    indexRows = await readNifty500Index(list);
  } else {
    symbols = listAvailableSymbols();
    indexRows = await readNifty500Index(readNifty500List());
  }

  const results: ScannerResult[] = [];

  await Promise.all(
    symbols.map(async (symbol) => {
      const rows = readStockCSV(symbol);
      const r = computeScanner(symbol, rows, indexRows, params);
      if (r) results.push(r);
    })
  );

  // Assign RS percentile scores within this universe
  const sorted = [...results].sort((a, b) => a.rsRatio - b.rsRatio);
  const n = sorted.length;
  sorted.forEach((r, i) => {
    r.rsScore = n <= 1 ? 50 : Math.round((i / (n - 1)) * 100);
  });

  // Default sort: score desc → rsScore desc → volumeRatio desc
  results.sort((a, b) =>
    b.score !== a.score ? b.score - a.score :
    b.rsScore !== a.rsScore ? b.rsScore - a.rsScore :
    b.volumeRatio - a.volumeRatio
  );

  const dataDate = results.length > 0
    ? results.reduce((max, r) => r.latestDate > max ? r.latestDate : max, results[0].latestDate)
    : '';

  const data: ScannerResponse = {
    results,
    dataDate,
    universe: indexType,
    totalScanned: symbols.length,
    params,
  };

  scannerCache.set(cacheKey, { data, ts: Date.now() });
  return data;
}

// ─── Route handler ────────────────────────────────────────────────────────────

function parseIntParam(val: string | null, def: number): number {
  const n = parseInt(val ?? '', 10);
  return isNaN(n) ? def : n;
}

function parseFloatParam(val: string | null, def: number): number {
  const n = parseFloat(val ?? '');
  return isNaN(n) ? def : n;
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const indexType = searchParams.get('index') ?? 'nifty50';

  const d = DEFAULT_SCANNER_PARAMS;
  const params: ScannerParams = {
    rsiPeriod:    parseIntParam(searchParams.get('rsiPeriod'),    d.rsiPeriod),
    emaPeriod1:   parseIntParam(searchParams.get('emaPeriod1'),   d.emaPeriod1),
    emaPeriod2:   parseIntParam(searchParams.get('emaPeriod2'),   d.emaPeriod2),
    emaPeriod3:   parseIntParam(searchParams.get('emaPeriod3'),   d.emaPeriod3),
    macdFast:     parseIntParam(searchParams.get('macdFast'),     d.macdFast),
    macdSlow:     parseIntParam(searchParams.get('macdSlow'),     d.macdSlow),
    macdSignal:   parseIntParam(searchParams.get('macdSignal'),   d.macdSignal),
    stPeriod:     parseIntParam(searchParams.get('stPeriod'),     d.stPeriod),
    stMultiplier: parseFloatParam(searchParams.get('stMultiplier'), d.stMultiplier),
    bbPeriod:     parseIntParam(searchParams.get('bbPeriod'),     d.bbPeriod),
    adxPeriod:    parseIntParam(searchParams.get('adxPeriod'),    d.adxPeriod),
    atrPeriod:    parseIntParam(searchParams.get('atrPeriod'),    d.atrPeriod),
    volMaPeriod:  parseIntParam(searchParams.get('volMaPeriod'),  d.volMaPeriod),
  };

  try {
    const data = await runScanner(indexType, params);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/scanner] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
