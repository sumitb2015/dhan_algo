// Signal Orb context panels: pure functions over the same bars the orb reads. Information only - nothing here feeds the rules
// (lib/signalOrb.ts decides) or an order. No IO, no clock (time is passed in), no React.

import { TIMEFRAMES, closedBars, indicatorSeries, signalSeries, specLabel, type IndicatorSpec, type OrbBar, type Signal, type Timeframe, type Vote } from './signalOrb.ts';

export type Bar1m = { t: number; straddle: number; h?: number; l?: number; vol?: number };

const IST_S = 19_800;
const istDay = (t: number) => Math.floor((t + IST_S) / 86_400);
const istDate = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10);

// ── Multi-timeframe table ────────────────────────────────────────────────────────────────────────────────────────────────

export type MtfCell = { vote: Vote; value: string };
export type MtfRow = { id: string; label: string; cells: MtfCell[] };
export type MtfTable = {
  timeframes: Timeframe[];
  rows: MtfRow[];
  /** The orb's consensus colour on each timeframe (the same rule as the orb: every indicator agrees, else neutral). */
  signals: Signal[];
  bull: number;
  bear: number;
};

/** Cap on the 1-minute bars read per timeframe: enough for the indicators to converge, cheap to recompute once a minute. */
const MTF_SLICE_1M = 20_000;
const MTF_BARS_PER_TF = 3_000;

/**
 * Every chosen indicator's vote and value on every timeframe, from the 1-minute bars (`bars1m` = closed ones; `nowS` closes the
 * buckets as the engine does). One row per indicator, one column per timeframe, plus the orb's colour per timeframe.
 */
export function mtfTable(specs: IndicatorSpec[], bars1m: Bar1m[], nowS: number): MtfTable {
  const perTf = TIMEFRAMES.map(tf => {
    const closed = closedBars(bars1m.slice(-Math.min(MTF_BARS_PER_TF * tf, MTF_SLICE_1M)), tf, nowS);
    const series = specs.map(s => indicatorSeries(s, closed));
    const n = closed.length;
    return {
      cells: series.map(s => (n ? { vote: s.votes[n - 1], value: s.value(n - 1) } : { vote: 0 as Vote, value: '—' })),
      signal: (n && specs.length ? signalSeries(series, n)[n - 1] : 'NEUTRAL') as Signal,
    };
  });
  const signals = perTf.map(p => p.signal);
  return {
    timeframes: [...TIMEFRAMES],
    rows: specs.map((s, k) => ({ id: s.id, label: specLabel(s), cells: perTf.map(p => p.cells[k]) })),
    signals,
    bull: signals.filter(s => s === 'BULL').length,
    bear: signals.filter(s => s === 'BEAR').length,
  };
}

// ── Signal history ───────────────────────────────────────────────────────────────────────────────────────────────────────

export type SignalChange = {
  /** Start of the bar the colour began on. */
  t: number;
  signal: Signal;
  /** That bar's close: where the colour began. */
  price: number;
  /** Closed bars this colour has held (the newest one is still holding). */
  held: number;
  /** Points moved in the colour's favour until the next change (or until now for the newest); null for NEUTRAL. */
  move: number | null;
  /** True for the colour that is on right now. */
  now: boolean;
};

/** The colour changes over `bars` (closed bars of the trading timeframe), newest first. A flip that gave back its points was a whipsaw. */
export function signalChanges(specs: IndicatorSpec[], bars: OrbBar[], limit = 12): SignalChange[] {
  const n = bars.length;
  if (!n || !specs.length) return [];
  const sig = signalSeries(specs.map(s => indicatorSeries(s, bars)), n);
  const starts: number[] = [];
  for (let i = 1; i < n; i++) if (sig[i] !== sig[i - 1]) starts.push(i);
  const out: SignalChange[] = starts.map((i, k) => {
    const end = k + 1 < starts.length ? starts[k + 1] : n - 1;
    const endPrice = k + 1 < starts.length ? bars[end].close : bars[n - 1].close;
    const dir = sig[i] === 'BULL' ? 1 : sig[i] === 'BEAR' ? -1 : 0;
    return {
      t: bars[i].t, signal: sig[i], price: bars[i].close, held: (k + 1 < starts.length ? starts[k + 1] : n) - i,
      move: dir === 0 ? null : (endPrice - bars[i].close) * dir, now: k === starts.length - 1,
    };
  });
  return out.reverse().slice(0, limit);
}

// ── Key levels ───────────────────────────────────────────────────────────────────────────────────────────────────────────

export type KeyLevels = {
  /** IST date of the latest session in the bars (today, or the last trading day on a weekend). */
  day: string;
  prevDay: string | null;
  dayHigh: number;
  dayLow: number;
  /** Session VWAP (hlc3, volume-weighted); null when the session has traded no volume. */
  vwap: number | null;
  prevClose: number | null;
  prevHigh: number | null;
  prevLow: number | null;
};

/** Today's range and VWAP and the previous session's close / high / low, from 1-minute bars (the feed holds several sessions). */
export function keyLevels(bars1m: Bar1m[]): KeyLevels | null {
  const valid = bars1m.filter(b => b.straddle > 0 && Number.isFinite(b.straddle));
  if (!valid.length) return null;
  const d0 = istDay(valid[valid.length - 1].t);
  const hi = (b: Bar1m) => (b.h !== undefined && Number.isFinite(b.h) && b.h >= b.straddle ? b.h : b.straddle);
  const lo = (b: Bar1m) => (b.l !== undefined && Number.isFinite(b.l) && b.l > 0 && b.l <= b.straddle ? b.l : b.straddle);
  let dayHigh = -Infinity, dayLow = Infinity, pv = 0, vv = 0;
  let prevDayNo = -Infinity;
  for (const b of valid) { const d = istDay(b.t); if (d < d0 && d > prevDayNo) prevDayNo = d; }
  let prevHigh = -Infinity, prevLow = Infinity, prevClose: number | null = null;
  for (const b of valid) {
    const d = istDay(b.t);
    if (d === d0) {
      dayHigh = Math.max(dayHigh, hi(b)); dayLow = Math.min(dayLow, lo(b));
      const v = Number.isFinite(b.vol) && (b.vol as number) > 0 ? (b.vol as number) : 0;
      if (v > 0) { pv += ((hi(b) + lo(b) + b.straddle) / 3) * v; vv += v; }
    } else if (d === prevDayNo) {
      prevHigh = Math.max(prevHigh, hi(b)); prevLow = Math.min(prevLow, lo(b)); prevClose = b.straddle;
    }
  }
  return {
    day: istDate(d0), prevDay: Number.isFinite(prevDayNo) ? istDate(prevDayNo) : null,
    dayHigh, dayLow, vwap: vv > 0 ? pv / vv : null,
    prevClose, prevHigh: prevClose === null ? null : prevHigh, prevLow: prevClose === null ? null : prevLow,
  };
}

// ── Market context (information only) ────────────────────────────────────────────────────────────────────────────────────

export type OiPoint = { ts: number; spot: number; ceOI: number; peOI: number };
export type OiSummary = {
  ceOI: number;
  peOI: number;
  /** Put OI / call OI over the strikes read; null when call OI is 0. */
  pcr: number | null;
  /** Change since the first point of the day, in contracts. */
  ceChange: number;
  peChange: number;
};

/** Latest cumulative call / put OI over the strikes read, the put-call ratio, and how each side moved since the first point. */
export function oiSummary(points: OiPoint[]): OiSummary | null {
  if (!points.length) return null;
  const first = points[0], last = points[points.length - 1];
  return {
    ceOI: last.ceOI, peOI: last.peOI, pcr: last.ceOI > 0 ? last.peOI / last.ceOI : null,
    ceChange: last.ceOI - first.ceOI, peChange: last.peOI - first.peOI,
  };
}

/** The OI tool's regime label -> a side. Only a confirmed Bullish / Bearish counts; pending, neutral and warming up are no side. */
export function oiSide(label: string | undefined, confirmed: boolean | undefined): Signal {
  if (!label || !confirmed) return 'NEUTRAL';
  return label.includes('Bullish') ? 'BULL' : label.includes('Bearish') ? 'BEAR' : 'NEUTRAL';
}

/** Does the OI regime back the orb? 'none' when either side has no opinion. */
export function oiAgreement(orb: Signal, oi: Signal): 'agree' | 'conflict' | 'none' {
  if (orb === 'NEUTRAL' || oi === 'NEUTRAL') return 'none';
  return orb === oi ? 'agree' : 'conflict';
}

// ── CPR / pivots against the live price ──────────────────────────────────────────────────────────────────────────────────

/** The latest session's closes in time order, thinned to at most `max` points (always keeping the newest): the price path drawn over the levels. */
export function sessionPath(bars1m: Bar1m[], max = 240): { t: number; c: number }[] {
  const valid = bars1m.filter(b => b.straddle > 0 && Number.isFinite(b.straddle));
  if (!valid.length) return [];
  const d0 = istDay(valid[valid.length - 1].t);
  const day = valid.filter(b => istDay(b.t) === d0).map(b => ({ t: b.t, c: b.straddle }));
  if (day.length <= max) return day;
  const step = day.length / max;
  const out: { t: number; c: number }[] = [];
  for (let i = 0; i < max - 1; i++) out.push(day[Math.floor(i * step)]);
  out.push(day[day.length - 1]);
  return out;
}

export type ZoneLevel = { key: string; label: string; price: number; dist: number };
export type PivotZone = {
  /** The nearest level at or below the price, and the nearest above (null beyond the outermost). */
  below: ZoneLevel | null;
  above: ZoneLevel | null;
  /** Between the CPR's bottom and top. */
  inCpr: boolean;
  /** "Inside the CPR", "Above TC, below R1", "Below S4" ... */
  text: string;
};

/** Where `price` sits among the CPR and R1-R4 / S1-S4 (any level object with p, tc, bc, r1-r4, s1-s4). */
export function pivotZone(price: number, set: { p: number; tc: number; bc: number; r1: number; r2: number; r3: number; r4: number; s1: number; s2: number; s3: number; s4: number }): PivotZone {
  const all: ZoneLevel[] = ([
    ['s4', 'S4', set.s4], ['s3', 'S3', set.s3], ['s2', 'S2', set.s2], ['s1', 'S1', set.s1], ['bc', 'BC', set.bc], ['p', 'P', set.p], ['tc', 'TC', set.tc],
    ['r1', 'R1', set.r1], ['r2', 'R2', set.r2], ['r3', 'R3', set.r3], ['r4', 'R4', set.r4],
  ] as [string, string, number][]).map(([key, label, p]) => ({ key, label, price: p, dist: price - p })).sort((a, b) => a.price - b.price);
  let below: ZoneLevel | null = null, above: ZoneLevel | null = null;
  for (const l of all) { if (l.price <= price) below = l; else { above = l; break; } }
  const inCpr = price >= set.bc && price <= set.tc;
  const text = inCpr ? 'Inside the CPR' : !below ? `Below ${above?.label ?? ''}`.trim() : !above ? `Above ${below.label}` : `${below.label} to ${above.label}`;
  return { below, above, inCpr, text };
}
