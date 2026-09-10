import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';

// Market-direction signal for the Margin Allocator's directional strategies
// (Bull Put Spread favors up, Bear Call Spread favors down, Jade
// Lizard/Reverse Jade Lizard lean bullish/bearish). Computed from each
// underlying's own EOD daily candles — EMA20 vs close, plus a standard
// ATR(10)/×3 Supertrend — rather than a live intraday feed, since this only
// needs to bias which credit structure gets ranked higher, not time an entry.
//
// SENSEX gets its own read from Historical Data/Indices/SENSEX.csv (seeded
// via `scripts/downloader/download_indices.py --name SENSEX`, security id
// 51 — verified 2026-08-16 in lib/dhan_helper.py that Dhan serves BSE index
// candles under IDX_I/INDEX same as NSE). If that file is missing or too
// short (freshly deployed, not yet downloaded), `sensex` comes back null and
// callers should fall back to NIFTY's trend — NSE and BSE benchmark indices
// move together on all but the rarest sessions, so that fallback is a
// deliberate, disclosed simplification, not the primary path anymore.
//
// Also computes India VIX Rank/Percentile from Historical Data/Indices/
// INDIA_VIX.csv (~7 years of daily closes, refreshed to within a few days of
// "today"). The scan API's own VIX regime (computeVixRegime in
// ultimateScannerDhan.ts) buckets on the ABSOLUTE VIX level (e.g. "Elevated"
// above 16.5) — a level that means something very different in a structurally
// calm year than a turbulent one. Rank/Percentile answer "high or low
// RELATIVE TO ITS OWN RECENT RANGE," which is the more robust input for
// sizing (see e.g. tastytrade's IV Rank/Percentile research) — used here to
// drive a continuous naked-risk budget tilt instead of 4 discrete buckets.

const NIFTY_CSV_PATH = path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_50_Daily_1Y.csv');
const SENSEX_CSV_PATH = path.join(PROJECT_ROOT, 'Historical Data', 'Indices', 'SENSEX.csv');
const VIX_CSV_PATH = path.join(PROJECT_ROOT, 'Historical Data', 'Indices', 'INDIA_VIX.csv');
const VIX_LOOKBACK_DAYS = 252; // ~1 trading year, the standard IV Rank/Percentile window

export type MarketTrend = 'bullish' | 'bearish' | 'neutral';

export interface UnderlyingTrend {
  asOf: string;
  lastClose: number;
  ema20: number;
  supertrendDir: 1 | -1;
  trend: MarketTrend;
}

export interface MarketTrendResponse {
  success: boolean;
  asOf: string | null;
  lastClose: number | null;
  ema20: number | null;
  supertrendDir: 1 | -1 | null;
  trend: MarketTrend;
  /** SENSEX's own EMA20+Supertrend read from Historical Data/Indices/SENSEX.csv.
   *  Null when that file hasn't been downloaded yet — callers fall back to
   *  the NIFTY fields above for SENSEX in that case (disclosed simplification). */
  sensex: UnderlyingTrend | null;
  /** 0-100: (current - trailing low) / (trailing high - low). Sensitive to a single extreme day. */
  vixRank: number | null;
  /** 0-100: % of the trailing window's days with a lower close than today. More robust than rank. */
  vixPercentile: number | null;
  vixAsOf: string | null;
  error?: string;
}

interface Bar { date: string; high: number; low: number; close: number }

function parseCsv(raw: string): Bar[] {
  const lines = raw.trim().split('\n');
  const header = lines[0].split(',');
  const iDate = header.indexOf('Datetime');
  const iHigh = header.indexOf('High');
  const iLow = header.indexOf('Low');
  const iClose = header.indexOf('Close');
  const bars: Bar[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const close = Number(cols[iClose]);
    const high = Number(cols[iHigh]);
    const low = Number(cols[iLow]);
    if (!Number.isFinite(close) || !Number.isFinite(high) || !Number.isFinite(low)) continue;
    bars.push({ date: cols[iDate], high, low, close });
  }
  return bars;
}

function computeEma(values: number[], period: number): number[] {
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[0] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

/** Standard Supertrend(period, multiplier): Wilder-smoothed ATR bands with the
 * usual flip rule (direction only reverses when close crosses the opposite band). */
function computeSupertrendDir(bars: Bar[], period: number, multiplier: number): (1 | -1)[] {
  const tr: number[] = bars.map((b, i) => {
    if (i === 0) return b.high - b.low;
    const prevClose = bars[i - 1].close;
    return Math.max(b.high - b.low, Math.abs(b.high - prevClose), Math.abs(b.low - prevClose));
  });

  const atr: number[] = [];
  for (let i = 0; i < tr.length; i++) {
    if (i < period) {
      atr.push(tr.slice(0, i + 1).reduce((a, v) => a + v, 0) / (i + 1));
    } else {
      atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
    }
  }

  const finalUpper: number[] = [];
  const finalLower: number[] = [];
  const dir: (1 | -1)[] = [];

  for (let i = 0; i < bars.length; i++) {
    const mid = (bars[i].high + bars[i].low) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];

    if (i === 0) {
      finalUpper.push(basicUpper);
      finalLower.push(basicLower);
      dir.push(1);
      continue;
    }

    const prevClose = bars[i - 1].close;
    finalUpper.push(basicUpper < finalUpper[i - 1] || prevClose > finalUpper[i - 1] ? basicUpper : finalUpper[i - 1]);
    finalLower.push(basicLower > finalLower[i - 1] || prevClose < finalLower[i - 1] ? basicLower : finalLower[i - 1]);

    const prevDir = dir[i - 1];
    if (prevDir === 1) {
      dir.push(bars[i].close < finalLower[i] ? -1 : 1);
    } else {
      dir.push(bars[i].close > finalUpper[i] ? 1 : -1);
    }
  }

  return dir;
}

/** IV Rank (position between trailing high/low) and IV Percentile (% of
 * trailing days strictly below today) over the trailing `lookbackDays`. Both
 * returned since they can diverge — rank is sensitive to a single extreme
 * day, percentile isn't (see file header comment). */
function computeVixRankPercentile(vixCloses: number[], lookbackDays: number): { rank: number; percentile: number } {
  const window = vixCloses.slice(-lookbackDays);
  const today = window[window.length - 1];
  const hi = Math.max(...window);
  const lo = Math.min(...window);
  const rank = hi > lo ? ((today - lo) / (hi - lo)) * 100 : 50;
  const belowToday = window.filter((v) => v < today).length;
  const percentile = (belowToday / window.length) * 100;
  return { rank: Math.round(rank * 10) / 10, percentile: Math.round(percentile * 10) / 10 };
}

/** Shared EMA20+Supertrend read for one underlying's daily CSV. Throws on a
 * missing/too-short file — callers decide whether that's fatal (NIFTY) or
 * gracefully optional (SENSEX). */
function readUnderlyingTrend(csvPath: string): UnderlyingTrend {
  const raw = fs.readFileSync(csvPath, 'utf-8');
  const bars = parseCsv(raw);
  if (bars.length < 25) {
    throw new Error(`only ${bars.length} usable rows in ${path.basename(csvPath)}`);
  }

  const closes = bars.map((b) => b.close);
  const ema20Series = computeEma(closes, 20);
  const supertrendSeries = computeSupertrendDir(bars, 10, 3);

  const last = bars.length - 1;
  const lastClose = closes[last];
  const ema20 = ema20Series[last];
  const supertrendDir = supertrendSeries[last];

  // Require agreement between EMA20-vs-price and Supertrend direction —
  // mixed signals mean the trend is not clean enough to bias a directional
  // trade selection, so 'neutral' (no bias) is the honest answer.
  let trend: MarketTrend = 'neutral';
  if (lastClose > ema20 && supertrendDir === 1) trend = 'bullish';
  else if (lastClose < ema20 && supertrendDir === -1) trend = 'bearish';

  return {
    asOf: bars[last].date,
    lastClose: Math.round(lastClose * 100) / 100,
    ema20: Math.round(ema20 * 100) / 100,
    supertrendDir,
    trend,
  };
}

const CACHE_TTL_MS = 10 * 60_000; // EOD data — refreshes at most once/day
let cache: { ts: number; body: MarketTrendResponse } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  try {
    const nifty = readUnderlyingTrend(NIFTY_CSV_PATH);

    // SENSEX gets its own read when the CSV is available; a separate,
    // optional signal — its file being missing/short should not take down
    // the NIFTY read above (see file header comment for the fallback story).
    let sensex: UnderlyingTrend | null = null;
    try {
      sensex = readUnderlyingTrend(SENSEX_CSV_PATH);
    } catch {
      /* not yet downloaded — MarginAllocator falls back to NIFTY's trend */
    }

    // VIX Rank/Percentile — a separate, optional signal. Its own history file
    // failing to parse should not take down the trend read above.
    let vixRank: number | null = null;
    let vixPercentile: number | null = null;
    let vixAsOf: string | null = null;
    try {
      const vixRaw = fs.readFileSync(VIX_CSV_PATH, 'utf-8');
      const vixBars = parseCsv(vixRaw);
      if (vixBars.length >= 30) {
        const vixCloses = vixBars.map((b) => b.close);
        const { rank, percentile } = computeVixRankPercentile(vixCloses, VIX_LOOKBACK_DAYS);
        vixRank = rank;
        vixPercentile = percentile;
        vixAsOf = vixBars[vixBars.length - 1].date;
      }
    } catch {
      /* VIX rank is an enhancement, not a hard dependency of this route */
    }

    const body: MarketTrendResponse = {
      success: true,
      asOf: nifty.asOf,
      lastClose: nifty.lastClose,
      ema20: nifty.ema20,
      supertrendDir: nifty.supertrendDir,
      trend: nifty.trend,
      sensex,
      vixRank,
      vixPercentile,
      vixAsOf,
    };
    cache = { ts: Date.now(), body };
    return NextResponse.json(body);
  } catch (err) {
    const body: MarketTrendResponse = {
      success: false,
      asOf: null, lastClose: null, ema20: null, supertrendDir: null, trend: 'neutral',
      sensex: null, vixRank: null, vixPercentile: null, vixAsOf: null,
      error: String((err as Error).message ?? err),
    };
    return NextResponse.json(body);
  }
}
