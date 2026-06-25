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
 * Compute the RS ratio at a single point in time.
 * currentRS = (stockClose[-1] / stockClose[-52w]) / (indexClose[-1] / indexClose[-52w]) - 1
 */
export function computeCurrentRS(
  aligned: Array<{ stockClose: number; indexClose: number }>,
  lookback: number = 252 // dynamic lookback period (50, 100, 252 etc)
): number {
  if (aligned.length <= lookback) return 0;
  const curr = aligned[aligned.length - 1];
  const base = aligned[aligned.length - 1 - lookback];
  if (base.stockClose === 0 || base.indexClose === 0) return 0;
  return ((curr.stockClose / base.stockClose) / (curr.indexClose / base.indexClose)) - 1;
}

/**
 * Compute percentage change between first and last item.
 */
function pctChange(arr: Array<{ stockClose: number }>, n: number): number {
  if (arr.length < 2) return 0;
  const slice = arr.slice(-Math.min(n, arr.length));
  const first = slice[0].stockClose;
  const last = slice[slice.length - 1].stockClose;
  if (first === 0) return 0;
  return ((last - first) / first) * 100;
}

/**
 * 1-day % change, robust to the Dhan API quirk where today's daily OHLCV
 * carries the previous session's settlement price in `close` until EOD
 * processing finishes (~4 PM IST).  Falls back to `open` so the value is
 * meaningful during market hours.
 */
function pctChange1D(arr: Array<{ stockClose: number; stockOpen: number }>): number {
  if (arr.length < 2) return 0;
  const curr = arr[arr.length - 1];
  const prev = arr[arr.length - 2];
  if (prev.stockClose === 0) return 0;

  let currPrice = curr.stockClose;
  if (currPrice === prev.stockClose && curr.stockOpen > 0) {
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
  lookback: number = 252
): Omit<RSResult, 'rsScore' | 'rsRating' | 'rsRank' | 'rsMomentum'> {
  const rsRatio = computeCurrentRS(aligned, lookback);
  const latest = aligned[aligned.length - 1];

  // 1-week RS change (5 trading days)
  const rsRatio1WAgo = computeCurrentRS(
    aligned.slice(0, Math.max(1, aligned.length - 5)),
    lookback
  );
  const rsChange1W = rsRatio - rsRatio1WAgo;

  // Trend: last 20 RS values
  const trend: number[] = [];
  const startIndex = Math.max(lookback, aligned.length - 20);
  for (let i = startIndex; i < aligned.length; i++) {
    const curr = aligned[i];
    const base = aligned[i - lookback];
    if (base.stockClose > 0 && base.indexClose > 0) {
      trend.push(
        ((curr.stockClose / base.stockClose) / (curr.indexClose / base.indexClose)) - 1
      );
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

  return {
    symbol,
    rsRatio,
    rsChange1W,
    priceChange1D: pctChange1D(aligned),
    priceChange1W: pctChange(aligned, 6),
    priceChange1M: pctChange(aligned, 22),
    priceChange3M: pctChange(aligned, 63),
    priceChange1Y: pctChange(aligned, 252),
    latestClose,
    latestDate: latest?.date ?? '',
    trend,
    high52W,
    pctFrom52WHigh,
    isRSNewHigh,
  };
}
