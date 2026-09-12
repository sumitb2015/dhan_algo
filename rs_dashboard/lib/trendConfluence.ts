import { readStockCSVAsync, readNifty500List, readNifty50Index } from './dataLoader';
import { getSector } from './sectors';
import { OHLCVRow } from './rs';

export interface TimeframeSignals {
  weeklyUptrend: boolean;     // Weekly EMA 10 > EMA 40 & Close > EMA 10
  dailyUptrend: boolean;      // Daily Price > EMA 50 & EMA 50 > EMA 200
  shortTermMomentum: boolean; // Daily Price > EMA 20 & EMA 20 > EMA 50
  adxStrong: boolean;         // ADX 14 >= 25
  rsBullish: boolean;         // Mansfield RS >= 0
}

export interface StockConfluenceItem {
  symbol: string;
  sector: string;
  price: number;
  change1D: number;
  change1W: number;
  stars: number; // 1 to 5
  signals: TimeframeSignals;
  adx: number;
  weeklyEma10: number;
  weeklyEma40: number;
  dailyEma20: number;
  dailyEma50: number;
  dailyEma200: number;
  mansfieldRS: number;
  actionSignal: 'STRONG BUY (5★)' | 'BUY (4★)' | 'NEUTRAL (3★)' | 'AVOID (1–2★)';
  sparkline: number[];
  dataDate: string;
}

export interface TrendConfluenceResponse {
  totalScanned: number;
  star5Count: number;
  star4Count: number;
  star3Count: number;
  bearishCount: number;
  dataDate: string;
  stocks: StockConfluenceItem[];
}

let _confluenceCache: { data: TrendConfluenceResponse; ts: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function computeEMA(values: number[], span: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (span + 1);
  const ema = new Array<number>(values.length);
  ema[0] = values[0];
  for (let i = 1; i < values.length; i++) {
    ema[i] = values[i] * k + ema[i - 1] * (1 - k);
  }
  return ema;
}

// Resample daily OHLCV rows to weekly candles
function resampleToWeekly(dailyRows: OHLCVRow[]): { open: number; high: number; low: number; close: number; date: string }[] {
  const weeks = new Map<string, OHLCVRow[]>();

  for (const r of dailyRows) {
    // Group by year and ISO week
    const d = new Date(r.date + 'T00:00:00Z');
    const day = d.getUTCDay();
    // Monday of the week
    const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1);
    const monday = new Date(d.setUTCDate(diff)).toISOString().slice(0, 10);

    if (!weeks.has(monday)) weeks.set(monday, []);
    weeks.get(monday)!.push(r);
  }

  const weeklyCandles = [];
  for (const [wDate, rows] of weeks.entries()) {
    weeklyCandles.push({
      date: wDate,
      open: rows[0].open,
      high: Math.max(...rows.map((r) => r.high)),
      low: Math.min(...rows.map((r) => r.low)),
      close: rows[rows.length - 1].close,
    });
  }

  return weeklyCandles.sort((a, b) => a.date.localeCompare(b.date));
}

function computeADX(rows: OHLCVRow[], period = 14): number {
  const n = rows.length;
  if (n < period * 2 + 2) return 20;

  const trs: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < n; i++) {
    const h = rows[i].high, l = rows[i].low, pc = rows[i - 1].close;
    const ph = rows[i - 1].high, pl = rows[i - 1].low;
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
    const up = h - ph, dn = pl - l;
    plusDMs.push(up > dn && up > 0 ? up : 0);
    minusDMs.push(dn > up && dn > 0 ? dn : 0);
  }

  let sTR = trs.slice(0, period).reduce((a, b) => a + b, 0);
  let sPlus = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let sMinus = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxVals: number[] = [];
  for (let i = period; i < trs.length; i++) {
    sTR = sTR - sTR / period + trs[i];
    sPlus = sPlus - sPlus / period + plusDMs[i];
    sMinus = sMinus - sMinus / period + minusDMs[i];
    const pDI = sTR > 0 ? (sPlus / sTR) * 100 : 0;
    const mDI = sTR > 0 ? (sMinus / sTR) * 100 : 0;
    const s = pDI + mDI;
    dxVals.push(s > 0 ? (Math.abs(pDI - mDI) / s) * 100 : 0);
  }

  if (dxVals.length < period) return 20;
  let adx = dxVals.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxVals.length; i++) {
    adx = (adx * (period - 1) + dxVals[i]) / period;
  }
  return adx;
}

export async function runTrendConfluenceAnalysis(force = false): Promise<TrendConfluenceResponse> {
  const now = Date.now();
  if (!force && _confluenceCache && now - _confluenceCache.ts < CACHE_TTL_MS) {
    return _confluenceCache.data;
  }

  const symbols = readNifty500List();
  const n50 = readNifty50Index();
  const n50Map = new Map(n50.map((r) => [r.date, r.close]));

  let latestDate = '';
  const stockItems: StockConfluenceItem[] = [];

  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const rows = await readStockCSVAsync(sym);
        if (!rows || rows.length < 200) return;

        const n = rows.length;
        const lastRow = rows[n - 1];
        if (lastRow.date > latestDate) latestDate = lastRow.date;

        const closes = rows.map((r) => r.close);
        const price = closes[n - 1];
        const prevPrice = closes[n - 2] ?? price;
        const price1W = closes[Math.max(0, n - 6)] ?? price;

        const change1D = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
        const change1W = price1W > 0 ? ((price - price1W) / price1W) * 100 : 0;

        // Daily EMAs
        const dailyEma20Arr = computeEMA(closes, 20);
        const dailyEma50Arr = computeEMA(closes, 50);
        const dailyEma200Arr = computeEMA(closes, 200);

        const dEma20 = dailyEma20Arr[n - 1];
        const dEma50 = dailyEma50Arr[n - 1];
        const dEma200 = dailyEma200Arr[n - 1];

        // Weekly EMAs (10-week and 40-week)
        const weeklyCandles = resampleToWeekly(rows);
        const weeklyCloses = weeklyCandles.map((w) => w.close);
        const wn = weeklyCloses.length;
        const weeklyEma10Arr = computeEMA(weeklyCloses, 10);
        const weeklyEma40Arr = computeEMA(weeklyCloses, 40);

        const wEma10 = wn > 0 ? weeklyEma10Arr[wn - 1] : dEma50;
        const wEma40 = wn > 0 ? weeklyEma40Arr[wn - 1] : dEma200;
        const weeklyPrice = wn > 0 ? weeklyCloses[wn - 1] : price;

        // ADX(14)
        const adx = computeADX(rows, 14);

        // Mansfield RS vs Nifty 50
        let mansfieldRS = 0;
        const rsRatios: number[] = [];
        for (let i = Math.max(0, n - 50); i < n; i++) {
          const bClose = n50Map.get(rows[i].date);
          if (bClose && bClose > 0) {
            rsRatios.push((rows[i].close / bClose) * 1000);
          }
        }
        if (rsRatios.length >= 20) {
          const currRS = rsRatios[rsRatios.length - 1];
          const prev20 = rsRatios.slice(-20);
          const avgRS = prev20.reduce((a, b) => a + b, 0) / 20;
          mansfieldRS = avgRS > 0 ? ((currRS - avgRS) / avgRS) * 100 : 0;
        }

        // 5 Timeframe Confluence Criteria
        // 1. Weekly Uptrend: Weekly 10 EMA > 40 EMA & Weekly Close > 10 EMA
        const weeklyUptrend = wEma10 > wEma40 && weeklyPrice > wEma10;
        // 2. Daily Uptrend: Daily Price > 50 EMA & 50 EMA > 200 EMA
        const dailyUptrend = price > dEma50 && dEma50 > dEma200;
        // 3. Short-Term Momentum: Price > 20 EMA & 20 EMA > 50 EMA
        const shortTermMomentum = price > dEma20 && dEma20 > dEma50;
        // 4. Trend Strength: ADX >= 25 (Wilder strong trend definition)
        const adxStrong = adx >= 25.0;
        // 5. Outperformance: Mansfield RS >= 0
        const rsBullish = mansfieldRS >= 0;

        const signals: TimeframeSignals = {
          weeklyUptrend,
          dailyUptrend,
          shortTermMomentum,
          adxStrong,
          rsBullish,
        };

        const stars = [weeklyUptrend, dailyUptrend, shortTermMomentum, adxStrong, rsBullish].filter(
          Boolean
        ).length;

        let actionSignal: 'STRONG BUY (5★)' | 'BUY (4★)' | 'NEUTRAL (3★)' | 'AVOID (1–2★)' =
          'AVOID (1–2★)';
        if (stars === 5) actionSignal = 'STRONG BUY (5★)';
        else if (stars === 4) actionSignal = 'BUY (4★)';
        else if (stars === 3) actionSignal = 'NEUTRAL (3★)';

        const sparkline = closes.slice(-20).map((c) => Math.round(c * 100) / 100);

        stockItems.push({
          symbol: sym,
          sector: getSector(sym) || 'Other',
          price: Math.round(price * 100) / 100,
          change1D: Math.round(change1D * 100) / 100,
          change1W: Math.round(change1W * 100) / 100,
          stars,
          signals,
          adx: Math.round(adx * 10) / 10,
          weeklyEma10: Math.round(wEma10 * 10) / 10,
          weeklyEma40: Math.round(wEma40 * 10) / 10,
          dailyEma20: Math.round(dEma20 * 10) / 10,
          dailyEma50: Math.round(dEma50 * 10) / 10,
          dailyEma200: Math.round(dEma200 * 10) / 10,
          mansfieldRS: Math.round(mansfieldRS * 10) / 10,
          actionSignal,
          sparkline,
          dataDate: lastRow.date,
        });
      } catch { /* skip */ }
    })
  );

  // Default sort: Stars descending, then Mansfield RS descending
  stockItems.sort((a, b) => {
    if (b.stars !== a.stars) return b.stars - a.stars;
    return b.mansfieldRS - a.mansfieldRS;
  });

  const star5Count = stockItems.filter((s) => s.stars === 5).length;
  const star4Count = stockItems.filter((s) => s.stars === 4).length;
  const star3Count = stockItems.filter((s) => s.stars === 3).length;
  const bearishCount = stockItems.filter((s) => s.stars <= 2).length;

  const response: TrendConfluenceResponse = {
    totalScanned: stockItems.length,
    star5Count,
    star4Count,
    star3Count,
    bearishCount,
    dataDate: latestDate,
    stocks: stockItems,
  };

  _confluenceCache = { data: response, ts: Date.now() };
  return response;
}
