import { NextResponse } from 'next/server';
import { readNifty50Index, readStockCSV, readNifty500List } from '@/lib/dataLoader';
import { OHLCVRow } from '@/lib/rs';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';

// ─── Cache ────────────────────────────────────────────────────────────────────
let breadthCache: { data: BreadthResponse; ts: number } | null = null;
const CACHE_TTL = 5 * 60 * 1000;

// ─── Types ────────────────────────────────────────────────────────────────────

export interface IndexStats {
  close: number;
  ema20: number;
  ema50: number;
  ema200: number;
  pctVsEma20: number;
  pctVsEma50: number;
  pctVsEma200: number;
  adx14: number | null;
  chopIndex: number | null;
  trendState: string;
  dataDate: string;
  nifty50BreadthPct: number;  // % of Nifty 50 stocks above their 200d SMA
}

export interface BreadthStats {
  totalScanned: number;
  aboveEma20Count: number;
  aboveEma50Count: number;
  aboveEma200Count: number;
  aboveEma20Pct: number;
  aboveEma50Pct: number;
  aboveEma200Pct: number;
  new52WHighCount: number;
  new52WLowCount: number;
  advancing1W: number;
  declining1W: number;
  unchanged1W: number;
  advDecRatio: number;
  rsiOverbought: number;   // RSI > 70
  rsiNeutral: number;      // RSI 40–70
  rsiOversold: number;     // RSI < 40
  participationScore: number;   // 0–100 composite breadth score
  bullPowerCount: number;       // close > MA20 > MA50 > MA200
  bullPowerPct: number;
  bearPowerCount: number;       // close < MA20 < MA50 < MA200
  bearPowerPct: number;
  rsiAbove60: number;
  rsiAbove60Pct: number;
  rsiBelow40: number;
  rsiBelow40Pct: number;
  netAdvanceDecline: number;    // advancing1W - declining1W
}

export interface BreadthResponse {
  nifty50: IndexStats;
  nifty500Breadth: BreadthStats;
  regimeLabel: string;
  regimeColor: 'green' | 'lime' | 'yellow' | 'orange' | 'red';
  dataDate: string;
}

// ─── Technical helpers ────────────────────────────────────────────────────────

function ema(closes: number[], period: number): number[] {
  if (closes.length === 0) return [];
  const k = 2 / (period + 1);
  const result: number[] = new Array(closes.length).fill(0);
  // seed with SMA of first `period` values
  let seed = 0;
  const start = Math.min(period - 1, closes.length - 1);
  for (let i = 0; i <= start; i++) seed += closes[i];
  seed /= start + 1;
  result[start] = seed;
  for (let i = start + 1; i < closes.length; i++) {
    result[i] = closes[i] * k + result[i - 1] * (1 - k);
  }
  return result;
}

function wilderSmooth(values: number[], period: number): number[] {
  const result: number[] = new Array(values.length).fill(0);
  if (values.length < period) return result;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  result[period - 1] = sum / period;
  for (let i = period; i < values.length; i++) {
    result[i] = (result[i - 1] * (period - 1) + values[i]) / period;
  }
  return result;
}

function computeADX(rows: OHLCVRow[], period = 14): number | null {
  if (rows.length < period * 2 + 1) return null;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < rows.length; i++) {
    const curr = rows[i];
    const prev = rows[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;
    const plusDM = upMove > downMove && upMove > 0 ? upMove : 0;
    const minusDM = downMove > upMove && downMove > 0 ? downMove : 0;
    trs.push(tr);
    plusDMs.push(plusDM);
    minusDMs.push(minusDM);
  }

  const atr = wilderSmooth(trs, period);
  const plusDI14 = wilderSmooth(plusDMs, period);
  const minusDI14 = wilderSmooth(minusDMs, period);

  const dxArr: number[] = atr.map((atrVal, i) => {
    if (i < period - 1 || atrVal === 0) return 0;
    const pdi = 100 * (plusDI14[i] / atrVal);
    const mdi = 100 * (minusDI14[i] / atrVal);
    const sum = pdi + mdi;
    if (sum === 0) return 0;
    return 100 * Math.abs(pdi - mdi) / sum;
  });

  const adxArr = wilderSmooth(dxArr, period);
  return adxArr[adxArr.length - 1] || null;
}

function computeChopIndex(rows: OHLCVRow[], period = 14): number | null {
  if (rows.length < period + 1) return null;

  const slice = rows.slice(-period - 1);
  let atrSum = 0;
  let highestHigh = -Infinity;
  let lowestLow = Infinity;

  for (let i = 1; i <= period; i++) {
    const curr = slice[i];
    const prev = slice[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    atrSum += tr;
    highestHigh = Math.max(highestHigh, curr.high);
    lowestLow = Math.min(lowestLow, curr.low);
  }

  const range = highestHigh - lowestLow;
  if (range === 0) return null;
  return 100 * Math.log10(atrSum / range) / Math.log10(period);
}

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
    avgGain = (avgGain * (period - 1) + (diff > 0 ? diff : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (diff < 0 ? Math.abs(diff) : 0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// ─── Index indicator computation ───────────────────────────────────────────────

function computeIndexStats(rows: OHLCVRow[]): IndexStats {
  const closes = rows.map((r) => r.close);
  const ema20Arr = ema(closes, 20);
  const ema50Arr = ema(closes, 50);
  const ema200Arr = ema(closes, 200);

  const last = rows[rows.length - 1];
  const e20 = ema20Arr[ema20Arr.length - 1];
  const e50 = ema50Arr[ema50Arr.length - 1];
  const e200 = ema200Arr[ema200Arr.length - 1];
  const close = last.close;

  const pctVsEma20 = e20 > 0 ? ((close - e20) / e20) * 100 : 0;
  const pctVsEma50 = e50 > 0 ? ((close - e50) / e50) * 100 : 0;
  const pctVsEma200 = e200 > 0 ? ((close - e200) / e200) * 100 : 0;

  const adx14 = computeADX(rows, 14);
  const chopIndex = computeChopIndex(rows, 14);

  // Trend State
  let trendState = 'Insufficient Data';
  if (e200 > 0) {
    if (close > e20 && e20 > e50 && e50 > e200) trendState = 'Strong Uptrend';
    else if (close > e50 && e50 > e200) trendState = 'Uptrend';
    else if (close > e200) trendState = 'Above EMA 200';
    else if (close < e50 && e50 < e200) trendState = 'Downtrend';
    else trendState = 'Below EMA 200';
  }

  return {
    close: +close.toFixed(2),
    ema20: +e20.toFixed(2),
    ema50: +e50.toFixed(2),
    ema200: +e200.toFixed(2),
    pctVsEma20: +pctVsEma20.toFixed(2),
    pctVsEma50: +pctVsEma50.toFixed(2),
    pctVsEma200: +pctVsEma200.toFixed(2),
    adx14: adx14 !== null ? +adx14.toFixed(2) : null,
    chopIndex: chopIndex !== null ? +chopIndex.toFixed(2) : null,
    trendState,
    dataDate: last.date,
    nifty50BreadthPct: 0,  // filled in GET handler after computeNifty50BreadthPct()
  };
}

// ─── Stock breadth computation ────────────────────────────────────────────────

function simpleMA(closes: number[], period: number): number {
  if (closes.length < period) return 0;
  const slice = closes.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

function pctChg(rows: OHLCVRow[], n: number): number {
  if (rows.length < 2) return 0;
  const slice = rows.slice(-Math.min(n, rows.length));
  const first = slice[0].close;
  const last = slice[slice.length - 1].close;
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}

async function computeBreadthStats(symbols: string[]): Promise<BreadthStats> {
  let aboveEma20 = 0, aboveEma50 = 0, aboveEma200 = 0;
  let new52WHigh = 0, new52WLow = 0;
  let advancing1W = 0, declining1W = 0, unchanged1W = 0;
  let rsiOverbought = 0, rsiNeutral = 0, rsiOversold = 0;
  let bullPower = 0, bearPower = 0;
  let rsiAbove60 = 0, rsiBelow40 = 0;
  let total = 0;

  await Promise.all(symbols.map(async (symbol) => {
    const rows = readStockCSV(symbol);
    if (rows.length < 22) return;

    total++;
    const closes = rows.map((r) => r.close);
    const latest = rows[rows.length - 1];

    const ma20 = simpleMA(closes, 20);
    const ma50 = simpleMA(closes, 50);
    const ma200 = simpleMA(closes, 200);

    if (latest.close > ma20 && ma20 > 0) aboveEma20++;
    if (latest.close > ma50 && ma50 > 0) aboveEma50++;
    if (latest.close > ma200 && ma200 > 0) aboveEma200++;

    // Bull/Bear power — all three MAs aligned
    if (ma20 > 0 && ma50 > 0 && ma200 > 0) {
      if (latest.close > ma20 && ma20 > ma50 && ma50 > ma200) bullPower++;
      if (latest.close < ma20 && ma20 < ma50 && ma50 < ma200) bearPower++;
    }

    // 52W high/low: within 0.5%
    const last252 = rows.slice(-252);
    const high52W = Math.max(...last252.map((r) => r.high));
    const low52W = Math.min(...last252.map((r) => r.low));
    const pctFromHigh = high52W > 0 ? ((latest.close - high52W) / high52W) * 100 : -999;
    const pctFromLow = low52W > 0 ? ((latest.close - low52W) / low52W) * 100 : 999;
    if (pctFromHigh >= -0.5) new52WHigh++;
    if (pctFromLow <= 0.5) new52WLow++;

    // 1W performance
    const chg1W = pctChg(rows, 6);
    if (chg1W > 0) advancing1W++;
    else if (chg1W < 0) declining1W++;
    else unchanged1W++;

    // RSI
    const rsi = wilderRSI(closes.slice(-60));
    if (rsi > 70) rsiOverbought++;
    else if (rsi < 40) rsiOversold++;
    else rsiNeutral++;

    if (rsi > 60) rsiAbove60++;
    if (rsi < 40) rsiBelow40++;
  }));

  const pct = (n: number) => total > 0 ? +(n / total * 100).toFixed(1) : 0;
  const advDecRatio = declining1W > 0 ? +(advancing1W / declining1W).toFixed(2) : advancing1W > 0 ? 99 : 0;

  const aboveEma200Pct = pct(aboveEma200);
  const aboveEma50Pct = pct(aboveEma50);
  const aboveEma20Pct = pct(aboveEma20);
  const netAdvanceDecline = advancing1W - declining1W;
  const participationScore = Math.round(
    aboveEma200Pct * 0.4 + aboveEma50Pct * 0.3 + aboveEma20Pct * 0.2 +
    (advDecRatio / (advDecRatio + 1)) * 100 * 0.1
  );

  return {
    totalScanned: total,
    aboveEma20Count: aboveEma20,
    aboveEma50Count: aboveEma50,
    aboveEma200Count: aboveEma200,
    aboveEma20Pct,
    aboveEma50Pct,
    aboveEma200Pct,
    new52WHighCount: new52WHigh,
    new52WLowCount: new52WLow,
    advancing1W,
    declining1W,
    unchanged1W,
    advDecRatio,
    rsiOverbought,
    rsiNeutral,
    rsiOversold,
    participationScore,
    bullPowerCount: bullPower,
    bullPowerPct: pct(bullPower),
    bearPowerCount: bearPower,
    bearPowerPct: pct(bearPower),
    rsiAbove60,
    rsiAbove60Pct: pct(rsiAbove60),
    rsiBelow40,
    rsiBelow40Pct: pct(rsiBelow40),
    netAdvanceDecline,
  };
}

function computeNifty50BreadthPct(): number {
  let above = 0, total = 0;
  for (const symbol of NIFTY50_SYMBOLS) {
    const rows = readStockCSV(symbol);
    if (rows.length < 200) continue;
    total++;
    const closes = rows.map((r) => r.close);
    const ma200 = simpleMA(closes, 200);
    const latest = closes[closes.length - 1];
    if (latest > ma200 && ma200 > 0) above++;
  }
  return total > 0 ? +((above / total) * 100).toFixed(1) : 0;
}

function deriveRegime(aboveEma200Pct: number): { label: string; color: BreadthResponse['regimeColor'] } {
  if (aboveEma200Pct >= 60) return { label: 'Bull Market', color: 'green' };
  if (aboveEma200Pct >= 50) return { label: 'Cautious Bull', color: 'lime' };
  if (aboveEma200Pct >= 45) return { label: 'Caution / Chop', color: 'yellow' };
  if (aboveEma200Pct >= 40) return { label: 'Transition', color: 'orange' };
  return { label: 'Bear Market', color: 'red' };
}

// ─── Route ────────────────────────────────────────────────────────────────────

export async function GET() {
  try {
    if (breadthCache && Date.now() - breadthCache.ts < CACHE_TTL) {
      return NextResponse.json({ success: true, data: breadthCache.data });
    }

    const nifty50Rows = readNifty50Index();
    const nifty500Symbols = readNifty500List();

    const [nifty50, nifty500Breadth, nifty50BreadthPct] = await Promise.all([
      Promise.resolve(computeIndexStats(nifty50Rows)),
      computeBreadthStats(nifty500Symbols),
      Promise.resolve(computeNifty50BreadthPct()),
    ]);

    nifty50.nifty50BreadthPct = nifty50BreadthPct;

    const { label: regimeLabel, color: regimeColor } = deriveRegime(nifty500Breadth.aboveEma200Pct);

    const data: BreadthResponse = {
      nifty50,
      nifty500Breadth,
      regimeLabel,
      regimeColor,
      dataDate: nifty50.dataDate,
    };

    breadthCache = { data, ts: Date.now() };
    return NextResponse.json({ success: true, data });
  } catch (err) {
    console.error('[/api/breadth] Error:', err);
    return NextResponse.json({ success: false, error: String(err) }, { status: 500 });
  }
}
