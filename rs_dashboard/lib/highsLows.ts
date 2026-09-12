import { readStockCSVAsync, readNifty500List, readNifty500IndexSync } from './dataLoader';
import { getSector } from './sectors';
import { OHLCVRow } from './rs';

export type ProximityTier =
  | 'AT_HIGH'         // 0% to -2% (At/near ATH / 52W High)
  | 'IN_BASE'         // -2% to -8% (Base / Handle setup)
  | 'CONSOLIDATING'   // -8% to -15% (Healthy pullback to 50 DMA)
  | 'CORRECTING'      // -15% to -25% (Secondary base / deep pullback)
  | 'BROKEN_STAGE4';  // < -25% & below 200 DMA (Markdown)

export interface HighLowStockItem {
  symbol: string;
  sector: string;
  price: number;
  change1D: number;
  high52W: number;
  low52W: number;
  pctFrom52WHigh: number; // e.g. -1.5%
  pctAbove52WLow: number; // e.g. +65.2%
  tier: ProximityTier;
  tierLabel: string;
  sma50: number;
  sma200: number;
  isAboveSma50: boolean;
  isAboveSma200: boolean;
  isNew52WHighToday: boolean;
  isNew52WLowToday: boolean;
  volume: number;
  vol20Avg: number;
  sparkline: number[];
  dataDate: string;
}

export interface NetNewHighPoint {
  date: string;
  newHighs: number;
  newLows: number;
  netNewHighs: number;
  cumulativeNet: number;
  nifty500Close: number;
}

export interface HighsLowsResponse {
  totalScanned: number;
  dataDate: string;
  tierCounts: {
    atHigh: number;
    inBase: number;
    consolidating: number;
    correcting: number;
    broken: number;
  };
  todayExtremes: {
    new52WHighs: number;
    new52WLows: number;
    netNewHighs: number;
  };
  netNewHighsHistory: NetNewHighPoint[];
  stocks: HighLowStockItem[];
}

let _highsLowsCache: { data: HighsLowsResponse; ts: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

export async function runHighsLowsAnalysis(force = false): Promise<HighsLowsResponse> {
  const now = Date.now();
  if (!force && _highsLowsCache && now - _highsLowsCache.ts < CACHE_TTL_MS) {
    return _highsLowsCache.data;
  }

  const symbols = readNifty500List();
  const n500 = readNifty500IndexSync();
  const n500Map = new Map(n500.map((r) => [r.date, r.close]));

  let latestDate = '';
  const allStockSeries: { symbol: string; rows: OHLCVRow[]; dateMap: Map<string, number> }[] = [];

  // 1. Read all stock data
  await Promise.all(
    symbols.map(async (sym) => {
      try {
        const rows = await readStockCSVAsync(sym);
        if (rows && rows.length >= 200) {
          const dateMap = new Map<string, number>();
          for (let i = 0; i < rows.length; i++) {
            dateMap.set(rows[i].date, i);
          }
          allStockSeries.push({ symbol: sym, rows, dateMap });
          const lastD = rows[rows.length - 1].date;
          if (lastD > latestDate) latestDate = lastD;
        }
      } catch { /* skip */ }
    })
  );

  // 2. Compute per-stock proximity & latest metrics
  const stocks: HighLowStockItem[] = [];
  let todayNewHighs = 0;
  let todayNewLows = 0;

  for (const { symbol, rows } of allStockSeries) {
    const n = rows.length;
    const latest = rows[n - 1];
    const closes = rows.map((r) => r.close);
    const price = closes[n - 1];
    const prevPrice = closes[n - 2] ?? price;
    const change1D = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;

    // 52-week lookback
    const lookback52 = rows.slice(-252);
    const high52W = Math.max(...lookback52.map((r) => r.high));
    const low52W = Math.min(...lookback52.map((r) => r.low));

    const pctFrom52WHigh = high52W > 0 ? ((price - high52W) / high52W) * 100 : 0;
    const pctAbove52WLow = low52W > 0 ? ((price - low52W) / low52W) * 100 : 0;

    // Moving averages
    let sum50 = 0, sum200 = 0;
    for (let i = n - 50; i < n; i++) sum50 += closes[i];
    for (let i = n - 200; i < n; i++) sum200 += closes[i];
    const sma50 = sum50 / 50;
    const sma200 = sum200 / 200;

    // New 52W High / Low today
    const prevHigh52 = Math.max(...rows.slice(-253, -1).map((r) => r.high));
    const prevLow52 = Math.min(...rows.slice(-253, -1).map((r) => r.low));
    const isNew52WHighToday = latest.high >= prevHigh52 * 0.999;
    const isNew52WLowToday = latest.low <= prevLow52 * 1.001;

    if (isNew52WHighToday) todayNewHighs++;
    if (isNew52WLowToday) todayNewLows++;

    // Proximity Tier Categorization
    let tier: ProximityTier = 'CONSOLIDATING';
    let tierLabel = 'Consolidating (8–15%)';

    if (pctFrom52WHigh >= -2.0) {
      tier = 'AT_HIGH';
      tierLabel = 'At 52W High / ATH (0–2%)';
    } else if (pctFrom52WHigh >= -8.0) {
      tier = 'IN_BASE';
      tierLabel = 'In Base / Handle (2–8%)';
    } else if (pctFrom52WHigh >= -15.0) {
      tier = 'CONSOLIDATING';
      tierLabel = 'Consolidating (8–15%)';
    } else if (pctFrom52WHigh >= -25.0) {
      tier = 'CORRECTING';
      tierLabel = 'Pullback / Secondary Base (15–25%)';
    } else {
      tier = 'BROKEN_STAGE4';
      tierLabel = 'Broken / Stage 4 (>25% off peak)';
    }

    // 20-day volume
    const vol20 = rows.slice(-20).reduce((acc, r) => acc + r.volume, 0) / 20;

    // 20-day sparkline
    const sparkline = closes.slice(-20).map((c) => Math.round(c * 100) / 100);

    stocks.push({
      symbol,
      sector: getSector(symbol) || 'Other',
      price: Math.round(price * 100) / 100,
      change1D: Math.round(change1D * 100) / 100,
      high52W: Math.round(high52W * 100) / 100,
      low52W: Math.round(low52W * 100) / 100,
      pctFrom52WHigh: Math.round(pctFrom52WHigh * 10) / 10,
      pctAbove52WLow: Math.round(pctAbove52WLow * 10) / 10,
      tier,
      tierLabel,
      sma50: Math.round(sma50 * 100) / 100,
      sma200: Math.round(sma200 * 100) / 100,
      isAboveSma50: price > sma50,
      isAboveSma200: price > sma200,
      isNew52WHighToday,
      isNew52WLowToday,
      volume: latest.volume,
      vol20Avg: Math.round(vol20),
      sparkline,
      dataDate: latest.date,
    });
  }

  // Tier counts
  const tierCounts = {
    atHigh: stocks.filter((s) => s.tier === 'AT_HIGH').length,
    inBase: stocks.filter((s) => s.tier === 'IN_BASE').length,
    consolidating: stocks.filter((s) => s.tier === 'CONSOLIDATING').length,
    correcting: stocks.filter((s) => s.tier === 'CORRECTING').length,
    broken: stocks.filter((s) => s.tier === 'BROKEN_STAGE4').length,
  };

  // 3. Compute Net New Highs (NH - NL) history across the last 60 trading days
  const recentIndexBars = n500.slice(-60);
  const netNewHighsHistory: NetNewHighPoint[] = [];
  let cumulativeNet = 0;

  for (const bar of recentIndexBars) {
    const d = bar.date;
    let nhCount = 0;
    let nlCount = 0;

    for (const { rows, dateMap } of allStockSeries) {
      const idx = dateMap.get(d);
      if (idx !== undefined && idx >= 252) {
        const currHigh = rows[idx].high;
        const currLow = rows[idx].low;
        const prior52High = Math.max(...rows.slice(idx - 252, idx).map((r) => r.high));
        const prior52Low = Math.min(...rows.slice(idx - 252, idx).map((r) => r.low));

        if (currHigh >= prior52High * 0.999) nhCount++;
        if (currLow <= prior52Low * 1.001) nlCount++;
      }
    }

    const net = nhCount - nlCount;
    cumulativeNet += net;

    netNewHighsHistory.push({
      date: d,
      newHighs: nhCount,
      newLows: nlCount,
      netNewHighs: net,
      cumulativeNet,
      nifty500Close: bar.close,
    });
  }

  // Sort stocks by proximity to high (ascending distance from peak: 0% down to -50%)
  stocks.sort((a, b) => b.pctFrom52WHigh - a.pctFrom52WHigh);

  const result: HighsLowsResponse = {
    totalScanned: stocks.length,
    dataDate: latestDate,
    tierCounts,
    todayExtremes: {
      new52WHighs: todayNewHighs,
      new52WLows: todayNewLows,
      netNewHighs: todayNewHighs - todayNewLows,
    },
    netNewHighsHistory,
    stocks,
  };

  _highsLowsCache = { data: result, ts: Date.now() };
  return result;
}
