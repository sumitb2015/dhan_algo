import { readStockCSVAsync, readNifty500List, readNifty50Index } from './dataLoader';
import { getSector } from './sectors';
import { OHLCVRow } from './rs';

export interface SectorConstituent {
  symbol: string;
  price: number;
  change1D: number;
  change1W: number;
  change1M: number;
  above20: boolean;
  above50: boolean;
  above200: boolean;
  mansfieldRS: number;
  volume: number;
  vol20Avg: number;
}

export interface SectorMetrics {
  sector: string;
  stockCount: number;
  pctAbove20: number;
  pctAbove50: number;
  pctAbove200: number;
  accDistScore: number; // % up volume
  sectorRS: number;     // median RS
  median1W: number;
  median1M: number;
  median3M: number;
  hasInternalThrust: boolean;
  thrustLabel: string;
  topLeaders: { symbol: string; price: number; rs: number }[];
  constituents: SectorConstituent[];
}

export interface SectorBreadthResponse {
  totalSectors: number;
  totalStocks: number;
  dataDate: string;
  sectors: SectorMetrics[];
}

let _sectorBreadthCache: { data: SectorBreadthResponse; ts: number } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

function computeSMA(values: number[], period: number): number {
  if (values.length < period) return values[values.length - 1] || 0;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export async function runSectorBreadthAnalysis(force = false): Promise<SectorBreadthResponse> {
  const now = Date.now();
  if (!force && _sectorBreadthCache && now - _sectorBreadthCache.ts < CACHE_TTL_MS) {
    return _sectorBreadthCache.data;
  }

  const symbols = readNifty500List();
  const n50 = readNifty50Index();
  const n50Map = new Map(n50.map((r) => [r.date, r.close]));

  let latestDate = '';
  const sectorGroups = new Map<string, SectorConstituent[]>();
  const sectorHistoric20DMA = new Map<string, { tenDaysAgoAbove20Pct: number }>();

  // Process all stocks
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
        const price1M = closes[Math.max(0, n - 23)] ?? price;

        const change1D = prevPrice > 0 ? ((price - prevPrice) / prevPrice) * 100 : 0;
        const change1W = price1W > 0 ? ((price - price1W) / price1W) * 100 : 0;
        const change1M = price1M > 0 ? ((price - price1M) / price1M) * 100 : 0;

        const sma20 = computeSMA(closes, 20);
        const sma50 = computeSMA(closes, 50);
        const sma200 = computeSMA(closes, 200);

        const above20 = price > sma20;
        const above50 = price > sma50;
        const above200 = price > sma200;

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

        const vol20 = rows.slice(-20).reduce((acc, r) => acc + r.volume, 0) / 20;
        const sec = getSector(sym) || 'Other';

        const constituent: SectorConstituent = {
          symbol: sym,
          price: Math.round(price * 100) / 100,
          change1D: Math.round(change1D * 100) / 100,
          change1W: Math.round(change1W * 100) / 100,
          change1M: Math.round(change1M * 100) / 100,
          above20,
          above50,
          above200,
          mansfieldRS: Math.round(mansfieldRS * 10) / 10,
          volume: lastRow.volume,
          vol20Avg: Math.round(vol20),
        };

        if (!sectorGroups.has(sec)) {
          sectorGroups.set(sec, []);
        }
        sectorGroups.get(sec)!.push(constituent);
      } catch { /* skip */ }
    })
  );

  // Compute aggregated sector metrics
  const sectors: SectorMetrics[] = [];

  for (const [sector, members] of sectorGroups.entries()) {
    const count = members.length;
    if (count === 0) continue;

    const above20Count = members.filter((m) => m.above20).length;
    const above50Count = members.filter((m) => m.above50).length;
    const above200Count = members.filter((m) => m.above200).length;

    const pctAbove20 = (above20Count / count) * 100;
    const pctAbove50 = (above50Count / count) * 100;
    const pctAbove200 = (above200Count / count) * 100;

    // Accumulation / Distribution Score: Up-volume / Total Volume
    let upVol = 0;
    let totalVol = 0;
    for (const m of members) {
      totalVol += m.volume;
      if (m.change1D > 0) upVol += m.volume;
    }
    const accDistScore = totalVol > 0 ? (upVol / totalVol) * 100 : 50;

    // Median RS & Returns
    const sortedRS = [...members.map((m) => m.mansfieldRS)].sort((a, b) => a - b);
    const sorted1W = [...members.map((m) => m.change1W)].sort((a, b) => a - b);
    const sorted1M = [...members.map((m) => m.change1M)].sort((a, b) => a - b);

    const medianRS = sortedRS[Math.floor(count / 2)] || 0;
    const median1W = sorted1W[Math.floor(count / 2)] || 0;
    const median1M = sorted1M[Math.floor(count / 2)] || 0;

    // Internal Thrust: Sector breadth is exceptionally strong (>70% above 20 DMA & >60% above 50 DMA)
    const hasInternalThrust = pctAbove20 >= 70 && pctAbove50 >= 55;
    const thrustLabel = hasInternalThrust
      ? 'THRUST ACTIVE (>70% > 20 DMA)'
      : pctAbove20 <= 25
        ? 'OVERSOLD (<25% > 20 DMA)'
        : 'NORMAL';

    // Top 3 Leaders in Sector by Mansfield RS
    const topLeaders = [...members]
      .sort((a, b) => b.mansfieldRS - a.mansfieldRS)
      .slice(0, 3)
      .map((m) => ({ symbol: m.symbol, price: m.price, rs: m.mansfieldRS }));

    // Sort constituents by Mansfield RS descending
    members.sort((a, b) => b.mansfieldRS - a.mansfieldRS);

    sectors.push({
      sector,
      stockCount: count,
      pctAbove20: Math.round(pctAbove20 * 10) / 10,
      pctAbove50: Math.round(pctAbove50 * 10) / 10,
      pctAbove200: Math.round(pctAbove200 * 10) / 10,
      accDistScore: Math.round(accDistScore * 10) / 10,
      sectorRS: Math.round(medianRS * 10) / 10,
      median1W: Math.round(median1W * 10) / 10,
      median1M: Math.round(median1M * 10) / 10,
      median3M: 0,
      hasInternalThrust,
      thrustLabel,
      topLeaders,
      constituents: members,
    });
  }

  // Sort sectors by Sector RS descending
  sectors.sort((a, b) => b.sectorRS - a.sectorRS);

  const totalStocksScanned = sectors.reduce((acc, s) => acc + s.stockCount, 0);

  const response: SectorBreadthResponse = {
    totalSectors: sectors.length,
    totalStocks: totalStocksScanned,
    dataDate: latestDate,
    sectors,
  };

  _sectorBreadthCache = { data: response, ts: Date.now() };
  return response;
}
