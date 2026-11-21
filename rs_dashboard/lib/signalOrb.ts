// Signal Orb: pure rules. One colour from every active indicator on CLOSED bars, and what an always-in long/short follower
// does about it. No IO, no clock (time is passed in), no React — the browser engine and the tests call the same functions.
// Spec: strategies/signal_orb/strategy.md.

import { adxDmiArray, emaSmaSeeded, rsiArray, stochRsiArray, supertrendSeries } from './indicators.ts';
import { VWAP_START, vwapFrom } from './straddlePnf.ts';

/**
 * The page's code version. The server reports its own; a tab whose bundle carries another (an old tab the dev server's hot
 * update never reached) shows a reload banner and its entries are refused (lib/signalOrbServer.ts). Bump on every change to
 * the rules, the indicators or the engine.
 */
export const ORB_CODE_VERSION = '2026-11-21.3';

export type Vote = 1 | -1 | 0;
export type Signal = 'BULL' | 'BEAR' | 'NEUTRAL';
export type Side = 'LONG' | 'SHORT';
export type Timeframe = 1 | 3 | 5 | 15 | 60;
export const TIMEFRAMES: Timeframe[] = [1, 3, 5, 15, 60];

export type IndicatorSpec =
  | { id: string; kind: 'ema'; period: number }
  | { id: string; kind: 'emaCross'; fast: number; slow: number }
  | { id: string; kind: 'supertrend'; period: number; mult: number }
  | { id: string; kind: 'rsi'; period: number; upper: number; lower: number }
  | { id: string; kind: 'stochRsi'; rsiPeriod: number; stochPeriod: number; k: number; d: number; upper: number; lower: number }
  | { id: string; kind: 'adx'; period: number; minAdx: number }
  | { id: string; kind: 'vwap' };

export type IndicatorKind = IndicatorSpec['kind'];

/** A closed bar: the bucket's close and true range (the feed's 1-min `h` / `l`; a bar without them falls back to its close),
 *  and its traded volume (the sum of the 1-min `vol`; 0 when the feed carries none). */
export type OrbBar = { t: number; close: number; high: number; low: number; vol: number };

export const KIND_LABEL: Record<IndicatorKind, string> = {
  ema: 'EMA', emaCross: 'EMA Cross', supertrend: 'Supertrend', rsi: 'RSI', stochRsi: 'Stoch RSI', adx: 'ADX / DMI', vwap: 'VWAP',
};

export function defaultSpec(kind: IndicatorKind, id: string): IndicatorSpec {
  switch (kind) {
    case 'ema': return { id, kind, period: 9 };
    case 'emaCross': return { id, kind, fast: 9, slow: 21 };
    case 'supertrend': return { id, kind, period: 10, mult: 2 };
    case 'rsi': return { id, kind, period: 14, upper: 55, lower: 45 };
    case 'stochRsi': return { id, kind, rsiPeriod: 14, stochPeriod: 14, k: 3, d: 3, upper: 80, lower: 20 };
    case 'adx': return { id, kind, period: 14, minAdx: 20 };
    case 'vwap': return { id, kind };
  }
}

export const specLabel = (s: IndicatorSpec): string => {
  switch (s.kind) {
    case 'ema': return `EMA ${s.period}`;
    case 'emaCross': return `EMA ${s.fast}/${s.slow}`;
    case 'supertrend': return `ST ${s.period},${s.mult}`;
    case 'rsi': return `RSI ${s.period}`;
    case 'stochRsi': return `StochRSI ${s.rsiPeriod},${s.stochPeriod}`;
    case 'adx': return `ADX ${s.period} ≥ ${s.minAdx}`;
    case 'vwap': return 'VWAP';
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
const IST_S = 19_800;

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
    case 'adx': {
      return { ...d, period: int(o.period, 2, 100, d.period), minAdx: num(o.minAdx, 5, 80, d.minAdx) };
    }
    case 'vwap': return d;
  }
}

export type IndicatorReading = { id: string; label: string; vote: Vote; value: string };

const fmt = (n: number | null | undefined, dp = 2) => (n === null || n === undefined || !Number.isFinite(n) ? '—' : n.toFixed(dp));

/** One indicator over every bar: its vote per bar (0 = warming up or no opinion) and the value shown for it. */
export function indicatorSeries(spec: IndicatorSpec, bars: OrbBar[]): { votes: Vote[]; value: (i: number) => string } {
  const closes = bars.map(b => b.close);
  const n = closes.length;
  const votes: Vote[] = new Array(n).fill(0);
  switch (spec.kind) {
    case 'ema': {
      const e = emaSmaSeeded(closes, spec.period);
      for (let i = 0; i < n; i++) { const x = e[i]; if (x !== null) votes[i] = closes[i] > x ? 1 : closes[i] < x ? -1 : 0; }
      return { votes, value: i => (e[i] === null ? 'warming' : fmt(e[i])) };
    }
    case 'emaCross': {
      const f = emaSmaSeeded(closes, spec.fast), s = emaSmaSeeded(closes, spec.slow);
      for (let i = 0; i < n; i++) { const a = f[i], b = s[i]; if (a !== null && b !== null) votes[i] = a > b ? 1 : a < b ? -1 : 0; }
      return { votes, value: i => (f[i] === null || s[i] === null ? 'warming' : `${fmt(f[i])} / ${fmt(s[i])}`) };
    }
    case 'supertrend': {
      // pine: TradingView's exact ta.supertrend (warm-up and the crossed-band flip), so the orb matches the chart
      const st = supertrendSeries(bars, spec.period, spec.mult, { pine: true });
      for (let i = 0; i < n; i++) { const d = st[i]?.dir; if (d === 1 || d === -1) votes[i] = d; }
      return { votes, value: i => (st[i]?.line == null ? 'warming' : fmt(st[i].line)) };
    }
    case 'rsi': {
      const r = rsiArray(closes, spec.period);
      for (let i = 0; i < n; i++) { const x = r[i]; if (x !== null) votes[i] = x > spec.upper ? 1 : x < spec.lower ? -1 : 0; }
      return { votes, value: i => (r[i] === null ? 'warming' : fmt(r[i])) };
    }
    case 'stochRsi': {
      const s = stochRsiArray(closes, spec.rsiPeriod, spec.stochPeriod, spec.k, spec.d);
      for (let i = 0; i < n; i++) {
        const k = s.k[i], d = s.d[i];
        if (k !== null && d !== null) votes[i] = k > d && k < spec.upper ? 1 : k < d && k > spec.lower ? -1 : 0;
      }
      return { votes, value: i => (s.k[i] === null || s.d[i] === null ? 'warming' : `${fmt(s.k[i])} / ${fmt(s.d[i])}`) };
    }
    case 'adx': {
      const highs = bars.map(b => b.high);
      const lows = bars.map(b => b.low);
      const { adx, plusDi, minusDi } = adxDmiArray(highs, lows, closes, spec.period);
      for (let i = 0; i < n; i++) {
        const a = adx[i], p = plusDi[i], m = minusDi[i];
        if (a !== null && p !== null && m !== null) {
          if (a >= spec.minAdx) {
            votes[i] = p > m ? 1 : m > p ? -1 : 0;
          } else {
            votes[i] = 0;
          }
        }
      }
      return {
        votes,
        value: i => {
          const a = adx[i], p = plusDi[i], m = minusDi[i];
          if (a === null || p === null || m === null) return 'warming';
          return `${fmt(a, 1)} (${fmt(p, 0)}/${fmt(m, 0)})`;
        },
      };
    }
    case 'vwap': {
      // TradingView's session VWAP on the chart bars: hlc3, the sums restart on each IST day. A session that has traded no volume
      // yet has no VWAP (vwapFrom would fall back to the mean price): its vote is 0 and the chip says so.
      const vw = vwapFrom(bars.map(b => ({ t: b.t, ce: 0, pe: 0, straddle: b.close, h: b.high, l: b.low, vol: b.vol > 0 ? b.vol : 0 })), 0, VWAP_START, true).series;
      const sessVol: number[] = new Array(n);
      let day = NaN, acc = 0;
      for (let i = 0; i < n; i++) {
        const d = Math.floor((bars[i].t + IST_S) / 86_400);
        if (d !== day) { day = d; acc = 0; }
        acc += bars[i].vol > 0 ? bars[i].vol : 0;
        sessVol[i] = acc;
        const x = vw[i];
        if (acc > 0 && x !== null && x !== undefined) votes[i] = closes[i] > x ? 1 : closes[i] < x ? -1 : 0;
      }
      return { votes, value: i => (!(sessVol[i] > 0) ? 'no volume' : fmt(vw[i])) };
    }
  }
}

/** One indicator's vote on the LAST bar of `bars` (the caller passes closed bars only). */
export function readIndicator(spec: IndicatorSpec, bars: OrbBar[]): IndicatorReading {
  const label = specLabel(spec);
  if (!bars.length) return { id: spec.id, label, vote: 0, value: '—' };
  const s = indicatorSeries(spec, bars);
  const i = bars.length - 1;
  return { id: spec.id, label, vote: s.votes[i], value: s.value(i) };
}

/** BULL / BEAR only when every active indicator votes the same non-zero way; none active or any 0 = NEUTRAL. */
export function consensus(votes: Vote[]): Signal {
  if (!votes.length) return 'NEUTRAL';
  if (votes.every(v => v === 1)) return 'BULL';
  if (votes.every(v => v === -1)) return 'BEAR';
  return 'NEUTRAL';
}

/** 1-minute bars -> closed `tf`-minute bars at `nowS`. A bucket is closed once nowS >= its end. Buckets sit on the IST clock
 *  (floor((t + 5:30) / size)), as TradingView draws MCX: hourly bars start 09:00, 10:00, ... IST. For 1 / 3 / 5 / 15 minutes that
 *  is the same grid as UTC; only the hour needs the offset. */
export function closedBars(bars1m: { t: number; straddle: number; h?: number; l?: number; vol?: number }[], tf: Timeframe, nowS: number): OrbBar[] {
  const size = tf * 60;
  const out: OrbBar[] = [];
  for (const b of bars1m) {
    const c = b.straddle;
    if (!(c > 0) || !Number.isFinite(c)) continue;
    // a range that does not contain the close is not trusted (a stitched or bad row): the close stands in for it
    const ok = b.h !== undefined && b.l !== undefined && Number.isFinite(b.h) && Number.isFinite(b.l) && b.l > 0 && b.l <= c && c <= b.h;
    const hi = ok ? b.h! : c, lo = ok ? b.l! : c;
    const v = Number.isFinite(b.vol) && (b.vol as number) > 0 ? (b.vol as number) : 0;
    const t = Math.floor((b.t + IST_S) / size) * size - IST_S;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) { cur.close = c; cur.high = Math.max(cur.high, hi); cur.low = Math.min(cur.low, lo); cur.vol += v; }
    else out.push({ t, close: c, high: hi, low: lo, vol: v });
  }
  while (out.length && nowS < out[out.length - 1].t + size) out.pop();
  return out;
}

export type Evaluation = {
  signal: Signal; barT: number | null; readings: IndicatorReading[]; lastClose: number | null;
  /** Start time of the bar on which the current colour began (null: no bars, or it has held for the whole window). */
  sinceT: number | null;
};

/** Consensus per bar from each indicator's vote series. */
export function signalSeries(series: { votes: Vote[] }[], n: number): Signal[] {
  const out: Signal[] = new Array(n);
  for (let i = 0; i < n; i++) out[i] = consensus(series.map(s => s.votes[i]));
  return out;
}

export function evaluate(specs: IndicatorSpec[], bars: OrbBar[]): Evaluation {
  const n = bars.length;
  const series = specs.map(s => indicatorSeries(s, bars));
  const readings: IndicatorReading[] = specs.map((s, k) => ({
    id: s.id, label: specLabel(s), vote: n ? series[k].votes[n - 1] : 0, value: n ? series[k].value(n - 1) : '—',
  }));
  const sig = signalSeries(series, n);
  const signal = n ? sig[n - 1] : 'NEUTRAL';
  let j = n - 1;
  while (j > 0 && sig[j - 1] === signal) j--;
  const last = bars[n - 1];
  return { signal, barT: last ? last.t : null, readings, lastClose: last ? last.close : null, sinceT: n && j > 0 ? bars[j].t : null };
}

// ── Replay ─────────────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReplayDay = { day: string; orders: number; points: number };
export type ReplaySummary = {
  sessions: number; ordersPerDay: number; pointsPerDay: number; rupeesPerDay: number; greenDays: number; days: ReplayDay[];
};

/**
 * The follower replayed over closed bars with the SAME decideOrb, one decision per bar at its close: entries, reversals, the
 * stop (checked on the close, so a real stop fills earlier / worse) and the cutoff. Fills are the bar close with no slippage or
 * costs. A rough "how often does this flip and which way does it lean" check, not a backtest.
 */
export function replay(
  specs: IndicatorSpec[],
  bars: OrbBar[],
  cfg: { times: OrbTimes; stopPts: number; lots: number; unitsPerLot: number; trailStartPts?: number; trailGapPts?: number },
  sessions = 20,
): ReplaySummary | null {
  const n = bars.length;
  if (!n || !specs.length) return null;
  const sig = signalSeries(specs.map(s => indicatorSeries(s, bars)), n);
  const days = new Map<string, ReplayDay>();
  let pos: { side: Side; entry: number; bestPrice: number } | null = null;
  let blocked: Side | null = null;
  let watermark = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    const ist = new Date((b.t + 19_800) * 1000);
    const dayKey = ist.toISOString().slice(0, 10);
    const minute = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    let d = days.get(dayKey);
    if (!d) { d = { day: dayKey, orders: 0, points: 0 }; days.set(dayKey, d); }
    blocked = nextBlock(blocked, sig[i]);
    if (pos) {
      pos.bestPrice = pos.side === 'LONG' ? Math.max(pos.bestPrice, b.high) : Math.min(pos.bestPrice, b.low);
    }
    const dec = decideOrb({
      signal: sig[i],
      barT: b.t,
      watermarkT: watermark,
      position: pos,
      price: b.close,
      minute,
      times: cfg.times,
      stopPts: cfg.stopPts,
      trailStartPts: cfg.trailStartPts,
      trailGapPts: cfg.trailGapPts,
      blockedSide: blocked,
    });
    const book = (p: { side: Side; entry: number }) => (p.side === 'LONG' ? b.close - p.entry : p.entry - b.close);
    if (dec.action === 'exit' && pos) {
      d.points += book(pos); d.orders++;
      if (dec.kind === 'stop') blocked = pos.side;
      pos = null;
    } else if (dec.action === 'enter') {
      pos = { side: dec.side, entry: b.close, bestPrice: b.close }; d.orders++; watermark = b.t; blocked = null;
    } else if (dec.action === 'reverse' && pos) {
      d.points += book(pos); d.orders += 2;
      pos = { side: dec.side, entry: b.close, bestPrice: b.close }; watermark = b.t;
    }
  }
  const traded = [...days.values()].filter(d => d.orders > 0).slice(-sessions);
  if (!traded.length) return null;
  const pts = traded.reduce((s, d) => s + d.points, 0);
  return {
    sessions: traded.length,
    ordersPerDay: traded.reduce((s, d) => s + d.orders, 0) / traded.length,
    pointsPerDay: pts / traded.length,
    rupeesPerDay: (pts / traded.length) * cfg.lots * cfg.unitsPerLot,
    greenDays: traded.filter(d => d.points > 0).length,
    days: traded,
  };
}

// ── Decision ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type OrbTimes = { entryStart: string; entryEnd: string; eodExit: string };
export type DecideInput = {
  signal: Signal;
  /** The newest closed bar the signal was read on. */
  barT: number | null;
  /** The newest bar an entry / reversal was already taken on: one bar never acts twice. */
  watermarkT: number;
  position: { side: Side; entry: number; bestPrice?: number } | null;
  /** Live price for the stop (null = no quote: the stop is not evaluated). */
  price: number | null;
  /** IST minute of day. */
  minute: number;
  times: OrbTimes;
  /** Hard stop in points from entry; 0 = off. */
  stopPts: number;
  /** Points gain to trigger trailing stop; 0 = off. */
  trailStartPts?: number;
  /** Points gap behind peak for trailing stop. */
  trailGapPts?: number;
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

export interface EffectiveStopResult {
  stopLevel: number | null;
  isTrailing: boolean;
  peakGain: number;
  trailedPtsFromEntry: number;
}

/**
 * Calculates the current stop level factoring in the hard stop and trailing stop-loss (Lock & Trail).
 * LONG: base stop = entry - stopPts; once peak gain >= trailStartPts, stop trails at (peak - trailGapPts).
 * SHORT: base stop = entry + stopPts; once peak gain >= trailStartPts, stop trails at (peak + trailGapPts).
 * The stop level only ratchets in the trade's favor; it never loosens against the base stop.
 */
export function computeEffectiveStop(params: {
  side: Side;
  entry: number;
  stopPts: number;
  trailStartPts?: number;
  trailGapPts?: number;
  bestPrice?: number | null;
  currentPrice?: number | null;
}): EffectiveStopResult {
  const { side, entry, stopPts, trailStartPts = 0, trailGapPts = 0, bestPrice, currentPrice } = params;
  const baseStop = stopPts > 0 ? (side === 'LONG' ? entry - stopPts : entry + stopPts) : null;

  const peak = side === 'LONG'
    ? Math.max(entry, bestPrice ?? entry, currentPrice ?? entry)
    : Math.min(entry, bestPrice ?? entry, currentPrice ?? entry);

  const peakGain = side === 'LONG' ? peak - entry : entry - peak;

  if (trailStartPts > 0 && trailGapPts > 0 && peakGain >= trailStartPts) {
    if (side === 'LONG') {
      const trailLevel = peak - trailGapPts;
      const stopLevel = baseStop !== null ? Math.max(baseStop, trailLevel) : trailLevel;
      return {
        stopLevel,
        isTrailing: true,
        peakGain,
        trailedPtsFromEntry: stopLevel - entry,
      };
    } else {
      const trailLevel = peak + trailGapPts;
      const stopLevel = baseStop !== null ? Math.min(baseStop, trailLevel) : trailLevel;
      return {
        stopLevel,
        isTrailing: true,
        peakGain,
        trailedPtsFromEntry: entry - stopLevel,
      };
    }
  }

  return {
    stopLevel: baseStop,
    isTrailing: false,
    peakGain: Math.max(0, peakGain),
    trailedPtsFromEntry: baseStop !== null ? -stopPts : 0,
  };
}

/** What the follower does now. Exits (cutoff, stop) come before entries and never depend on a fresh bar. */
export function decideOrb(i: DecideInput): Decision {
  const eod = hhmmToMin(i.times.eodExit), start = hhmmToMin(i.times.entryStart), end = hhmmToMin(i.times.entryEnd);
  if (i.position) {
    if (i.minute >= eod) return { action: 'exit', kind: 'eod', reason: `Cutoff ${i.times.eodExit}` };
    if (i.price !== null) {
      const eff = computeEffectiveStop({
        side: i.position.side,
        entry: i.position.entry,
        stopPts: i.stopPts,
        trailStartPts: i.trailStartPts,
        trailGapPts: i.trailGapPts,
        bestPrice: i.position.bestPrice,
        currentPrice: i.price,
      });
      if (eff.stopLevel !== null) {
        const hit = i.position.side === 'LONG' ? i.price <= eff.stopLevel : i.price >= eff.stopLevel;
        if (hit) {
          const reason = eff.isTrailing
            ? `Trailing stop hit: locked at ${eff.stopLevel.toFixed(1)} (peak +${eff.peakGain.toFixed(1)} pts)`
            : `Stop ${i.stopPts} pts hit (${(i.position.side === 'LONG' ? i.position.entry - i.price : i.price - i.position.entry).toFixed(1)} against)`;
          return { action: 'exit', kind: 'stop', reason };
        }
      }
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

/**
 * Rupee P&L of one Orb row at `mark` (the row's OWN instrument price). A futures row is long / short the future; an options row is
 * always a SOLD option (BULL sold a PE, BEAR sold a CE), so it gains as the premium falls, whatever its `side`.
 */
export const rowPnl = (r: { side: Side; entry: number; lots: number; unitsPerLot: number; target: { kind: string } }, mark: number): number =>
  r.target.kind === 'options' ? (r.entry - mark) * r.lots * r.unitsPerLot : positionPnl(r.side, r.entry, mark, r.lots, r.unitsPerLot);
