import { readStockCSVAsync, readNifty500List, readNifty500IndexSync } from './dataLoader';
import { getSector } from './sectors';
import { OHLCVRow, alignByDate } from './rs';

export interface MinerviniChecklist {
  c1_priceAbove150and200: boolean;
  c2_sma150Above200: boolean;
  c3_sma200TrendingUp: boolean;
  c4_sma50Above150and200: boolean;
  c5_priceAbove50: boolean;
  c6_price30PctAbove52WLow: boolean;
  c7_priceWithin25PctOf52WHigh: boolean;
  c8_mansfieldRSPositiveAndTrending: boolean;
}

export type StockStage =
  | 'Stage 2 (Markup)'
  | 'Stage 1 (Basing)'
  | 'Stage 3 (Distribution)'
  | 'Stage 4 (Markdown)';

export interface VCPSetup {
  isVCP: boolean;
  vcpType: 'Tight Base' | 'Volume Dry-Up' | 'Classic VCP' | 'None';
  atrRatio: number;
  volRatio20D: number;
  consolidationBandPct: number;
  isNR7: boolean;
  description: string;
}

export interface StageStockResult {
  symbol: string;
  sector: string;
  price: number;
  change1D: number;
  change1W: number;
  change1M: number;
  volume: number;
  vol20Avg: number;
  score: number; // 0 to 8
  checklist: MinerviniChecklist;
  stage: StockStage;
  stageConfidence: number;
  sma50: number;
  sma150: number;
  sma200: number;
  sma200Slope22: number; // % change of 200 SMA over 22 sessions
  pctVsSma50: number;
  pctVsSma150: number;
  pctVsSma200: number;
  high52W: number;
  pctFrom52WHigh: number;
  low52W: number;
  pctAbove52WLow: number;
  mansfieldRS: number;
  rsTrendingUp: boolean;
  vcp: VCPSetup;
  sparkline: number[];
  dataDate: string;
}

export interface StageScreenerResponse {
  totalScanned: number;
  stage2Count: number;
  strict8Count: number;
  vcpCount: number;
  stageCounts: {
    stage1: number;
    stage2: number;
    stage3: number;
    stage4: number;
  };
  topSectors: { sector: string; count: number }[];
  stocks: StageStockResult[];
  dataDate: string;
}

// ─── Cache ────────────────────────────────────────────────────────────────────
interface CacheEntry {
  data: StageScreenerResponse;
  ts: number;
}
let _screenerCache: CacheEntry | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

export function clearStageScreenerCache(): void {
  _screenerCache = null;
}

// Helper: True Range
function computeTR(curr: OHLCVRow, prev: OHLCVRow): number {
  return Math.max(
    curr.high - curr.low,
    Math.abs(curr.high - prev.close),
    Math.abs(curr.low - prev.close)
  );
}

/**
 * Executes the full Minervini 8-Point Trend Template and Stan Weinstein
 * Stage Analysis across the Nifty 500 universe.
 */
export async function runStageScreener(forceRefresh = false): Promise<StageScreenerResponse> {
  const now = Date.now();
  if (!forceRefresh && _screenerCache && now - _screenerCache.ts < CACHE_TTL_MS) {
    return _screenerCache.data;
  }

  const symbols = readNifty500List();
  const benchmarkRows = readNifty500IndexSync();
  const benchmarkMap = new Map<string, number>();
  for (const b of benchmarkRows) {
    benchmarkMap.set(b.date, b.close);
  }

  let latestDateFound = '';

  const stockPromises = symbols.map(async (symbol): Promise<StageStockResult | null> => {
    try {
      const rows = await readStockCSVAsync(symbol);
      if (!rows || rows.length < 200) return null;

      const n = rows.length;
      const latestRow = rows[n - 1];
      if (latestRow.date > latestDateFound) {
        latestDateFound = latestRow.date;
      }

      const closes = rows.map((r) => r.close);
      const price = closes[n - 1];
      const prevPrice = closes[n - 2] ?? price;
      const price1W = closes[Math.max(0, n - 6)] ?? price;
      const price1M = closes[Math.max(0, n - 23)] ?? price;

      const change1D = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
      const change1W = price1W > 0 ? ((price - price1W) / price1W) * 100 : 0;
      const change1M = price1M > 0 ? ((price - price1M) / price1M) * 100 : 0;

      // SMAs
      let sum50 = 0, sum150 = 0, sum200 = 0, sum200_prev22 = 0;
      for (let i = n - 50; i < n; i++) sum50 += closes[i];
      for (let i = n - 150; i < n; i++) sum150 += closes[i];
      for (let i = n - 200; i < n; i++) sum200 += closes[i];

      const prev22Idx = Math.max(0, n - 22);
      if (prev22Idx >= 200) {
        for (let i = prev22Idx - 200; i < prev22Idx; i++) sum200_prev22 += closes[i];
      } else {
        sum200_prev22 = sum200;
      }

      const sma50 = sum50 / 50;
      const sma150 = sum150 / 150;
      const sma200 = sum200 / 200;
      const sma200_22 = sum200_prev22 / 200;
      const sma200Slope22 = sma200_22 > 0 ? ((sma200 - sma200_22) / sma200_22) * 100 : 0;

      const pctVsSma50 = sma50 > 0 ? ((price - sma50) / sma50) * 100 : 0;
      const pctVsSma150 = sma150 > 0 ? ((price - sma150) / sma150) * 100 : 0;
      const pctVsSma200 = sma200 > 0 ? ((price - sma200) / sma200) * 100 : 0;

      // 52-Week High / Low (approx 252 sessions)
      const lookback52W = rows.slice(-252);
      const high52W = Math.max(...lookback52W.map((r) => r.high));
      const low52W = Math.min(...lookback52W.map((r) => r.low));

      const pctFrom52WHigh = high52W > 0 ? ((price - high52W) / high52W) * 100 : 0;
      const pctAbove52WLow = low52W > 0 ? ((price - low52W) / low52W) * 100 : 0;

      // 20-Day Average Volume
      const lookback20Vol = rows.slice(-20);
      const vol20Avg = lookback20Vol.reduce((acc, r) => acc + r.volume, 0) / 20;
      const volRatio20D = vol20Avg > 0 ? latestRow.volume / vol20Avg : 1;

      // Mansfield Relative Strength vs Benchmark
      // Compute RS ratio for the last 50 bars
      let mansfieldRS = 0;
      let rsTrendingUp = false;
      const rsLookback = 50;
      const rsRatios: number[] = [];

      for (let i = Math.max(0, n - rsLookback); i < n; i++) {
        const d = rows[i].date;
        const bClose = benchmarkMap.get(d);
        if (bClose && bClose > 0) {
          rsRatios.push((rows[i].close / bClose) * 1000);
        }
      }

      if (rsRatios.length >= 20) {
        // Mansfield RS = (Current RS Ratio / SMA(RS Ratio, 20)) - 1
        const currRSRatio = rsRatios[rsRatios.length - 1];
        const prev20RS = rsRatios.slice(-20);
        const rsSMA20 = prev20RS.reduce((a, b) => a + b, 0) / 20;
        mansfieldRS = rsSMA20 > 0 ? ((currRSRatio - rsSMA20) / rsSMA20) * 100 : 0;

        const rs5DaysAgo = rsRatios[Math.max(0, rsRatios.length - 6)];
        rsTrendingUp = currRSRatio > rs5DaysAgo;
      }

      // ─── 8 Minervini Trend Template Criteria ──────────────────────────────
      // 1. Stock Price > 150-day and 200-day SMA
      const c1 = price > sma150 && price > sma200;
      // 2. 150-day SMA > 200-day SMA
      const c2 = sma150 > sma200;
      // 3. 200-day SMA trending upward for at least 22 trading days (1 month)
      const c3 = sma200 > sma200_22;
      // 4. 50-day SMA > 150-day and 200-day SMA
      const c4 = sma50 > sma150 && sma50 > sma200;
      // 5. Current Price > 50-day SMA (intermediate momentum)
      const c5 = price > sma50;
      // 6. Current Price >= 30% above its 52-week low
      const c6 = price >= 1.30 * low52W;
      // 7. Current Price within 25% of its 52-week high (within 15% is prime)
      const c7 = price >= 0.75 * high52W;
      // 8. Relative Strength (Mansfield RS) >= 0 and trending upward
      const c8 = mansfieldRS >= 0 && rsTrendingUp;

      const checklist: MinerviniChecklist = {
        c1_priceAbove150and200: c1,
        c2_sma150Above200: c2,
        c3_sma200TrendingUp: c3,
        c4_sma50Above150and200: c4,
        c5_priceAbove50: c5,
        c6_price30PctAbove52WLow: c6,
        c7_priceWithin25PctOf52WHigh: c7,
        c8_mansfieldRSPositiveAndTrending: c8,
      };

      const score = [c1, c2, c3, c4, c5, c6, c7, c8].filter(Boolean).length;

      // ─── Stage Classification (Stan Weinstein) ───────────────────────────
      let stage: StockStage = 'Stage 1 (Basing)';
      let stageConfidence = 60;

      if (score >= 7) {
        stage = 'Stage 2 (Markup)';
        stageConfidence = score === 8 ? 95 : 85;
      } else if (price < sma50 && sma50 < sma200 && sma200 < sma200_22) {
        stage = 'Stage 4 (Markdown)';
        stageConfidence = 90;
      } else if (price < sma50 && sma50 >= sma200 && pctFrom52WHigh <= -15) {
        stage = 'Stage 3 (Distribution)';
        stageConfidence = 75;
      } else {
        // Stage 1 (Basing): Price oscillating around 200 SMA
        stage = 'Stage 1 (Basing)';
        stageConfidence = 70;
      }

      // ─── Volatility Contraction Pattern (VCP) Detection ─────────────────
      // 1. Stock must be near 52-week high (within 15%)
      // 2. Volatility contraction: ATR(10) / ATR(50) < 0.75
      // 3. Drying volume: latest volume or 3-day avg < 60% of 20-day average
      // 4. NR7: Narrowest range of the last 7 bars
      let atr10 = 0, atr50 = 0;
      if (n >= 51) {
        let sumTR10 = 0, sumTR50 = 0;
        for (let i = n - 50; i < n; i++) {
          const tr = computeTR(rows[i], rows[i - 1]);
          sumTR50 += tr;
          if (i >= n - 10) sumTR10 += tr;
        }
        atr10 = sumTR10 / 10;
        atr50 = sumTR50 / 50;
      }
      const atrRatio = atr50 > 0 ? atr10 / atr50 : 1;

      // Check last 7 bars consolidation band
      const last7 = rows.slice(-7);
      const hi7 = Math.max(...last7.map((r) => r.high));
      const lo7 = Math.min(...last7.map((r) => r.low));
      const consolidationBandPct = price > 0 ? ((hi7 - lo7) / price) * 100 : 0;

      // NR7 check
      const lastRange = latestRow.high - latestRow.low;
      const prior6Ranges = rows.slice(-7, -1).map((r) => r.high - r.low);
      const isNR7 = prior6Ranges.length === 6 && prior6Ranges.every((rng) => lastRange <= rng);

      let isVCP = false;
      let vcpType: 'Tight Base' | 'Volume Dry-Up' | 'Classic VCP' | 'None' = 'None';
      let vcpDescription = '';

      if (pctFrom52WHigh >= -15 && score >= 5) {
        const isVolDry = volRatio20D < 0.55;
        const isTight = consolidationBandPct <= 4.0 || atrRatio < 0.72;

        if (isVolDry && isTight) {
          isVCP = true;
          vcpType = 'Classic VCP';
          vcpDescription = `Tight base (${consolidationBandPct.toFixed(1)}% 7D band) + drying supply (${(volRatio20D * 100).toFixed(0)}% of 20D vol)`;
        } else if (isVolDry) {
          isVCP = true;
          vcpType = 'Volume Dry-Up';
          vcpDescription = `Institutional supply dried up: volume at ${(volRatio20D * 100).toFixed(0)}% of 20D average`;
        } else if (isTight || isNR7) {
          isVCP = true;
          vcpType = 'Tight Base';
          vcpDescription = `Volatility compression: ${isNR7 ? 'NR7 narrowest range' : `${consolidationBandPct.toFixed(1)}% consolidation band`}`;
        }
      }

      const vcpSetup: VCPSetup = {
        isVCP,
        vcpType,
        atrRatio: Math.round(atrRatio * 100) / 100,
        volRatio20D: Math.round(volRatio20D * 100) / 100,
        consolidationBandPct: Math.round(consolidationBandPct * 10) / 10,
        isNR7,
        description: vcpDescription,
      };

      // Sparkline (last 20 closes)
      const sparkline = closes.slice(-20).map((c) => Math.round(c * 100) / 100);

      return {
        symbol,
        sector: getSector(symbol) || 'Other',
        price: Math.round(price * 100) / 100,
        change1D: Math.round(change1D * 100) / 100,
        change1W: Math.round(change1W * 100) / 100,
        change1M: Math.round(change1M * 100) / 100,
        volume: latestRow.volume,
        vol20Avg: Math.round(vol20Avg),
        score,
        checklist,
        stage,
        stageConfidence,
        sma50: Math.round(sma50 * 100) / 100,
        sma150: Math.round(sma150 * 100) / 100,
        sma200: Math.round(sma200 * 100) / 100,
        sma200Slope22: Math.round(sma200Slope22 * 100) / 100,
        pctVsSma50: Math.round(pctVsSma50 * 10) / 10,
        pctVsSma150: Math.round(pctVsSma150 * 10) / 10,
        pctVsSma200: Math.round(pctVsSma200 * 10) / 10,
        high52W: Math.round(high52W * 100) / 100,
        pctFrom52WHigh: Math.round(pctFrom52WHigh * 10) / 10,
        low52W: Math.round(low52W * 100) / 100,
        pctAbove52WLow: Math.round(pctAbove52WLow * 10) / 10,
        mansfieldRS: Math.round(mansfieldRS * 10) / 10,
        rsTrendingUp,
        vcp: vcpSetup,
        sparkline,
        dataDate: latestRow.date,
      };
    } catch {
      return null;
    }
  });

  const parsed = (await Promise.all(stockPromises)).filter(
    (item): item is StageStockResult => item !== null
  );

  // Aggregations
  const stageCounts = {
    stage1: parsed.filter((s) => s.stage === 'Stage 1 (Basing)').length,
    stage2: parsed.filter((s) => s.stage === 'Stage 2 (Markup)').length,
    stage3: parsed.filter((s) => s.stage === 'Stage 3 (Distribution)').length,
    stage4: parsed.filter((s) => s.stage === 'Stage 4 (Markdown)').length,
  };

  const strict8Count = parsed.filter((s) => s.score === 8).length;
  const vcpCount = parsed.filter((s) => s.vcp.isVCP).length;

  // Sector breakdown of Stage 2 stocks
  const sectorMap = new Map<string, number>();
  for (const s of parsed) {
    if (s.stage === 'Stage 2 (Markup)') {
      sectorMap.set(s.sector, (sectorMap.get(s.sector) ?? 0) + 1);
    }
  }
  const topSectors = Array.from(sectorMap.entries())
    .map(([sector, count]) => ({ sector, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 8);

  // Default sorting: Stage 2 leaders first, then by score descending, then by Mansfield RS descending
  parsed.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return b.mansfieldRS - a.mansfieldRS;
  });

  const responseData: StageScreenerResponse = {
    totalScanned: parsed.length,
    stage2Count: stageCounts.stage2,
    strict8Count,
    vcpCount,
    stageCounts,
    topSectors,
    stocks: parsed,
    dataDate: latestDateFound,
  };

  _screenerCache = { data: responseData, ts: Date.now() };
  return responseData;
}
