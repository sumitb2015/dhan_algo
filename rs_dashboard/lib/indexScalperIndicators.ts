// Indicator catalogue + pure computation for the /index-scalper chart. No React, no chart library: given candles and an
// indicator instance it returns plain series the chart component draws. Maths comes from lib/indicators.ts (never a
// private copy), except VWAP, which has no shared index-safe version.

import { emaSmaSeeded, smaArray, rsiArray, stochRsiArray, macdSeries, adxDmiArray, supertrendSeries } from './indicators.ts';
import { barAnchorSec, inMarketSession, inOrderSession } from './indexScalperSession.ts';
import { marketStructure } from './indexScalperStructure.ts';
import { cmf, hasVolume, mfi, obv, relativeVolume, vwapWithStdev, vwma } from './volumeIndicators.ts';
import type { Underlying } from './indexScalperInstrument.ts';

/** `v` = traded volume in the bar, when the instrument has one (a future, an option); an index has none. */
/** `oi`: open interest at the bar's end (futures, when asked for: the candles route's oi=1 and the live future's OI). */
export interface Bar { t: number; o: number; h: number; l: number; c: number; v?: number; oi?: number }

export type IndicatorKind = 'volume' | 'ema' | 'emacross' | 'sma' | 'vwap' | 'supertrend' | 'bbands' | 'cpr' | 'pivots' | 'daylevels' | 'rsi' | 'stochrsi' | 'macd' | 'adx' | 'structure'
  | 'vwapbands' | 'obv' | 'mfi' | 'cmf' | 'vwma' | 'rvol';

export interface IndicatorInstance {
  id: string;
  kind: IndicatorKind;
  params: Record<string, number>;
  color: string;
  visible: boolean;
  /** Line width chosen in the indicator's settings (1-4 px) for all its lines; absent = each line's own default. */
  width?: number;
  /** Per-line overrides by series key (Day H/L: dh, dl, pdh, pdl). Each field absent = the indicator-wide setting. */
  lines?: Record<string, LineOverride>;
}

export interface LineOverride {
  /** false hides that one line (and its shadow); absent = shown. */
  visible?: boolean;
  color?: string;
  width?: number;
}

/** Day H/L's lines, in the order its settings list them. */
export const DAY_LEVEL_LINES = [
  { key: 'dh', name: 'DH', hint: 'Day high' },
  { key: 'dl', name: 'DL', hint: 'Day low' },
  { key: 'pdh', name: 'PDH', hint: "Previous day's high" },
  { key: 'pdl', name: 'PDL', hint: "Previous day's low" },
] as const;

/** A Day H/L line's colour before any override: PDH / PDL amber, DH / DL the indicator's colour. */
export function dayLevelBaseColor(ind: IndicatorInstance, key: string): string {
  return key === 'pdh' || key === 'pdl' ? PREV_DAY_LEVEL : ind.color;
}

/** The colour / width / visibility a Day H/L line is drawn with (its override, else the indicator's settings). */
export function dayLevelStyle(ind: IndicatorInstance, key: string): { visible: boolean; color: string; width: LineWidth | null } {
  const o = ind.lines?.[key];
  return {
    visible: o?.visible !== false,
    color: typeof o?.color === 'string' && /^#[0-9a-f]{6}$/i.test(o.color) ? o.color : dayLevelBaseColor(ind, key),
    width: validWidth(o?.width) ?? validWidth(ind.width),
  };
}

export const LINE_WIDTHS = [1, 2, 3, 4] as const;
export type LineWidth = (typeof LINE_WIDTHS)[number];
/** A saved width if it is one of LINE_WIDTHS, else null (default widths). */
export const validWidth = (w: unknown): LineWidth | null => (LINE_WIDTHS as readonly unknown[]).includes(w) ? (w as LineWidth) : null;

/** `toggle`: an on / off setting stored as 1 / 0 (min 0, max 1), shown as a checkbox. */
export interface ParamDef { key: string; label: string; def: number; min: number; max: number; toggle?: boolean }

export interface CatalogEntry {
  kind: IndicatorKind;
  label: string;
  pane: 'price' | 'sub';
  params: ParamDef[];
  color: string;
  /** Drawn in fixed colours (Volume: green / red bars): its settings offer no colour or line width. */
  fixedStyle?: boolean;
  /** Built from traded volume: draws nothing on a chart without it (the NSE / BSE index). The picker says so. */
  needsVolume?: boolean;
}

export const INDICATOR_CATALOG: CatalogEntry[] = [
  // Volume bars along the bottom of the price pane (drawn by the chart itself: futures and options only, the index has
  // no volume). An indicator so it can be hidden or removed like any other.
  // `ma`: a simple moving average of the volume over that many bars (TradingView's Volume MA, 20); 0 hides it.
  { kind: 'volume', label: 'Volume', pane: 'price', color: '#64748b', params: [{ key: 'ma', label: 'MA length (0 = off)', def: 20, min: 0, max: 200 }], fixedStyle: true },
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
  // PDH / PDL = the previous IST day's high / low (same day as the pivots use); DH / DL = each day's high / low as a flat
  // line across that day (today's: the extremes so far, the whole line moving out on a new high / low).
  { kind: 'daylevels', label: 'Day High / Low (PDH, PDL, DH, DL)', pane: 'price', color: '#0ea5e9', params: [] },
  // Two EMAs (TradingView ta.ema) with a small circle where they cross: green when the fast crosses above, red below.
  {
    kind: 'emacross', label: 'EMA Cross', pane: 'price', color: '#22d3ee',
    params: [{ key: 'fast', label: 'Fast EMA', def: 9, min: 2, max: 200 }, { key: 'slow', label: 'Slow EMA', def: 20, min: 3, max: 400 }],
  },
  { kind: 'rsi', label: 'RSI', pane: 'sub', color: '#8b5cf6', params: [{ key: 'period', label: 'Length', def: 14, min: 2, max: 100 }] },
  // TradingView "Stoch RSI" defaults and order: K 3, D 3, RSI length 14, Stochastic length 14 (lib/indicators.ts stochRsiArray).
  {
    kind: 'stochrsi', label: 'Stochastic RSI', pane: 'sub', color: '#3b82f6',
    params: [
      { key: 'k', label: 'K', def: 3, min: 1, max: 50 }, { key: 'd', label: 'D', def: 3, min: 1, max: 50 },
      { key: 'rsi', label: 'RSI length', def: 14, min: 2, max: 100 }, { key: 'stoch', label: 'Stochastic length', def: 14, min: 2, max: 100 },
    ],
  },
  {
    kind: 'macd', label: 'MACD', pane: 'sub', color: '#06b6d4',
    params: [{ key: 'fast', label: 'Fast', def: 12, min: 2, max: 100 }, { key: 'slow', label: 'Slow', def: 26, min: 3, max: 200 }, { key: 'signal', label: 'Signal', def: 9, min: 2, max: 100 }],
  },
  { kind: 'adx', label: 'ADX / DMI', pane: 'sub', color: '#eab308', params: [{ key: 'period', label: 'Length', def: 14, min: 2, max: 100 }] },
  // Swing highs / lows labelled HH, LH, HL, LL (lib/indexScalperStructure.ts), optionally joined by a thin line. A swing
  // shows `len` bars after it printed (the pivot's confirmation lag).
  {
    kind: 'structure', label: 'Market structure (HH / HL / LH / LL)', pane: 'price', color: '#94a3b8',
    params: [
      { key: 'len', label: 'Swing length (bars each side)', def: 3, min: 1, max: 20 },
      { key: 'line', label: 'Line joining the swings', def: 1, min: 0, max: 1, toggle: true },
    ],
  },
  // ── Volume indicators (lib/volumeIndicators.ts, each as its Pine built-in) ──
  // Session VWAP with TradingView's standard-deviation bands (± mult × stdev of hlc3 around the VWAP); a multiplier of 0
  // hides that band. Equal-weighted on the index, like the plain VWAP.
  {
    kind: 'vwapbands', label: 'VWAP bands (± std dev)', pane: 'price', color: '#ec4899',
    params: [
      { key: 'm1', label: 'Band 1 × std dev (0 = off)', def: 1, min: 0, max: 5 },
      { key: 'm2', label: 'Band 2 × std dev (0 = off)', def: 2, min: 0, max: 5 },
      { key: 'm3', label: 'Band 3 × std dev (0 = off)', def: 0, min: 0, max: 5 },
    ],
  },
  { kind: 'vwma', label: 'VWMA (volume-weighted MA)', pane: 'price', color: '#84cc16', needsVolume: true, params: [{ key: 'period', label: 'Length', def: 20, min: 1, max: 500 }] },
  { kind: 'obv', label: 'On-Balance Volume (OBV)', pane: 'sub', color: '#0ea5e9', needsVolume: true, params: [{ key: 'ma', label: 'SMA length (0 = off)', def: 0, min: 0, max: 200 }] },
  { kind: 'mfi', label: 'Money Flow Index (MFI)', pane: 'sub', color: '#f97316', needsVolume: true, params: [{ key: 'period', label: 'Length', def: 14, min: 2, max: 100 }] },
  { kind: 'cmf', label: 'Chaikin Money Flow (CMF)', pane: 'sub', color: '#14b8a6', needsVolume: true, params: [{ key: 'period', label: 'Length', def: 20, min: 2, max: 200 }] },
  // Bar volume ÷ the average at the same time of day over the previous N sessions (daily / weekly bars: the previous N
  // bars). Bars at or above `hi` are highlighted.
  {
    kind: 'rvol', label: 'Relative volume (at time of day)', pane: 'sub', color: '#64748b', needsVolume: true,
    params: [{ key: 'days', label: 'Sessions to average', def: 10, min: 1, max: 60 }, { key: 'hi', label: 'Highlight at or above (×)', def: 2, min: 1, max: 20 }],
  },
];

/** Pine `ta.crossover` / `ta.crossunder` of `a` over `b`: bar i is a cross up when a > b now and a <= b on the bar
 *  before (down: a < b now, a >= b before). Bars where either value is missing are skipped. */
export function crosses(a: (number | null)[], b: (number | null)[]): { i: number; up: boolean }[] {
  const out: { i: number; up: boolean }[] = [];
  for (let i = 1; i < a.length; i++) {
    const a0 = a[i - 1], b0 = b[i - 1], a1 = a[i], b1 = b[i];
    if (a0 === null || b0 === null || a1 === null || b1 === null) continue;
    if (a1 > b1 && a0 <= b0) out.push({ i, up: true });
    else if (a1 < b1 && a0 >= b0) out.push({ i, up: false });
  }
  return out;
}

/** Simple moving average of the bars' volume over `len` bars (null until `len` bars; a bar without volume counts 0).
 *  `len` 0 = off (all null). */
export function volumeMa(bars: Bar[], len: number): (number | null)[] {
  if (!(len >= 1)) return bars.map(() => null);
  return smaArray(bars.map(b => b.v ?? 0), Math.floor(len));
}

/** The list with a Volume indicator added once (it became an indicator on 2026-11-25; saved lists from before lack it).
 *  `visible` carries the old scale-bar "vol" switch. A list that has one is returned unchanged. */
export function withVolume(list: IndicatorInstance[], id: string, visible = true): IndicatorInstance[] {
  if (list.some(i => i.kind === 'volume')) return list;
  return [...list, { ...newIndicator('volume', id), visible }];
}

/** The Market structure indicator's "line joining the swings" (1 on / 0 off) on every structure indicator in the list,
 *  from the trend strip's settings. Returns the same list when nothing changes. */
export function withStructureLine(list: IndicatorInstance[], on: boolean): IndicatorInstance[] {
  const v = on ? 1 : 0;
  if (!list.some(i => i.kind === 'structure' && (i.params.line ?? 1) !== v)) return list;
  return list.map(i => (i.kind === 'structure' ? { ...i, params: { ...i.params, line: v } } : i));
}

/** The chart's Market structure labels, driven by the trend strip's "Market structure" switch (one switch for the strip
 *  light AND the chart labels). On: un-hide the structure indicator(s), or add one when there is none. Off: hide them,
 *  keeping their swing length. Returns the same list when nothing changes. */
export function withStructure(list: IndicatorInstance[], on: boolean, id: string): IndicatorInstance[] {
  const has = list.some(i => i.kind === 'structure');
  if (on && !has) return [...list, newIndicator('structure', id)];
  if (!list.some(i => i.kind === 'structure' && i.visible !== on)) return list;
  return list.map(i => (i.kind === 'structure' ? { ...i, visible: on } : i));
}

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
  // On / off settings are not numbers to show ("Structure (3)", not "(3, 1)").
  const ps = c.params.filter(p => !p.toggle).map(p => ind.params[p.key] ?? p.def).join(', ');
  const name = ind.kind === 'vwap' ? 'VWAP' : ind.kind === 'cpr' ? 'CPR' : ind.kind === 'pivots' ? 'Pivots S/R' : ind.kind === 'daylevels' ? 'Day H/L' : ind.kind === 'structure' ? 'Structure'
    : ind.kind === 'vwapbands' ? 'VWAP bands' : ind.kind === 'vwma' ? 'VWMA' : ind.kind === 'obv' ? 'OBV' : ind.kind === 'mfi' ? 'MFI'
    : ind.kind === 'cmf' ? 'CMF' : ind.kind === 'rvol' ? 'RVOL' : c.label;
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
  /** Line width on the price pane (default 2; daily levels are drawn at 1). A shadow series is wider than 4. */
  lineWidth?: number;
  /** A soft shadow under the line after it (wider, faint copy): no price-scale label, no title. */
  shadow?: boolean;
  /** A level drawn flat across the forming day (DH / DL): a new value repaints the whole series, not just the last point. */
  flat?: boolean;
  /** Small circles drawn on this line at bar `i` (EMA crosses), at `price`, in `color`. Optional `text`, `shape` and
   *  `position` (default: a circle at `price`); market structure labels its swings and breaks with them. */
  markers?: {
    i: number; price: number; color: string; up: boolean;
    text?: string; shape?: 'circle' | 'arrowUp' | 'arrowDown' | 'square';
    position?: 'atPriceMiddle' | 'atPriceTop' | 'atPriceBottom' | 'aboveBar' | 'belowBar'; size?: number;
  }[];
  /** No name / last value on the price scale (the structure zig-zag's last point is a past swing, not a level now). */
  noLabel?: boolean;
}

export interface IndicatorOutput {
  pane: 'price' | 'sub';
  series: OutSeries[];
}

const UP = '#22c55e';
const DOWN = '#ef4444';
/** PDH / PDL: amber, so previous-day levels are not read as the green / red buy-sell colours. */
const PREV_DAY_LEVEL = '#f59e0b';

/** IST calendar day of a bar's real UTC epoch (sessions reset VWAP at the IST day change). */
export function istDay(t: number): number {
  return Math.floor((t + 19800) / 86400);
}

/** Session-reset VWAP on hlc3 (TradingView `ta.vwap(hlc3)`). Weighted by each bar's volume when the session's bars
 *  carry one (a future, an option: matches Dhan's / TradingView's chart); the NSE index has no volume, so there every bar
 *  has equal weight and this is the session's average typical price (same as the Renko page). Weighting the crude future
 *  equally put its VWAP ~10 points off Dhan's (7503.01 vs 7513.11 on 2026-11-25). */
export function sessionVwap(bars: Bar[]): (number | null)[] {
  const out: (number | null)[] = [];
  let day = -1;
  let sum = 0;
  let n = 0;
  let pv = 0;
  let vol = 0;
  for (const b of bars) {
    const d = istDay(b.t);
    if (d !== day) { day = d; sum = 0; n = 0; pv = 0; vol = 0; }
    const tp = (b.h + b.l + b.c) / 3;
    sum += tp;
    n += 1;
    const v = b.v !== undefined && Number.isFinite(b.v) && b.v > 0 ? b.v : 0;
    pv += tp * v;
    vol += v;
    // Volume-weighted once the session has any volume; before that (or for the index) the equal-weight average.
    out.push(vol > 0 ? pv / vol : sum / n);
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

/** Each bar's own IST day high / low: the highest high and lowest low of all of that day's bars, so DH / DL draw as
 *  flat lines across the day. Today's are the extremes so far and move out when the day makes a new high / low. */
export function dayHl(bars: Bar[]): { h: number; l: number }[] {
  const byDay = new Map<number, { h: number; l: number }>();
  for (const b of bars) {
    const d = istDay(b.t);
    const x = byDay.get(d);
    if (!x) byDay.set(d, { h: b.h, l: b.l });
    else { x.h = Math.max(x.h, b.h); x.l = Math.min(x.l, b.l); }
  }
  return bars.map(b => ({ ...byDay.get(istDay(b.t))! }));
}

/** Day-boundary breaks for daily-level lines: true on the last bar of each IST day that has a next bar. */
export function dayBreaks(bars: Bar[]): boolean[] {
  return bars.map((b, i) => i + 1 < bars.length && istDay(bars[i + 1].t) !== istDay(b.t));
}

/** Bollinger basis colour (TradingView's default orange); the bands take the indicator's own colour. */
const BB_BASIS = '#f97316';
/** EMA Cross: the slow EMA's colour (the fast one takes the indicator's own). */
const EMA_CROSS_SLOW = '#f59e0b';

/** TradingView `ta.bb`: basis = SMA(close, period); bands = basis +/- mult x the POPULATION standard deviation (divides by
 *  N, as Pine's `ta.stdev`). Matches a pandas population-stdev reference to 1e-9 on 5,772 NIFTY points (2026-11-25);
 *  pandas_ta's `bbands` divides by N - 1 and draws slightly wider bands, so it is not the reference. */
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

/** The indicator's series, with its user-chosen line width (if any) applied to every line (never to a histogram). */
export function computeIndicator(bars: Bar[], ind: IndicatorInstance): IndicatorOutput {
  let out = computeSeries(bars, ind);
  const w = validWidth(ind.width);
  if (w !== null) out = { ...out, series: out.series.map(s => (s.style === 'histogram' ? s : { ...s, lineWidth: w })) };
  // Day High / Low: each line's own colour / width / visibility (DH, DL, PDH, PDL set one by one), then a light shadow
  // under each shown level so it stands out from the candles and other lines.
  if (ind.kind === 'daylevels') {
    const series = out.series.flatMap(s => {
      const st = dayLevelStyle(ind, s.key);
      if (!st.visible) return [];
      return [{ ...s, color: st.color, ...(st.width !== null ? { lineWidth: st.width } : {}) }];
    });
    out = { ...out, series: series.flatMap(s => [shadowOf(s), s]) };
  }
  return out;
}

/** Shadow alpha and extra width (px) of a level's shadow line. */
const SHADOW_ALPHA = 0.22;
const SHADOW_EXTRA = 4;

/** '#rrggbb' -> 'rgba(r, g, b, a)'; any other form is returned unchanged. */
export function withAlpha(hex: string, a: number): string {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

/** A wider, faint copy of a line, drawn before (under) it. Same values and day breaks, no label. */
export function shadowOf(s: OutSeries): OutSeries {
  return {
    key: `${s.key}:shadow`, label: `${s.label} shadow`, axisLabel: '', style: 'line', shadow: true,
    color: withAlpha(s.color, SHADOW_ALPHA), lineWidth: (s.lineWidth ?? 1) + SHADOW_EXTRA, values: s.values, breaks: s.breaks, ...(s.flat ? { flat: true } : {}),
  };
}

/** The volume indicators' series, for bars that carry volume (computeSeries returns nothing without it). */
function volumeSeries(bars: Bar[], ind: IndicatorInstance, label: string, p: (k: string) => number): IndicatorOutput {
  switch (ind.kind) {
    case 'vwma':
      return { pane: 'price', series: [{ key: 'v', label, axisLabel: `VWMA(${p('period')})`, color: ind.color, style: 'line', values: vwma(bars, p('period')) }] };
    case 'obv': {
      const o = obv(bars);
      const series: OutSeries[] = [{ key: 'v', label, axisLabel: 'OBV', color: ind.color, style: 'line', values: o }];
      const ma = Math.floor(p('ma'));
      if (ma >= 1 && o.some(x => x !== null)) {
        series.push({ key: 'ma', label: `${label} SMA`, axisLabel: `SMA(${ma})`, color: '#f59e0b', style: 'line', values: smaArray(o.map(x => x ?? 0), ma) });
      }
      return { pane: 'sub', series };
    }
    case 'mfi':
      return { pane: 'sub', series: [{ key: 'v', label, axisLabel: `MFI(${p('period')})`, color: ind.color, style: 'line', values: mfi(bars, p('period')), guides: [20, 80] }] };
    case 'cmf':
      return { pane: 'sub', series: [{ key: 'v', label, axisLabel: `CMF(${p('period')})`, color: ind.color, style: 'line', values: cmf(bars, p('period')), guides: [0] }] };
    case 'rvol': {
      // Histogram: amber at or above the highlight, the indicator colour at or above 1× (normal or busier), dim below.
      const r = relativeVolume(bars, p('days'));
      const hi = p('hi');
      return {
        pane: 'sub',
        series: [{
          key: 'v', label, axisLabel: 'RVOL', color: ind.color, style: 'histogram', values: r,
          colors: r.map(x => (x === null ? null : x >= hi ? '#f59e0b' : x >= 1 ? ind.color : withAlpha(ind.color, 0.45))),
        }],
      };
    }
    default:
      return { pane: 'price', series: [] };
  }
}

function computeSeries(bars: Bar[], ind: IndicatorInstance): IndicatorOutput {
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
    case 'vwapbands': {
      // Centre = sessionVwap exactly; bands 1 px like Bollinger's, so they do not crowd the candles. A band's line breaks
      // at the day change (the VWAP resets there), like the daily levels.
      const { vwap, sd } = vwapWithStdev(bars);
      const breaks = dayBreaks(bars);
      const series: OutSeries[] = [{ key: 'v', label: `${label} VWAP`, axisLabel: 'VWAP', color: ind.color, style: 'line', values: vwap, breaks }];
      for (const [k, n] of [['m1', 1], ['m2', 2], ['m3', 3]] as const) {
        const m = p(k);
        if (!(m > 0)) continue;
        const band = (sign: 1 | -1) => vwap.map((x, i) => (x === null || sd[i] === null ? null : x + sign * m * (sd[i] as number)));
        series.push({ key: `u${n}`, label: `${label} +${m}σ`, axisLabel: `+${m}σ`, color: ind.color, style: 'line', values: band(1), lineWidth: 1, breaks });
        series.push({ key: `l${n}`, label: `${label} −${m}σ`, axisLabel: `−${m}σ`, color: ind.color, style: 'line', values: band(-1), lineWidth: 1, breaks });
      }
      return { pane: 'price', series };
    }
    // No volume (the NSE / BSE index): a volume indicator draws nothing, and no empty pane that would squash the
    // candles; the picker marks these "Needs volume".
    case 'vwma':
    case 'obv':
    case 'mfi':
    case 'cmf':
    case 'rvol':
      return hasVolume(bars) ? volumeSeries(bars, ind, label, p) : { pane: 'price', series: [] };
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
          // TradingView's look: thin (1 px) bands in the indicator's colour, the basis in its own orange. At the default 2 px
          // three lines (plus Supertrend / EMA / VWAP) crowded the candles.
          { key: 'up', label: `${label} upper`, axisLabel: 'BB upper', color: ind.color, style: 'line', values: bb.up, lineWidth: 1 },
          { key: 'mid', label: `${label} basis`, axisLabel: 'BB basis', color: BB_BASIS, style: 'line', values: bb.mid, lineWidth: 1 },
          { key: 'lo', label: `${label} lower`, axisLabel: 'BB lower', color: ind.color, style: 'line', values: bb.lo, lineWidth: 1 },
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
    case 'daylevels': {
      const prev = prevDayHlc(bars);
      const cur = dayHl(bars);
      const breaks = dayBreaks(bars);
      const line = (key: string, name: string, color: string, values: (number | null)[], flat = false): OutSeries => ({
        key, label: `${label} ${name}`, axisLabel: name, color, style: 'line', lineWidth: 1, breaks, values, ...(flat ? { flat } : {}),
      });
      return {
        pane: 'price',
        series: [
          line('pdh', 'PDH', PREV_DAY_LEVEL, prev.map(x => (x ? x.h : null))),
          line('pdl', 'PDL', PREV_DAY_LEVEL, prev.map(x => (x ? x.l : null))),
          line('dh', 'DH', ind.color, cur.map(x => x.h), true),
          line('dl', 'DL', ind.color, cur.map(x => x.l), true),
        ],
      };
    }
    case 'rsi':
      return { pane: 'sub', series: [{ key: 'v', label, axisLabel: `RSI(${p('period')})`, color: ind.color, style: 'line', values: rsiArray(closes, p('period')), guides: [30, 70] }] };
    case 'volume':
      // No line series: the chart draws its own volume histogram (own scale, bottom band) while this is visible.
      return { pane: 'price', series: [] };
    case 'emacross': {
      const fast = emaSmaSeeded(closes, p('fast'));
      const slow = emaSmaSeeded(closes, p('slow'));
      // The circle sits where the lines meet: between the two EMAs on the crossing bar.
      const markers = crosses(fast, slow).map(c => ({ i: c.i, up: c.up, color: c.up ? UP : DOWN, price: ((fast[c.i] as number) + (slow[c.i] as number)) / 2 }));
      return {
        pane: 'price',
        series: [
          { key: 'fast', label: `${label} fast`, axisLabel: `EMA(${p('fast')})`, color: ind.color, style: 'line', values: fast, markers },
          { key: 'slow', label: `${label} slow`, axisLabel: `EMA(${p('slow')})`, color: EMA_CROSS_SLOW, style: 'line', values: slow },
        ],
      };
    }
    case 'stochrsi': {
      const s = stochRsiArray(closes, p('rsi'), p('stoch'), p('k'), p('d'));
      return {
        pane: 'sub',
        series: [
          { key: 'k', label: `${label} K`, axisLabel: 'K', color: ind.color, style: 'line', values: s.k, guides: [20, 80] },
          { key: 'd', label: `${label} D`, axisLabel: 'D', color: '#f97316', style: 'line', values: s.d },
        ],
      };
    }
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
    case 'structure': {
      // The forming (last) bar is left out: its high / low can still move, so it never confirms a swing (after the close
      // that costs the last bar one bar of lag, never a swing that later disappears). Labels ride on the swing points of
      // this one series (a marker needs a value at its bar); the line joining them is hidden when `line` is 0.
      const ms = marketStructure(bars.slice(0, -1), p('len'));
      const values: (number | null)[] = bars.map(() => null);
      for (const sw of ms.swings) values[sw.i] = sw.price;
      const GREY = '#94a3b8';
      const markers: NonNullable<OutSeries['markers']> = ms.swings.map(sw => ({
        i: sw.i, price: sw.price, up: sw.kind === 'H', size: 0.5, shape: 'circle' as const,
        position: (sw.kind === 'H' ? 'aboveBar' : 'belowBar') as 'aboveBar' | 'belowBar',
        color: sw.label === 'HH' || sw.label === 'HL' ? UP : sw.label === 'LH' || sw.label === 'LL' ? DOWN : GREY,
        ...(sw.label ? { text: sw.label } : {}),
      }));
      const color = p('line') === 0 ? 'transparent' : ind.color;
      return { pane: 'price', series: [{ key: 'v', label, axisLabel: 'Structure', color, style: 'line', values, markers, noLabel: true, lineWidth: 1 }] };
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
  /** Volume traded since the previous tick (the day's cumulative volume's increase); added to the bar it lands in. */
  volDelta = 0,
  /** Open interest now (a level, not a flow): the bar it lands in takes it. Null / 0 = unknown, the bar keeps its own. */
  oi: number | null = null,
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
  const dv = Number.isFinite(volDelta) && volDelta > 0 ? volDelta : 0;
  const liveOi = oi !== null && Number.isFinite(oi) && oi > 0 ? oi : null;
  if (bucket === last.t) {
    if (dv === 0 && last.c === price && price <= last.h && price >= last.l && (liveOi === null || liveOi === last.oi)) return bars;
    const next: Bar = { ...last, c: price, h: Math.max(last.h, price), l: Math.min(last.l, price) };
    if (dv > 0) next.v = (last.v ?? 0) + dv;
    if (liveOi !== null) next.oi = liveOi;
    return [...bars.slice(0, -1), next];
  }
  return [...bars, { t: bucket, o: price, h: price, l: price, c: price, ...(dv > 0 ? { v: dv } : {}), ...(liveOi !== null ? { oi: liveOi } : {}) }];
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
      // The forming bar's volume: the history's (bar start to the fetch) or the ticks' (since the page started counting),
      // whichever is larger: they overlap, so adding them would count the same trades twice.
      if (forming) {
        const v = Math.max(last.v ?? 0, b.v ?? 0);
        // OI is a level: the ticks' is newer than the snapshot's.
        const oi = b.oi ?? last.oi;
        out[out.length - 1] = { t: last.t, o: last.o, h: Math.max(last.h, b.h), l: Math.min(last.l, b.l), c: b.c, ...(v > 0 ? { v } : {}), ...(oi ? { oi } : {}) };
      }
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
