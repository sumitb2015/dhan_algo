import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';
import { PROJECT_ROOT } from '@/lib/pyExec';

// Market-direction signal for the Margin Allocator's directional strategies
// (Bull Put Spread favors up, Bear Call Spread favors down, Jade
// Lizard/Reverse Jade Lizard lean bullish/bearish). Computed from NIFTY 50's
// own EOD daily candles — EMA20 vs close, plus a standard ATR(10)/×3
// Supertrend — rather than a live intraday feed, since this only needs to
// bias which credit structure gets ranked higher, not time an entry.
//
// SENSEX has no local daily history cached in this repo (see "Historical
// Data/" — only NIFTY_50 and NIFTY_500 CSVs exist), so its directional bias
// borrows NIFTY's trend read. NSE and BSE benchmark indices move together
// on all but the rarest sessions, so this is a deliberate, disclosed
// simplification rather than fabricating a SENSEX-specific signal from data
// that isn't there.

const CSV_PATH = path.join(PROJECT_ROOT, 'Historical Data', 'NIFTY_50_Daily_1Y.csv');

export type MarketTrend = 'bullish' | 'bearish' | 'neutral';

export interface MarketTrendResponse {
  success: boolean;
  asOf: string | null;
  lastClose: number | null;
  ema20: number | null;
  supertrendDir: 1 | -1 | null;
  trend: MarketTrend;
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

const CACHE_TTL_MS = 10 * 60_000; // EOD data — refreshes at most once/day
let cache: { ts: number; body: MarketTrendResponse } | null = null;

export async function GET() {
  if (cache && Date.now() - cache.ts < CACHE_TTL_MS) {
    return NextResponse.json(cache.body);
  }

  try {
    const raw = fs.readFileSync(CSV_PATH, 'utf-8');
    const bars = parseCsv(raw);
    if (bars.length < 25) {
      throw new Error(`only ${bars.length} usable rows in ${path.basename(CSV_PATH)}`);
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

    const body: MarketTrendResponse = {
      success: true,
      asOf: bars[last].date,
      lastClose: Math.round(lastClose * 100) / 100,
      ema20: Math.round(ema20 * 100) / 100,
      supertrendDir,
      trend,
    };
    cache = { ts: Date.now(), body };
    return NextResponse.json(body);
  } catch (err) {
    const body: MarketTrendResponse = {
      success: false,
      asOf: null, lastClose: null, ema20: null, supertrendDir: null, trend: 'neutral',
      error: String((err as Error).message ?? err),
    };
    return NextResponse.json(body);
  }
}
