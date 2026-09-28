// Factor engine for the Stock Ranking page.
//
// Deliberately separate from /api/movers' MoverResult: that shape uses 0 as a
// "no data" sentinel (a stock listed 3 months ago reports a 1Y change of
// 0.00%, a 60-session stock reports a "52W" high over 60 sessions), which a
// cross-sectional percentile ranking silently treats as a real mid-pack
// reading. Here every factor is either computed over the full lookback it
// claims, or null.

import type { OHLCVRow } from '@/lib/rs';
import { getSector, type Sector } from '@/lib/sectors';

export type FactorId = '1d' | '1w' | '1m' | '3m' | '1y' | 'rsi' | 'hi52' | 'lo52' | 'ma50' | 'ma200' | 'volr';
export type FactorValues = Record<FactorId, number | null>;

export interface CorporateAction {
  date: string;
  gapPct: number;
}

export interface RankingStock {
  symbol: string;
  sector: Sector;
  latestClose: number;
  latestDate: string;
  /** Sessions the factors were computed from (after truncating at a corporate action). */
  sessions: number;
  factors: FactorValues;
  corporateAction: CorporateAction | null;
  volumeSynthetic: boolean;
}

// A gap is treated as a corporate action (split, bonus, demerger) rather than
// a real move only when BOTH hold: the open is ≥30% away from the prior close,
// and the whole day traded outside the prior day's range — nobody traded
// through the gap. A real crash that sells off intraday (open near the prior
// close, then collapses) fails the second test and is kept.
const CA_GAP_RATIO = 0.7;
// Only the most recent ~14 months matter: the longest lookbacks are the 1Y
// return / 52W range (365 days) and the 200DMA (~290 calendar days).
const CA_SCAN_SESSIONS = 300;

const RSI_PERIOD = 14;
const RSI_LOOKBACK = 250;
const VOL_AVG_SESSIONS = 20;
const YEAR_COVERAGE_SLACK_DAYS = 7;

function detectCorporateAction(rows: OHLCVRow[]): { index: number; action: CorporateAction } | null {
  const start = Math.max(1, rows.length - CA_SCAN_SESSIONS);
  for (let i = rows.length - 1; i >= start; i--) {
    const prev = rows[i - 1];
    const curr = rows[i];
    if (prev.close <= 0 || curr.open <= 0 || prev.low <= 0 || curr.high <= 0) continue;
    const ratio = curr.open / prev.close;
    const gapDown = ratio < CA_GAP_RATIO && curr.high < prev.low;
    const gapUp = ratio > 1 / CA_GAP_RATIO && curr.low > prev.high;
    if (gapDown || gapUp) {
      return { index: i, action: { date: curr.date, gapPct: (ratio - 1) * 100 } };
    }
  }
  return null;
}

function shiftDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

function pctChangeSince(rows: OHLCVRow[], days: number): number | null {
  const latest = rows[rows.length - 1];
  const target = shiftDays(latest.date, days);
  for (let i = rows.length - 2; i >= 0; i--) {
    if (rows[i].date <= target) {
      const base = rows[i].close;
      return base > 0 ? ((latest.close - base) / base) * 100 : null;
    }
  }
  return null;
}

// Mirrors /api/movers' pctChg1D so both pages agree on "today": Dhan can
// report the previous settlement as today's close until EOD processing, in
// which case the open (or the range midpoint) stands in for the current price.
function pctChange1D(rows: OHLCVRow[]): number | null {
  if (rows.length < 2) return null;
  const curr = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  if (prev.close <= 0) return null;
  let price = curr.close;
  if (price === prev.close) {
    if (curr.open > 0) price = curr.open;
    else if (curr.high > 0 && curr.low > 0) price = (curr.high + curr.low) / 2;
    else return null;
  }
  return ((price - prev.close) / prev.close) * 100;
}

function wilderRSI(closes: number[]): number | null {
  if (closes.length < RSI_PERIOD + 1) return null;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= RSI_PERIOD; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) avgGain += diff; else avgLoss -= diff;
  }
  avgGain /= RSI_PERIOD;
  avgLoss /= RSI_PERIOD;
  for (let i = RSI_PERIOD + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    avgGain = (avgGain * (RSI_PERIOD - 1) + Math.max(diff, 0)) / RSI_PERIOD;
    avgLoss = (avgLoss * (RSI_PERIOD - 1) + Math.max(-diff, 0)) / RSI_PERIOD;
  }
  if (avgLoss === 0) return avgGain === 0 ? 50 : 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

function pctFromMA(rows: OHLCVRow[], period: number): number | null {
  if (rows.length < period) return null;
  const slice = rows.slice(-period);
  const ma = slice.reduce((s, r) => s + r.close, 0) / period;
  if (ma <= 0) return null;
  return ((rows[rows.length - 1].close - ma) / ma) * 100;
}

function range52W(rows: OHLCVRow[]): { hi52: number | null; lo52: number | null } {
  const latest = rows[rows.length - 1];
  const yearAgo = shiftDays(latest.date, 364);
  // A "52-week" high over a 3-month-old listing is just a 3-month high.
  if (rows[0].date > shiftDays(yearAgo, -YEAR_COVERAGE_SLACK_DAYS)) return { hi52: null, lo52: null };
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = rows.length - 1; i >= 0 && rows[i].date >= yearAgo; i--) {
    if (rows[i].high > 0) hi = Math.max(hi, rows[i].high);
    if (rows[i].low > 0) lo = Math.min(lo, rows[i].low);
  }
  return {
    hi52: Number.isFinite(hi) ? ((latest.close - hi) / hi) * 100 : null,
    lo52: Number.isFinite(lo) ? ((latest.close - lo) / lo) * 100 : null,
  };
}

function volumeRatio(rows: OHLCVRow[], todayIST: string): { ratio: number | null; synthetic: boolean } {
  const latest = rows[rows.length - 1];
  const prev = rows[rows.length - 2];
  // lib/dataLoader copies the previous session's volume into a live-patched
  // row when the quote feed reports none — a ratio off that is meaningless.
  const synthetic = !!prev && latest.date === todayIST && latest.volume === prev.volume;
  if (synthetic || latest.volume <= 0 || rows.length < VOL_AVG_SESSIONS + 1) return { ratio: null, synthetic };
  // Average the 20 sessions *before* today, so today's bar doesn't dilute its own baseline.
  const base = rows.slice(-VOL_AVG_SESSIONS - 1, -1);
  const avg = base.reduce((s, r) => s + r.volume, 0) / base.length;
  return { ratio: avg > 0 ? latest.volume / avg : null, synthetic };
}

export function computeRankingStock(symbol: string, rawRows: OHLCVRow[], todayIST: string): RankingStock | null {
  // Holiday placeholder rows are already dropped by lib/dataLoader.
  const sessions = rawRows.filter(r => r.close > 0);
  if (sessions.length < 2) return null;

  const ca = detectCorporateAction(sessions);
  // Price history before a split/demerger is on a different basis; treat the
  // action date as a fresh listing so every lookback that would span it
  // becomes null instead of reporting a phantom -60%.
  const rows = ca ? sessions.slice(ca.index) : sessions;
  const latest = rows[rows.length - 1];
  const { hi52, lo52 } = rows.length >= 2 ? range52W(rows) : { hi52: null, lo52: null };
  const vol = rows.length >= 2 ? volumeRatio(rows, todayIST) : { ratio: null, synthetic: false };

  return {
    symbol,
    sector: getSector(symbol),
    latestClose: latest.close,
    latestDate: latest.date,
    sessions: rows.length,
    factors: {
      '1d': pctChange1D(rows),
      '1w': rows.length >= 2 ? pctChangeSince(rows, 7) : null,
      '1m': rows.length >= 2 ? pctChangeSince(rows, 29) : null,
      '3m': rows.length >= 2 ? pctChangeSince(rows, 91) : null,
      '1y': rows.length >= 2 ? pctChangeSince(rows, 364) : null,
      rsi: wilderRSI(rows.slice(-RSI_LOOKBACK).map(r => r.close)),
      hi52,
      lo52,
      ma50: pctFromMA(rows, 50),
      ma200: pctFromMA(rows, 200),
      volr: vol.ratio,
    },
    corporateAction: ca?.action ?? null,
    volumeSynthetic: vol.synthetic,
  };
}

/** The session most stocks last traded — robust to one file carrying a bad or far-future date, unlike the max. */
export function modalDate(dates: string[]): string {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(d, (counts.get(d) ?? 0) + 1);
  let best = '';
  let bestCount = 0;
  for (const [d, c] of counts) {
    if (c > bestCount || (c === bestCount && d > best)) { best = d; bestCount = c; }
  }
  return best;
}
