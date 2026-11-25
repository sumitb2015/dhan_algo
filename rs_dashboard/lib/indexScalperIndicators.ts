// Indicator catalogue + pure computation for the /index-scalper chart. No React, no chart library: given candles and an
// indicator instance it returns plain series the chart component draws. Maths comes from lib/indicators.ts (never a
// private copy), except VWAP, which has no shared index-safe version.

import { emaSmaSeeded, smaArray, rsiArray, macdSeries, adxDmiArray, supertrendSeries } from './indicators.ts';
import { barAnchorSec, inMarketSession, inOrderSession } from './indexScalperSession.ts';
import type { Underlying } from './indexScalperInstrument.ts';

export interface Bar { t: number; o: number; h: number; l: number; c: number }

export type IndicatorKind = 'ema' | 'sma' | 'vwap' | 'supertrend' | 'bbands' | 'cpr' | 'pivots' | 'rsi' | 'macd' | 'adx';

export interface IndicatorInstance {
  id: string;
  kind: IndicatorKind;
  params: Record<string, number>;
  color: string;
  visible: boolean;
}

export interface ParamDef { key: string; label: string; def: number; min: number; max: number }

export interface CatalogEntry {
  kind: IndicatorKind;
  label: string;
  pane: 'price' | 'sub';
  params: ParamDef[];
  color: string;
}

export const INDICATOR_CATALOG: CatalogEntry[] = [
  { kind: 'ema', label: 'EMA', pane: 'price', color: '#3b82f6', params: [{ key: 'period', label: 'Length', def: 20, min: 1, max: 500 }] },
  { kind: 'sma', label: 'SMA', pane: 'price', color: '#f59e0b', params: [{ key: 'period', label: 'Length', def: 50, min: 1, max: 500 }] },
  { kind: 'vwap', label: 'VWAP (session, hlc3)', pane: 'price', color: '#ec4899', params: [] },
  {
    kind: 'supertrend', label: 'Supertrend', pane: 'price', color: '#22c55e',
    // Factor 2, not 3: Dhan's Supertrend on the same 5-min NIFTY bars reads 25,405.52 on 23 Nov 15:25, which
    // is ATR 10 / factor 2 to 0.002 (factor 3 gives 25,425.08).
    params: [{ key: 'period', label: 'ATR length', def: 10, min: 1, max: 100 }, { key: 'mult', label: 'Factor', def: 2, min: 0.5, max: 20 }],
  },
  {
    kind: 'bbands', label: 'Bollinger Bands', pane: 'price', color: '#a78bfa',
    params: [{ key: 'period', label: 'Length', def: 20, min: 2, max: 200 }, { key: 'mult', label: 'StdDev', def: 2, min: 0.5, max: 10 }],
  },
  // Daily levels from the previous IST day's high / low / close of the chart's own bars (TradingView "Pivot Points
  // Standard", Traditional; the CPR is the same pivot with its BC / TC).
  { kind: 'cpr', label: 'CPR (central pivot range)', pane: 'price', color: '#a855f7', params: [] },
  { kind: 'pivots', label: 'Pivot S / R (S1-S4, R1-R4)', pane: 'price', color: '#f59e0b', params: [{ key: 'levels', label: 'Levels (1-4)', def: 4, min: 1, max: 4 }] },
  { kind: 'rsi', label: 'RSI', pane: 'sub', color: '#8b5cf6', params: [{ key: 'period', label: 'Length', def: 14, min: 2, max: 100 }] },
  {
    kind: 'macd', label: 'MACD', pane: 'sub', color: '#06b6d4',
    params: [{ key: 'fast', label: 'Fast', def: 12, min: 2, max: 100 }, { key: 'slow', label: 'Slow', def: 26, min: 3, max: 200 }, { key: 'signal', label: 'Signal', def: 9, min: 2, max: 100 }],
  },
  { kind: 'adx', label: 'ADX / DMI', pane: 'sub', color: '#eab308', params: [{ key: 'period', label: 'Length', def: 14, min: 2, max: 100 }] },
];

export function catalogEntry(kind: IndicatorKind): CatalogEntry {
  return INDICATOR_CATALOG.find(c => c.kind === kind)!;
}

export function newIndicator(kind: IndicatorKind, id: string): IndicatorInstance {
  const c = catalogEntry(kind);
  const params: Record<string, number> = {};
  for (const p of c.params) params[p.key] = p.def;
  return { id, kind, params, color: c.color, visible: true };
}

export function indicatorLabel(ind: IndicatorInstance): string {
  const c = catalogEntry(ind.kind);
  const ps = c.params.map(p => ind.params[p.key] ?? p.def).join(', ');
  const name = ind.kind === 'vwap' ? 'VWAP' : ind.kind === 'cpr' ? 'CPR' : ind.kind === 'pivots' ? 'Pivots S/R' : c.label;
  return ps ? `${name} (${ps})` : name;
}

/** Clamp a free-typed parameter into its catalogue range; a bad value falls back to the default. */
export function clampParam(kind: IndicatorKind, key: string, raw: number): number {
  const p = catalogEntry(kind).params.find(x => x.key === key);
  if (!p) return raw;
  if (!Number.isFinite(raw)) return p.def;
  return Math.min(p.max, Math.max(p.min, raw));
}

export type SeriesStyle = 'line' | 'histogram' | 'dots';

export interface OutSeries {
  key: string;
  label: string;
  /** Short name shown with the last value on the price scale, Dhan / TradingView style ("EMA(20)", "Supertrend"). */
  axisLabel: string;
  color: string;
  style: SeriesStyle;
  /** One entry per input bar; null = no value (warm-up). */
  values: (number | null)[];
  /** Optional per-bar colour (Supertrend up/down, MACD histogram sign). */
  colors?: (string | null)[];
  /** Fixed horizontal guide lines for oscillators (RSI 30/70). */
  guides?: number[];
  /** breaks[i] = hide the segment from point i to i+1 (a daily level changing at the day boundary). lightweight-charts
   *  joins a line straight across whitespace, so without this every day change draws a slanted jump. */
  breaks?: boolean[];
  /** Line width on the price pane (default 2; daily levels are drawn at 1). */
  lineWidth?: 1 | 2 | 3;
}

export interface IndicatorOutput {
  pane: 'price' | 'sub';
  series: OutSeries[];
}

const UP = '#22c55e';
const DOWN = '#ef4444';

/** IST calendar day of a bar's real UTC epoch (sessions reset VWAP at the IST day change). */
export function istDay(t: number): number {
  return Math.floor((t + 19800) / 86400);
}

/** Session-reset VWAP on hlc3. The NSE index feed carries no volume, so every bar has equal weight: this is the average
 *  typical price of the session, labelled as such (same definition the Renko page uses). */
export function sessionVwap(bars: Bar[]): (number | null)[] {
  const out: (number | null)[] = [];
  let day = -1;
  let sum = 0;
  let n = 0;
  for (const b of bars) {
    const d = istDay(b.t);
    if (d !== day) { day = d; sum = 0; n = 0; }
    sum += (b.h + b.l + b.c) / 3;
    n += 1;
    out.push(sum / n);
  }
  return out;
}

/** Previous-day pivot inputs per bar: the high, low and close of the latest IST day BEFORE the bar's own day that has
 *  bars in the list (a holiday or weekend is skipped, as on a daily chart). null on the first day of the history. */
export function prevDayHlc(bars: Bar[]): ({ h: number; l: number; c: number } | null)[] {
  const out: ({ h: number; l: number; c: number } | null)[] = [];
  let day = -1;
  let cur: { h: number; l: number; c: number } | null = null;
  let prev: { h: number; l: number; c: number } | null = null;
  for (const b of bars) {
    const d = istDay(b.t);
    if (d !== day) { if (cur) prev = cur; cur = { h: b.h, l: b.l, c: b.c }; day = d; }
    else if (cur) { cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c; }
    out.push(prev ? { ...prev } : null);
  }
  return out;
}

/** Floor pivots from one day's H / L / C, TradingView "Traditional": P, the CPR (BC = (H+L)/2, TC = 2P - BC, shown as
 *  the upper / lower of the two), R1-R4 and S1-S4. */
export function pivotLevels(h: number, l: number, c: number) {
  const p = (h + l + c) / 3;
  const bc = (h + l) / 2;
  const tc = 2 * p - bc;
  return {
    p, tc: Math.max(tc, bc), bc: Math.min(tc, bc),
    r1: 2 * p - l, s1: 2 * p - h,
    r2: p + (h - l), s2: p - (h - l),
    r3: 2 * p + (h - 2 * l), s3: 2 * p - (2 * h - l),
    r4: 3 * p + (h - 3 * l), s4: 3 * p - (3 * h - l),
  };
}

/** Day-boundary breaks for daily-level lines: true on the last bar of each IST day that has a next bar. */
export function dayBreaks(bars: Bar[]): boolean[] {
  return bars.map((b, i) => i + 1 < bars.length && istDay(bars[i + 1].t) !== istDay(b.t));
}

export function bollinger(closes: number[], period: number, mult: number): { mid: (number | null)[]; up: (number | null)[]; lo: (number | null)[] } {
  const mid = smaArray(closes, period);
  const up: (number | null)[] = [];
  const lo: (number | null)[] = [];
  for (let i = 0; i < closes.length; i++) {
    const m = mid[i];
    if (m === null || i < period - 1) { up.push(null); lo.push(null); continue; }
    let v = 0;
    for (let k = i - period + 1; k <= i; k++) v += (closes[k] - m) ** 2;
    const sd = Math.sqrt(v / period);
    up.push(m + mult * sd);
    lo.push(m - mult * sd);
  }
  return { mid, up, lo };
}

export function computeIndicator(bars: Bar[], ind: IndicatorInstance): IndicatorOutput {
  const closes = bars.map(b => b.c);
  const p = (k: string) => ind.params[k] ?? catalogEntry(ind.kind).params.find(x => x.key === k)!.def;
  const label = indicatorLabel(ind);
  switch (ind.kind) {
    case 'ema': {
      // TradingView ta.ema (SMA seed, null before `period` bars): the definition Dhan's own charts use.
      const v = emaSmaSeeded(closes, p('period'));
      return { pane: 'price', series: [{ key: 'v', label, axisLabel: `EMA(${p('period')})`, color: ind.color, style: 'line', values: v }] };
    }
    case 'sma':
      return { pane: 'price', series: [{ key: 'v', label, axisLabel: `SMA(${p('period')})`, color: ind.color, style: 'line', values: smaArray(closes, p('period')) }] };
    case 'vwap':
      return { pane: 'price', series: [{ key: 'v', label, axisLabel: 'VWAP', color: ind.color, style: 'line', values: sessionVwap(bars) }] };
    case 'supertrend': {
      // Pine-exact ta.supertrend, as on Dhan's (TradingView) charts. The default path differs where the trailing bands
      // cross in a flat stretch, and NIFTY has one every session: the index is frozen from 15:15 to ~15:28 (closing
      // session), so the default path flipped on a different bar on 18 of 750 5-min bars (lines up to 266 pts apart).
      const st = supertrendSeries(bars.map(b => ({ high: b.h, low: b.l, close: b.c })), p('period'), p('mult'), { pine: true });
      return {
        pane: 'price',
        series: [{
          key: 'v', label, axisLabel: 'Supertrend', color: ind.color, style: 'line',
          values: st.map(s => s.line),
          colors: st.map(s => (s.dir === 1 ? UP : s.dir === -1 ? DOWN : null)),
        }],
      };
    }
    case 'bbands': {
      const bb = bollinger(closes, p('period'), p('mult'));
      return {
        pane: 'price',
        series: [
          { key: 'up', label: `${label} upper`, axisLabel: 'BB upper', color: ind.color, style: 'line', values: bb.up },
          { key: 'mid', label: `${label} basis`, axisLabel: 'BB basis', color: ind.color, style: 'line', values: bb.mid },
          { key: 'lo', label: `${label} lower`, axisLabel: 'BB lower', color: ind.color, style: 'line', values: bb.lo },
        ],
      };
    }
    case 'cpr':
    case 'pivots': {
      const hlc = prevDayHlc(bars);
      const lv = hlc.map(x => (x ? pivotLevels(x.h, x.l, x.c) : null));
      const breaks = dayBreaks(bars);
      const level = (key: keyof ReturnType<typeof pivotLevels>, name: string, color: string): OutSeries => ({
        key, label: `${label} ${name}`, axisLabel: name, color, style: 'line', lineWidth: 1, breaks,
        values: lv.map(x => (x ? x[key] : null)),
      });
      if (ind.kind === 'cpr') {
        return { pane: 'price', series: [level('tc', 'TC', ind.color), level('p', 'P', ind.color), level('bc', 'BC', ind.color)] };
      }
      const n = Math.max(1, Math.min(4, Math.round(p('levels'))));
      const series: OutSeries[] = [level('p', 'P', ind.color)];
      const R = ['r1', 'r2', 'r3', 'r4'] as const;
      const S = ['s1', 's2', 's3', 's4'] as const;
      for (let k = 0; k < n; k++) {
        series.push(level(R[k], R[k].toUpperCase(), DOWN));
        series.push(level(S[k], S[k].toUpperCase(), UP));
      }
      return { pane: 'price', series };
    }
    case 'rsi':
      return { pane: 'sub', series: [{ key: 'v', label, axisLabel: `RSI(${p('period')})`, color: ind.color, style: 'line', values: rsiArray(closes, p('period')), guides: [30, 70] }] };
    case 'macd': {
      const m = macdSeries(closes, p('fast'), p('slow'), p('signal'));
      const warm = p('slow') - 1;
      const hist = m.macdLine.map((x, i) => (i < warm ? null : x - m.signalLine[i]));
      return {
        pane: 'sub',
        series: [
          { key: 'hist', label: `${label} hist`, axisLabel: 'Hist', color: ind.color, style: 'histogram', values: hist, colors: hist.map(h => (h === null ? null : h >= 0 ? UP : DOWN)) },
          { key: 'macd', label: `${label} MACD`, axisLabel: 'MACD', color: ind.color, style: 'line', values: m.macdLine.map((x, i) => (i < warm ? null : x)) },
          { key: 'sig', label: `${label} signal`, axisLabel: 'Signal', color: '#f59e0b', style: 'line', values: m.signalLine.map((x, i) => (i < warm ? null : x)) },
        ],
      };
    }
    case 'adx': {
      const d = adxDmiArray(bars.map(b => b.h), bars.map(b => b.l), closes, p('period'));
      return {
        pane: 'sub',
        series: [
          { key: 'adx', label: `${label} ADX`, axisLabel: 'ADX', color: ind.color, style: 'line', values: d.adx },
          { key: 'pdi', label: '+DI', axisLabel: '+DI', color: UP, style: 'line', values: d.plusDi },
          { key: 'mdi', label: '-DI', axisLabel: '-DI', color: DOWN, style: 'line', values: d.minusDi },
        ],
      };
    }
  }
}

/** Fold a live spot tick into the bar list: update the forming bar, or open a new one when the interval has rolled over
 *  inside the market session (NSE index: 09:15-15:30 IST; an option's premium, `option`: F&O to 15:40; MCX:
 *  09:00-23:30/23:55 IST). Outside the session, or when the tick is not newer than the last bar, the
 *  list comes back unchanged so a frozen after-hours spot never invents candles. Returns the same array when nothing changed. */
export function applyTick(
  bars: Bar[],
  price: number,
  intervalMin: number,
  nowSec: number,
  underlying: Underlying = 'NIFTY',
  option = false,
): Bar[] {
  if (bars.length === 0 || !(price > 0)) return bars;
  if (!(option ? inOrderSession(underlying, nowSec * 1000) : inMarketSession(underlying, nowSec * 1000))) return bars;
  const step = intervalMin * 60;
  const last = bars[bars.length - 1];
  // Buckets anchored to the session open (`barAnchorSec`), so 30 m / 1 h bars start at 09:15 like the history's.
  const anchor = barAnchorSec(underlying);
  const ist = nowSec + 19800;
  const bucket = Math.floor((ist - anchor) / step) * step + anchor - 19800;
  if (bucket < last.t) return bars;
  if (bucket === last.t) {
    if (last.c === price && price <= last.h && price >= last.l) return bars;
    const next = { ...last, c: price, h: Math.max(last.h, price), l: Math.min(last.l, price) };
    return [...bars.slice(0, -1), next];
  }
  return [...bars, { t: bucket, o: price, h: price, l: price, c: price }];
}

const sameBar = (a: Bar | undefined, b: Bar | undefined) =>
  !!a && !!b && a.t === b.t && a.o === b.o && a.h === b.h && a.l === b.l && a.c === b.c;

/** Whether the chart may take its fast path (update the forming bar only) going from what it drew last — `prevN` bars,
 *  the last two of them `drawnTail` — to `bars`. True only when every bar but the forming one is exactly as drawn:
 *  the same list with the last bar moved, or one new bar appended after an unchanged previous bar. A candle refresh that
 *  corrected an earlier bar (a tick-built high/low the API fixed) returns false, so the caller redraws everything. */
export function tailUnchanged(drawnTail: Bar[], prevN: number, bars: Bar[]): boolean {
  const k = drawnTail.length;
  if (k === 0) return false;
  if (bars.length === prevN) {
    if (bars[prevN - 1].t !== drawnTail[k - 1].t) return false;
    return k < 2 || sameBar(drawnTail[k - 2], bars[prevN - 2]);
  }
  if (bars.length === prevN + 1) return sameBar(drawnTail[k - 1], bars[prevN - 1]);
  return false;
}

/** Fold freshly loaded history into the bars the live ticks built. History wins for every bar it has, except that its
 *  last bar, when it is the bucket still forming at `nowSec`, keeps the tick-built high / low / close (the REST snapshot
 *  of a forming bar is older than the ticks). Tick-built bars newer than the history are kept. `live` must be bars of
 *  the same interval. */
export function mergeHistory(history: Bar[], live: Bar[], intervalMin: number, nowSec: number): Bar[] {
  if (history.length === 0) return live;
  const out = history.slice();
  const last = history[history.length - 1];
  const forming = last.t + intervalMin * 60 > nowSec;
  for (const b of live) {
    if (b.t < last.t) continue;
    if (b.t === last.t) {
      if (forming) out[out.length - 1] = { t: last.t, o: last.o, h: Math.max(last.h, b.h), l: Math.min(last.l, b.l), c: b.c };
      continue;
    }
    out.push(b);
  }
  return out;
}

/** Colour of point `i` when an indicator is drawn as ONE chart series. A Supertrend is a single line coloured by
 *  direction; drawing it as one series per colour made each colour's series join its last point to its next across the
 *  other direction's run (lightweight-charts draws a line straight over whitespace), so the bearish line cut diagonally
 *  across bullish stretches. lightweight-charts paints the segment i -> i+1 in point i's colour, so the last bar BEFORE
 *  a flip is transparent: that hides the jump from one band to the other, the gap TradingView leaves at a flip. */
export function pointColor(s: OutSeries, i: number): string | undefined {
  if (s.breaks?.[i]) return 'transparent';
  if (!s.colors) return undefined;
  const c = s.colors[i] ?? s.color;
  if (s.style !== 'line') return c;
  const next = i + 1 < s.colors.length ? s.colors[i + 1] : null;
  return next && s.colors[i] && next !== s.colors[i] ? 'transparent' : c;
}

/** Whether the last bar flips a direction-coloured line: its previous point's colour then depends on the forming bar,
 *  which an update of the last point alone cannot repaint, so the chart must redraw the series. */
export function flipsAtLast(s: OutSeries): boolean {
  const n = s.values.length;
  if (s.style !== 'line' || n < 2) return false;
  // A daily level whose last bar opened a new day: the point before it turned transparent (the day-change gap).
  if (s.breaks?.[n - 2]) return true;
  return !!s.colors && !!s.colors[n - 1] && !!s.colors[n - 2] && s.colors[n - 1] !== s.colors[n - 2];
}

/** Saved indicator lists from before the Supertrend default became factor 2: a Supertrend still on the old untouched
 *  default (10, 3) moves to (10, 2), so the chart matches Dhan's; any other setting the user chose is kept. */
export function migrateIndicatorsV1(saved: IndicatorInstance[]): IndicatorInstance[] {
  return saved.map(i => (i.kind === 'supertrend' && i.params.period === 10 && i.params.mult === 3
    ? { ...i, params: { ...i.params, mult: 2 } } : i));
}
