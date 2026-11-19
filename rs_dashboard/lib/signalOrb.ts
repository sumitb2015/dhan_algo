// Signal Orb: pure rules. One colour from every active indicator on CLOSED bars, and what an always-in long/short follower
// does about it. No IO, no clock (time is passed in), no React — the browser engine and the tests call the same functions.
// Spec: strategies/signal_orb/strategy.md.

import { emaSmaSeeded, rsiArray, stochRsiArray, supertrendSeries } from './indicators.ts';

export type Vote = 1 | -1 | 0;
export type Signal = 'BULL' | 'BEAR' | 'NEUTRAL';
export type Side = 'LONG' | 'SHORT';
export type Timeframe = 1 | 3 | 5;

export type IndicatorSpec =
  | { id: string; kind: 'ema'; period: number }
  | { id: string; kind: 'emaCross'; fast: number; slow: number }
  | { id: string; kind: 'supertrend'; period: number; mult: number }
  | { id: string; kind: 'rsi'; period: number; upper: number; lower: number }
  | { id: string; kind: 'stochRsi'; rsiPeriod: number; stochPeriod: number; k: number; d: number; upper: number; lower: number };

export type IndicatorKind = IndicatorSpec['kind'];

/** A closed bar: one close per bucket (the P&F feed is close-only, so Supertrend reads high = low = close). */
export type OrbBar = { t: number; close: number };

export const KIND_LABEL: Record<IndicatorKind, string> = {
  ema: 'EMA', emaCross: 'EMA Cross', supertrend: 'Supertrend', rsi: 'RSI', stochRsi: 'Stoch RSI',
};

export function defaultSpec(kind: IndicatorKind, id: string): IndicatorSpec {
  switch (kind) {
    case 'ema': return { id, kind, period: 9 };
    case 'emaCross': return { id, kind, fast: 9, slow: 21 };
    case 'supertrend': return { id, kind, period: 10, mult: 2 };
    case 'rsi': return { id, kind, period: 14, upper: 55, lower: 45 };
    case 'stochRsi': return { id, kind, rsiPeriod: 14, stochPeriod: 14, k: 3, d: 3, upper: 80, lower: 20 };
  }
}

export const specLabel = (s: IndicatorSpec): string => {
  switch (s.kind) {
    case 'ema': return `EMA ${s.period}`;
    case 'emaCross': return `EMA ${s.fast}/${s.slow}`;
    case 'supertrend': return `ST ${s.period},${s.mult}`;
    case 'rsi': return `RSI ${s.period}`;
    case 'stochRsi': return `StochRSI ${s.rsiPeriod},${s.stochPeriod}`;
  }
};

const int = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
};
const num = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= lo && n <= hi ? n : d;
};
const ID_RE = /^[a-z0-9-]{1,24}$/i;

/** Any stored / sent spec -> a bounded valid spec, or null. */
export function sanitizeSpec(v: unknown): IndicatorSpec | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = typeof o.id === 'string' && ID_RE.test(o.id) ? o.id : null;
  if (!id) return null;
  const kind = o.kind as IndicatorKind;
  if (!(kind in KIND_LABEL)) return null;
  const d = defaultSpec(kind, id);
  switch (d.kind) {
    case 'ema': return { ...d, period: int(o.period, 2, 400, d.period) };
    case 'emaCross': {
      const fast = int(o.fast, 2, 400, d.fast), slow = int(o.slow, 3, 400, d.slow);
      return fast < slow ? { ...d, fast, slow } : d;
    }
    case 'supertrend': return { ...d, period: int(o.period, 2, 200, d.period), mult: num(o.mult, 0.5, 10, d.mult) };
    case 'rsi': {
      const upper = num(o.upper, 50, 95, d.upper), lower = num(o.lower, 5, 50, d.lower);
      return { ...d, period: int(o.period, 2, 100, d.period), upper, lower: Math.min(lower, upper) };
    }
    case 'stochRsi': {
      const upper = num(o.upper, 50, 100, d.upper), lower = num(o.lower, 0, 50, d.lower);
      return { ...d, rsiPeriod: int(o.rsiPeriod, 2, 100, d.rsiPeriod), stochPeriod: int(o.stochPeriod, 2, 100, d.stochPeriod),
        k: int(o.k, 1, 20, d.k), d: int(o.d, 1, 20, d.d), upper, lower: Math.min(lower, upper) };
    }
  }
}

export type IndicatorReading = { id: string; label: string; vote: Vote; value: string };

const fmt = (n: number | null | undefined, dp = 1) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(dp));

/** One indicator's vote on the LAST bar of `bars` (the caller passes closed bars only). 0 = warming up or no opinion. */
export function readIndicator(spec: IndicatorSpec, bars: OrbBar[]): IndicatorReading {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const last = n ? closes[n - 1] : null;
  const label = specLabel(spec);
  const out = (vote: Vote, value: string): IndicatorReading => ({ id: spec.id, label, vote, value });
  if (!n || last === null) return out(0, '—');
  switch (spec.kind) {
    case 'ema': {
      const e = emaSmaSeeded(closes, spec.period)[n - 1];
      if (e === null) return out(0, 'warming');
      return out(last > e ? 1 : last < e ? -1 : 0, fmt(e));
    }
    case 'emaCross': {
      const f = emaSmaSeeded(closes, spec.fast)[n - 1], s = emaSmaSeeded(closes, spec.slow)[n - 1];
      if (f === null || s === null) return out(0, 'warming');
      return out(f > s ? 1 : f < s ? -1 : 0, `${fmt(f)} / ${fmt(s)}`);
    }
    case 'supertrend': {
      const st = supertrendSeries(closes.map(c => ({ high: c, low: c, close: c })), spec.period, spec.mult)[n - 1];
      if (!st || st.dir === null || st.line === null) return out(0, 'warming');
      return out(st.dir === 1 ? 1 : -1, fmt(st.line));
    }
    case 'rsi': {
      const r = rsiArray(closes, spec.period)[n - 1];
      if (r === null) return out(0, 'warming');
      return out(r > spec.upper ? 1 : r < spec.lower ? -1 : 0, fmt(r));
    }
    case 'stochRsi': {
      const s = stochRsiArray(closes, spec.rsiPeriod, spec.stochPeriod, spec.k, spec.d);
      const k = s.k[n - 1], d = s.d[n - 1];
      if (k === null || d === null) return out(0, 'warming');
      const vote: Vote = k > d && k < spec.upper ? 1 : k < d && k > spec.lower ? -1 : 0;
      return out(vote, `${fmt(k)} / ${fmt(d)}`);
    }
  }
}

/** BULL / BEAR only when every active indicator votes the same non-zero way; none active or any 0 = NEUTRAL. */
export function consensus(votes: Vote[]): Signal {
  if (!votes.length) return 'NEUTRAL';
  if (votes.every(v => v === 1)) return 'BULL';
  if (votes.every(v => v === -1)) return 'BEAR';
  return 'NEUTRAL';
}

/** 1-minute bars -> closed `tf`-minute bars at `nowS`. A bucket is closed once nowS >= its end. MCX opens 09:00 IST (03:30 UTC),
 *  which is on both the 3- and 5-minute epoch grid, so buckets are floor(t / (tf*60)). */
export function closedBars(bars1m: { t: number; straddle: number }[], tf: Timeframe, nowS: number): OrbBar[] {
  const size = tf * 60;
  const out: OrbBar[] = [];
  for (const b of bars1m) {
    if (!(b.straddle > 0) || !Number.isFinite(b.straddle)) continue;
    const t = Math.floor(b.t / size) * size;
    if (out.length && out[out.length - 1].t === t) out[out.length - 1].close = b.straddle;
    else out.push({ t, close: b.straddle });
  }
  while (out.length && nowS < out[out.length - 1].t + size) out.pop();
  return out;
}

export type Evaluation = { signal: Signal; barT: number | null; readings: IndicatorReading[]; lastClose: number | null };

export function evaluate(specs: IndicatorSpec[], bars: OrbBar[]): Evaluation {
  const readings = specs.map(s => readIndicator(s, bars));
  const last = bars[bars.length - 1];
  return { signal: consensus(readings.map(r => r.vote)), barT: last ? last.t : null, readings, lastClose: last ? last.close : null };
}

// ── Decision ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OrbTimes = { entryStart: string; entryEnd: string; eodExit: string };
export type DecideInput = {
  signal: Signal;
  /** The newest closed bar the signal was read on. */
  barT: number | null;
  /** The newest bar an entry / reversal was already taken on: one bar never acts twice. */
  watermarkT: number;
  position: { side: Side; entry: number } | null;
  /** Live price for the stop (null = no quote: the stop is not evaluated). */
  price: number | null;
  /** IST minute of day. */
  minute: number;
  times: OrbTimes;
  /** Hard stop in points from entry; 0 = off. */
  stopPts: number;
  /** After a stop-out, the side that may not be re-entered until the colour has changed. */
  blockedSide: Side | null;
};
export type Decision =
  | { action: 'none'; reason: string }
  | { action: 'enter'; side: Side; reason: string }
  | { action: 'reverse'; side: Side; reason: string }
  | { action: 'exit'; reason: string; kind: 'stop' | 'eod' };

export const hhmmToMin = (s: string): number => {
  const m = /^(\d{2}):(\d{2})$/.exec(s);
  return m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
};

export const sideOf = (s: Signal): Side | null => (s === 'BULL' ? 'LONG' : s === 'BEAR' ? 'SHORT' : null);

/** What the follower does now. Exits (cutoff, stop) come before entries and never depend on a fresh bar. */
export function decideOrb(i: DecideInput): Decision {
  const eod = hhmmToMin(i.times.eodExit), start = hhmmToMin(i.times.entryStart), end = hhmmToMin(i.times.entryEnd);
  if (i.position) {
    if (i.minute >= eod) return { action: 'exit', kind: 'eod', reason: `Cutoff ${i.times.eodExit}` };
    if (i.stopPts > 0 && i.price !== null) {
      const adverse = i.position.side === 'LONG' ? i.position.entry - i.price : i.price - i.position.entry;
      if (adverse >= i.stopPts) return { action: 'exit', kind: 'stop', reason: `Stop ${i.stopPts} pts hit (${adverse.toFixed(1)} against)` };
    }
  }
  const want = sideOf(i.signal);
  if (i.barT === null || i.barT <= i.watermarkT) return { action: 'none', reason: 'Waiting for the next closed bar' };
  if (!want) return { action: 'none', reason: i.position ? 'Neutral - holding' : 'Neutral - flat' };
  if (i.position?.side === want) return { action: 'none', reason: `Holding ${want}` };
  if (!(i.minute >= start && i.minute < end)) return { action: 'none', reason: `Outside entry window ${i.times.entryStart}-${i.times.entryEnd}` };
  if (!i.position && i.blockedSide === want) return { action: 'none', reason: `Stopped out of ${want} - waiting for the colour to change` };
  return i.position
    ? { action: 'reverse', side: want, reason: `${i.signal} - reverse ${i.position.side} -> ${want}` }
    : { action: 'enter', side: want, reason: `${i.signal} - enter ${want}` };
}

/** The stop-out block lifts once the colour is anything other than the stopped side. */
export const nextBlock = (blocked: Side | null, signal: Signal): Side | null => (blocked && sideOf(signal) !== blocked ? null : blocked);

/** Rupee P&L of a CRUDEOILM-style futures position: points x barrels per lot x lots. */
export const positionPnl = (side: Side, entry: number, price: number, lots: number, unitsPerLot: number): number =>
  (side === 'LONG' ? price - entry : entry - price) * lots * unitsPerLot;
