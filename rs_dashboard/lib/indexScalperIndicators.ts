// Indicator catalogue + pure computation for the /index-scalper chart. No React, no chart library: given candles and an
// indicator instance it returns plain series the chart component draws. Maths comes from lib/indicators.ts (never a
// private copy), except VWAP, which has no shared index-safe version.

import { emaArray, smaArray, rsiArray, macdSeries, adxDmiArray, supertrendSeries } from './indicators.ts';

export interface Bar { t: number; o: number; h: number; l: number; c: number }

export type IndicatorKind = 'ema' | 'sma' | 'vwap' | 'supertrend' | 'bbands' | 'rsi' | 'macd' | 'adx';

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
    params: [{ key: 'period', label: 'ATR length', def: 10, min: 1, max: 100 }, { key: 'mult', label: 'Factor', def: 3, min: 0.5, max: 20 }],
  },
  {
    kind: 'bbands', label: 'Bollinger Bands', pane: 'price', color: '#a78bfa',
    params: [{ key: 'period', label: 'Length', def: 20, min: 2, max: 200 }, { key: 'mult', label: 'StdDev', def: 2, min: 0.5, max: 10 }],
  },
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
  const name = ind.kind === 'vwap' ? 'VWAP' : c.label;
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
  color: string;
  style: SeriesStyle;
  /** One entry per input bar; null = no value (warm-up). */
  values: (number | null)[];
  /** Optional per-bar colour (Supertrend up/down, MACD histogram sign). */
  colors?: (string | null)[];
  /** Fixed horizontal guide lines for oscillators (RSI 30/70). */
  guides?: number[];
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
      const period = p('period');
      const v = emaArray(closes, period).map((x, i) => (i < period - 1 ? null : x));
      return { pane: 'price', series: [{ key: 'v', label, color: ind.color, style: 'line', values: v }] };
    }
    case 'sma':
      return { pane: 'price', series: [{ key: 'v', label, color: ind.color, style: 'line', values: smaArray(closes, p('period')) }] };
    case 'vwap':
      return { pane: 'price', series: [{ key: 'v', label, color: ind.color, style: 'line', values: sessionVwap(bars) }] };
    case 'supertrend': {
      const st = supertrendSeries(bars.map(b => ({ high: b.h, low: b.l, close: b.c })), p('period'), p('mult'));
      return {
        pane: 'price',
        series: [{
          key: 'v', label, color: ind.color, style: 'line',
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
          { key: 'up', label: `${label} upper`, color: ind.color, style: 'line', values: bb.up },
          { key: 'mid', label: `${label} basis`, color: ind.color, style: 'line', values: bb.mid },
          { key: 'lo', label: `${label} lower`, color: ind.color, style: 'line', values: bb.lo },
        ],
      };
    }
    case 'rsi':
      return { pane: 'sub', series: [{ key: 'v', label, color: ind.color, style: 'line', values: rsiArray(closes, p('period')), guides: [30, 70] }] };
    case 'macd': {
      const m = macdSeries(closes, p('fast'), p('slow'), p('signal'));
      const warm = p('slow') - 1;
      const hist = m.macdLine.map((x, i) => (i < warm ? null : x - m.signalLine[i]));
      return {
        pane: 'sub',
        series: [
          { key: 'hist', label: `${label} hist`, color: ind.color, style: 'histogram', values: hist, colors: hist.map(h => (h === null ? null : h >= 0 ? UP : DOWN)) },
          { key: 'macd', label: `${label} MACD`, color: ind.color, style: 'line', values: m.macdLine.map((x, i) => (i < warm ? null : x)) },
          { key: 'sig', label: `${label} signal`, color: '#f59e0b', style: 'line', values: m.signalLine.map((x, i) => (i < warm ? null : x)) },
        ],
      };
    }
    case 'adx': {
      const d = adxDmiArray(bars.map(b => b.h), bars.map(b => b.l), closes, p('period'));
      return {
        pane: 'sub',
        series: [
          { key: 'adx', label: `${label} ADX`, color: ind.color, style: 'line', values: d.adx },
          { key: 'pdi', label: '+DI', color: UP, style: 'line', values: d.plusDi },
          { key: 'mdi', label: '-DI', color: DOWN, style: 'line', values: d.minusDi },
        ],
      };
    }
  }
}

const SESSION_OPEN_S = 9 * 3600 + 15 * 60;
const SESSION_CLOSE_S = 15 * 3600 + 30 * 60;

/** Fold a live spot tick into the bar list: update the forming bar, or open a new one when the interval has rolled over
 *  inside the NSE session (09:15-15:30 IST). Outside the session, or when the tick is not newer than the last bar, the
 *  list comes back unchanged so a frozen after-hours spot never invents candles. Returns the same array when nothing changed. */
export function applyTick(bars: Bar[], price: number, intervalMin: number, nowSec: number): Bar[] {
  if (bars.length === 0 || !(price > 0)) return bars;
  const step = intervalMin * 60;
  const last = bars[bars.length - 1];
  const ist = nowSec + 19800;
  const secOfDay = ((ist % 86400) + 86400) % 86400;
  if (secOfDay < SESSION_OPEN_S || secOfDay >= SESSION_CLOSE_S) return bars;
  const bucket = Math.floor(ist / step) * step - 19800;
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
