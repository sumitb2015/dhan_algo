// FII/DII activity for /fii-dii: types for debug/fii_dii.json (written by
// scripts/tools/fii_dii_fetch.py) and the pure derivations the page shows. No React, no fetch.

export interface Flow { buy: number; sell: number; net: number }   // Rs crore
export interface CashDay {
  date: string;                                  // YYYY-MM-DD
  combined?: { fii: Flow; dii: Flow };           // NSE + BSE + MSEI (headline)
  nse?: { fii: Flow; dii: Flow };                // NSE only
}

export const PARTICIPANTS = ['FII', 'DII', 'Pro', 'Client'] as const;
export type Participant = typeof PARTICIPANTS[number];

export interface ParticipantRow {
  fut_idx_long: number; fut_idx_short: number; fut_stk_long: number; fut_stk_short: number;
  opt_idx_call_long: number; opt_idx_put_long: number; opt_idx_call_short: number; opt_idx_put_short: number;
  opt_stk_call_long: number; opt_stk_put_long: number; opt_stk_call_short: number; opt_stk_put_short: number;
  total_long: number; total_short: number;
}

export interface StatsRow {
  buy_contracts: number; buy_cr: number; sell_contracts: number; sell_cr: number;
  oi_contracts: number; oi_cr: number;
}
export type StatsKey = 'idx_fut' | 'nifty_fut' | 'banknifty_fut' | 'idx_opt' | 'nifty_opt' | 'banknifty_opt' | 'stk_fut' | 'stk_opt';

export interface FnoDay {
  date: string;
  oi: Record<Participant, ParticipantRow>;
  vol?: Record<Participant, ParticipantRow>;
  fii_stats?: Partial<Record<StatsKey, StatsRow>>;
}

export interface FiiDiiFile {
  fetched_at: string;
  latest_cash: string | null;
  latest_fno: string | null;
  cash: CashDay[];
  fno: FnoDay[];
  errors: string[];
}

export type CashSource = 'combined' | 'nse';

export interface CashPoint { date: string; fii: Flow; dii: Flow; total: number }

/** Days that carry the chosen source, oldest first. */
export function cashSeries(rows: CashDay[], src: CashSource): CashPoint[] {
  return rows
    .filter(r => r[src])
    .map(r => {
      const v = r[src]!;
      return { date: r.date, fii: v.fii, dii: v.dii, total: v.fii.net + v.dii.net };
    });
}

/** Sum of net over the last n points; null when fewer than n exist (a partial sum would mislead). */
export function sumLast(points: CashPoint[], n: number, who: 'fii' | 'dii'): number | null {
  if (points.length < n) return null;
  return points.slice(-n).reduce((s, p) => s + p[who].net, 0);
}

/** Consecutive sessions, counted back from the latest, with the same sign of net. +n buying, -n selling. */
export function streak(points: CashPoint[], who: 'fii' | 'dii'): number {
  let n = 0;
  let sign = 0;
  for (let i = points.length - 1; i >= 0; i--) {
    const s = Math.sign(points[i][who].net);
    if (s === 0) break;
    if (sign === 0) sign = s;
    if (s !== sign) break;
    n++;
  }
  return n * sign;
}

export interface PositionMetrics {
  idxFutLong: number;
  idxFutShort: number;
  idxFutNet: number;
  idxFutLongPct: number | null;   // long / (long + short), 0-100
  stkFutNet: number;
  idxCallNet: number;             // long calls - short calls
  idxPutNet: number;              // long puts - short puts
  stkCallNet: number;
  stkPutNet: number;
}

export function positionMetrics(r: ParticipantRow): PositionMetrics {
  const gross = r.fut_idx_long + r.fut_idx_short;
  return {
    idxFutLong: r.fut_idx_long,
    idxFutShort: r.fut_idx_short,
    idxFutNet: r.fut_idx_long - r.fut_idx_short,
    idxFutLongPct: gross > 0 ? (r.fut_idx_long / gross) * 100 : null,
    stkFutNet: r.fut_stk_long - r.fut_stk_short,
    idxCallNet: r.opt_idx_call_long - r.opt_idx_call_short,
    idxPutNet: r.opt_idx_put_long - r.opt_idx_put_short,
    stkCallNet: r.opt_stk_call_long - r.opt_stk_call_short,
    stkPutNet: r.opt_stk_put_long - r.opt_stk_put_short,
  };
}

export type MetricKey = keyof PositionMetrics;

/** Day-on-day change of every metric; null fields when there is no prior session. */
export function metricChange(cur: PositionMetrics, prev: PositionMetrics | null): Record<MetricKey, number | null> {
  const out = {} as Record<MetricKey, number | null>;
  for (const k of Object.keys(cur) as MetricKey[]) {
    const a = cur[k];
    const b = prev ? prev[k] : null;
    out[k] = a === null || b === null ? null : a - b;
  }
  return out;
}

/** One participant's metrics across all saved sessions, oldest first. */
export function participantHistory(days: FnoDay[], who: Participant): ({ date: string } & PositionMetrics)[] {
  return days.filter(d => d.oi?.[who]).map(d => ({ date: d.date, ...positionMetrics(d.oi[who]) }));
}

/** FII buy - sell in Rs crore for one product; null if the stats file was missing that day. */
export function statsNet(day: FnoDay | undefined, key: StatsKey): number | null {
  const r = day?.fii_stats?.[key];
  return r ? r.buy_cr - r.sell_cr : null;
}

/** Change in FII open interest (contracts) for one product vs the prior session. */
export function statsOiChange(day: FnoDay | undefined, prev: FnoDay | undefined, key: StatsKey): number | null {
  const a = day?.fii_stats?.[key];
  const b = prev?.fii_stats?.[key];
  return a && b ? a.oi_contracts - b.oi_contracts : null;
}

/** Simple sentiment label from FII index-futures long share, the number traders usually quote. */
export function longShortBias(longPct: number | null): { label: string; tone: 'bull' | 'bear' | 'neutral' } {
  if (longPct === null) return { label: '—', tone: 'neutral' };
  if (longPct >= 60) return { label: 'Bullish', tone: 'bull' };
  if (longPct >= 45) return { label: 'Neutral', tone: 'neutral' };
  if (longPct >= 25) return { label: 'Bearish', tone: 'bear' };
  return { label: 'Very bearish', tone: 'bear' };
}

export function fmtCr(v: number | null | undefined, signed = true): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Math.abs(v).toLocaleString('en-IN', { maximumFractionDigits: 2, minimumFractionDigits: 2 });
  return `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}₹${s} Cr`;
}

export function fmtInt(v: number | null | undefined, signed = false): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  const s = Math.abs(Math.round(v)).toLocaleString('en-IN');
  return `${signed && v > 0 ? '+' : v < 0 ? '−' : ''}${s}`;
}
