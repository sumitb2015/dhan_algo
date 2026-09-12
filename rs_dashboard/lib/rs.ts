// Pure RS calculation functions — no I/O

export interface OHLCVRow {
  date: string; // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface RSResult {
  symbol: string;
  rsRatio: number;       // current RS ratio vs benchmark (100 = inline with index)
  rsScore: number;       // 0–100 percentile rank among peers
  rsRating: 'A' | 'B' | 'C' | 'D';
  rsRank: number;        // rank among peers (1 = strongest)
  rsMomentum: 'rising' | 'falling' | 'neutral'; // RS trend direction
  priceChange1D: number; // %
  priceChange1W: number; // %
  priceChange1M: number; // %
  priceChange3M: number; // %
  priceChange1Y: number; // %
  latestClose: number;
  latestDate: string;
  rsChange1W: number;    // RS ratio change over 1 week
  trend: number[];       // last 20 RS ratio values for sparkline
  sector?: string;
  high52W: number;          // 52-week high price
  pctFrom52WHigh: number;   // % from 52W high (0 = at high, -5 = 5% below)
  isRSNewHigh: boolean;     // RS ratio at its 20-day high

  // Institutional Decision & Trend Gates
  sma50?: number;
  sma200?: number;
  isAboveSma50?: boolean;
  isAboveSma200?: boolean;
  isStage2?: boolean;
  volume?: number;
  vol20Avg?: number;
  volSurge?: number;
  mansfieldRS?: number;
}

export interface ChartPoint {
  date: string;
  stockClose: number;
  indexClose: number;
  rsLine: number;        // rebased to 100 at start of period
}

/**
 * Parse a YYYY-MM-DD date string into a comparable number.
 */
export function dateToNum(d: string): number {
  return parseInt(d.replace(/-/g, ''), 10);
}

/**
 * Align two sorted arrays on common dates.
 * Returns an array of [stockRow, indexRow] for matching dates only.
 */
export function alignByDate(
  stock: OHLCVRow[],
  index: OHLCVRow[]
): Array<{ date: string; stockClose: number; stockOpen: number; indexClose: number }> {
  const indexMap = new Map<string, number>();
  for (const row of index) indexMap.set(row.date, row.close);

  return stock
    .filter((r) => indexMap.has(r.date))
    .map((r) => ({
      date: r.date,
      stockClose: r.close,
      stockOpen: r.open,
      indexClose: indexMap.get(r.date)!,
    }));
}

/**
 * Compute the RS ratio line (Mansfield style).
 * rsLine[i] = (stockClose[i] / stockClose[0]) / (indexClose[i] / indexClose[0]) * 100
 * At the start date the RS line = 100. Values > 100 mean outperforming.
 */
export function computeRSLine(
  aligned: Array<{ date: string; stockClose: number; indexClose: number }>,
  period: number, // chart display period
  lookback: number = 252 // dynamic lookback period (50, 100, 252 etc)
): ChartPoint[] {
  if (aligned.length <= lookback) return [];

  const result: ChartPoint[] = [];
  for (let i = lookback; i < aligned.length; i++) {
    const curr = aligned[i];
    const base = aligned[i - lookback];
    if (base.stockClose === 0 || base.indexClose === 0) continue;

    // RS = (Stock Close / Stock Close N Days Ago) / (Index Close / Index Close N Days Ago) - 1
    const rsLine = ((curr.stockClose / base.stockClose) / (curr.indexClose / base.indexClose)) - 1;
    result.push({
      date: curr.date,
      stockClose: curr.stockClose,
      indexClose: curr.indexClose,
      rsLine: rsLine,
    });
  }

  return result.slice(-period);
}

/**
 * Clamp the requested lookback down to what the aligned series can actually
 * support. Recently-listed stocks (IPOs, post-demerger relistings) have far
 * less than a year of history — without this, computeCurrentRS would silently
 * return 0 (a fake "inline with index" reading) instead of a real RS ratio
 * computed over the stock's available history, corrupting its rank/score.
 */
function effectiveLookback(alignedLength: number, lookback: number): number {
  return Math.min(lookback, alignedLength - 1);
}

/**
 * Compute the RS ratio at a single point in time.
 * currentRS = (stockClose[-1] / stockClose[-52w]) / (indexClose[-1] / indexClose[-52w]) - 1
 * Falls back to the longest lookback the aligned series supports (min 20 rows)
 * when the stock has less history than requested, rather than returning 0.
 */
export function computeCurrentRS(
  aligned: Array<{ stockClose: number; indexClose: number }>,
  lookback: number = 252 // dynamic lookback period (50, 100, 252 etc)
): number {
  const lb = effectiveLookback(aligned.length, lookback);
  if (lb < 20) return 0;
  const curr = aligned[aligned.length - 1];
  const base = aligned[aligned.length - 1 - lb];
  if (base.stockClose === 0 || base.indexClose === 0) return 0;
  return ((curr.stockClose / base.stockClose) / (curr.indexClose / base.indexClose)) - 1;
}

/**
 * Find the stockClose for the latest row whose date is <= targetDate (YYYY-MM-DD).
 * Skips the last element (today). Returns null if no row qualifies.
 */
function findCloseOnOrBefore(
  arr: Array<{ date: string; stockClose: number }>,
  targetDate: string
): number | null {
  for (let i = arr.length - 2; i >= 0; i--) {
    if (arr[i].date <= targetDate) return arr[i].stockClose;
  }
  return null;
}

/**
 * Compute % change from the close on/before targetDate to the latest close.
 */
function pctChangeByDate(
  arr: Array<{ date: string; stockClose: number }>,
  targetDate: string
): number {
  if (arr.length < 2) return 0;
  const latest = arr[arr.length - 1].stockClose;
  const base = findCloseOnOrBefore(arr, targetDate);
  if (base === null || base === 0) return 0;
  return ((latest - base) / base) * 100;
}

function shiftDate(dateStr: string, days?: number, months?: number, years?: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  if (days)   d.setUTCDate(d.getUTCDate() - days);
  if (months) d.setUTCMonth(d.getUTCMonth() - months);
  if (years)  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

/**
 * 1-day % change, robust to the Dhan API quirk where today's daily OHLCV
 * carries the previous session's settlement price in `close` until EOD
 * processing finishes (~4 PM IST).  Falls back to `open` so the value is
 * meaningful during market hours.
 */
function pctChange1D(arr: Array<{ stockClose: number; stockOpen?: number }>): number {
  if (arr.length < 2) return 0;
  const curr = arr[arr.length - 1];
  const prev = arr[arr.length - 2];
  if (prev.stockClose === 0) return 0;

  let currPrice = curr.stockClose;
  if (currPrice === prev.stockClose && curr.stockOpen && curr.stockOpen > 0) {
    currPrice = curr.stockOpen;
  }
  return ((currPrice - prev.stockClose) / prev.stockClose) * 100;
}

/**
 * Assign percentile rank scores, ratings, and ordinal rank to all stocks.
 * Rank 1 = strongest RS (highest ratio), rank n = weakest.
 */
export function assignRSScores(
  stocks: Array<{ symbol: string; rsRatio: number }>
): Map<string, { rsScore: number; rsRating: 'A' | 'B' | 'C' | 'D'; rsRank: number }> {
  const sorted = [...stocks].sort((a, b) => a.rsRatio - b.rsRatio);
  const result = new Map<string, { rsScore: number; rsRating: 'A' | 'B' | 'C' | 'D'; rsRank: number }>();
  const n = sorted.length;

  sorted.forEach((s, i) => {
    const rsScore = n <= 1 ? 50 : Math.round((i / (n - 1)) * 100);
    const rsRating: 'A' | 'B' | 'C' | 'D' =
      rsScore >= 80 ? 'A' : rsScore >= 60 ? 'B' : rsScore >= 40 ? 'C' : 'D';
    // rank 1 = best (highest RS = last in ascending sort = index n-1-i from top)
    const rsRank = n - i;
    result.set(s.symbol, { rsScore, rsRating, rsRank });
  });
  return result;
}

/**
 * Build a full RS result for one stock, given its aligned series.
 */
export function buildRSResult(
  symbol: string,
  aligned: Array<{ date: string; stockClose: number; indexClose: number }>,
  lookback: number = 252,
  rawStockRows?: OHLCVRow[]
): Omit<RSResult, 'rsScore' | 'rsRating' | 'rsRank' | 'rsMomentum'> {
  const rsRatio = computeCurrentRS(aligned, lookback);
  const latest = aligned[aligned.length - 1];

  // 1-week RS change (5 trading days)
  const rsRatio1WAgo = computeCurrentRS(
    aligned.slice(0, Math.max(1, aligned.length - 5)),
    lookback
  );
  const rsChange1W = rsRatio - rsRatio1WAgo;

  // Trend: last 20 RS values, using the same degraded lookback as rsRatio
  // above so short-history stocks (recent IPOs/relistings) still get a
  // populated sparkline and a real isRSNewHigh check instead of an empty one.
  const lb = effectiveLookback(aligned.length, lookback);
  const trend: number[] = [];
  if (lb >= 20) {
    const startIndex = Math.max(lb, aligned.length - 20);
    for (let i = startIndex; i < aligned.length; i++) {
      const curr = aligned[i];
      const base = aligned[i - lb];
      if (base.stockClose > 0 && base.indexClose > 0) {
        trend.push(
          ((curr.stockClose / base.stockClose) / (curr.indexClose / base.indexClose)) - 1
        );
      }
    }
  }

  const latestClose = latest?.stockClose ?? 0;

  // 52-week high from stock closes
  const last252 = aligned.slice(-252);
  const high52W = last252.length > 0 ? Math.max(...last252.map((r) => r.stockClose)) : latestClose;
  const pctFrom52WHigh = high52W > 0 ? ((latestClose - high52W) / high52W) * 100 : 0;

  // RS New High: is current RS the highest in the 20-day trend window?
  const trendPrev = trend.slice(0, -1);
  const isRSNewHigh = trendPrev.length >= 4 && rsRatio >= Math.max(...trendPrev);

  const latestDate = latest?.date ?? '';

  // Trend, moving averages, and volume quality gates
  let sma50: number | undefined;
  let sma200: number | undefined;
  let isAboveSma50 = false;
  let isAboveSma200 = false;
  let isStage2 = false;
  let volume = 0;
  let vol20Avg = 0;
  let volSurge = 1.0;

  if (rawStockRows && rawStockRows.length >= 20) {
    const closes = rawStockRows.map((r) => r.close);
    const n = closes.length;
    const lastRow = rawStockRows[n - 1];
    volume = Number.isFinite(lastRow.volume) ? lastRow.volume : 0;

    if (n >= 50) {
      const sum50 = closes.slice(-50).reduce((a, b) => a + b, 0);
      sma50 = Math.round((sum50 / 50) * 100) / 100;
      isAboveSma50 = latestClose > sma50;
    }
    if (n >= 200) {
      const sum200 = closes.slice(-200).reduce((a, b) => a + b, 0);
      sma200 = Math.round((sum200 / 200) * 100) / 100;
      isAboveSma200 = latestClose > sma200;
    }
    isStage2 = isAboveSma50 && isAboveSma200 && (sma50 !== undefined && sma200 !== undefined && sma50 > sma200) && pctFrom52WHigh >= -25;

    const vols20 = rawStockRows.slice(-20).map((r) => (Number.isFinite(r.volume) ? r.volume : 0));
    vol20Avg = Math.round(vols20.reduce((a, b) => a + b, 0) / 20);
    volSurge = vol20Avg > 0 ? Math.round((volume / vol20Avg) * 10) / 10 : 1.0;
  }

  // Smooth Mansfield RS: relative performance vs 52-week moving average of RS ratio
  let mansfieldRS: number | undefined;
  if (aligned.length >= 20) {
    const rsRatios: number[] = [];
    const startIdx = Math.max(0, aligned.length - 252);
    for (let i = startIdx; i < aligned.length; i++) {
      if (aligned[i].indexClose > 0) {
        rsRatios.push((aligned[i].stockClose / aligned[i].indexClose) * 1000);
      }
    }
    if (rsRatios.length >= 20) {
      const currRatio = rsRatios[rsRatios.length - 1];
      const avgRatio = rsRatios.reduce((a, b) => a + b, 0) / rsRatios.length;
      mansfieldRS = avgRatio > 0 ? Math.round(((currRatio - avgRatio) / avgRatio) * 1000) / 10 : 0;
    }
  }

  return {
    symbol,
    rsRatio,
    rsChange1W,
    priceChange1D: pctChange1D(aligned),
    priceChange1W: pctChangeByDate(aligned, shiftDate(latestDate, 7)),
    priceChange1M: pctChangeByDate(aligned, shiftDate(latestDate, undefined, 1)),
    priceChange3M: pctChangeByDate(aligned, shiftDate(latestDate, undefined, 3)),
    priceChange1Y: pctChangeByDate(aligned, shiftDate(latestDate, undefined, undefined, 1)),
    latestClose,
    latestDate,
    trend,
    high52W,
    pctFrom52WHigh,
    isRSNewHigh,
    sma50,
    sma200,
    isAboveSma50,
    isAboveSma200,
    isStage2,
    volume,
    vol20Avg,
    volSurge,
    mansfieldRS,
  };
}
