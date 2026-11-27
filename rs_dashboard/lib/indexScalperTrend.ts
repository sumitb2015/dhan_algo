// Trend strip + multi-timeframe check for /index-scalper (components/indexScalper/TrendStrip.tsx). Pure: no React.
// Tested in indexScalperTrend.test.ts.
//
// Display only: nothing here prices, sends or blocks an order. Reads the LAST CLOSED bar of a timeframe (a light never
// flickers inside a forming bar; it lags by up to one bar, and the strip says the closed bar's time). Parameters are
// fixed at the chart's own defaults, so the strip agrees with what the chart draws:
//   VWAP  close vs the session VWAP (sessionVwap: equal-weight on the index, volume-weighted on a future)
//   EMA   EMA 9 vs EMA 20 (emaSmaSeeded, Pine ta.ema)
//   ST    Supertrend (10, 2), Pine path (matched to Dhan's chart)
//   ADX   ADX(14) with +DI / -DI
// Bias: Bullish / Bearish when VWAP, EMA and ST all point one way, Mixed otherwise, null while any is not computable.
// Strength: Choppy when ADX < 20; Strong when ADX >= 25 and the DI points with the bias.
// Two more lights, shown or hidden in the strip's settings, never part of the bias:
//   Structure  swing pattern (lib/indexScalperStructure.ts, swing length 3): HH + HL up, LH + LL down, else mixed
//   OI         futures OI buildup on the last closed bar vs the one before (price x OI change: long buildup, short
//              buildup, short covering, long unwinding; freshMoney's buildupOf), from the future's 1-minute bars with OI

import { adxDmiArray, emaSmaSeeded, supertrendSeries } from './indicators.ts';
import { sessionVwap, type Bar } from './indexScalperIndicators.ts';
import { marketStructure, STRUCTURE_LEN, type Swing } from './indexScalperStructure.ts';
import { buildupOf, BUILDUP_TEXT, type Buildup } from './freshMoney.ts';

export type Dir = 1 | -1 | 0;
export type Bias = 'bull' | 'bear' | 'mixed';
export type Strength = 'strong' | 'choppy' | null;

export const TREND_PARAMS = { emaFast: 9, emaSlow: 20, stPeriod: 10, stMult: 2, adxPeriod: 14, choppyBelow: 20, strongFrom: 25 } as const;

export interface TrendRead {
  /** Time (epoch s) and close of the closed bar read. */
  t: number;
  close: number;
  vwap: { value: number | null; dir: Dir | null };
  ema: { fast: number | null; slow: number | null; dir: Dir | null };
  st: { line: number | null; dir: Dir | null };
  adx: { adx: number | null; plusDi: number | null; minusDi: number | null; dir: Dir | null };
  /** Swing pattern: 1 = HH + HL, -1 = LH + LL, 0 = mixed; with the latest labelled swing high / low and their bar times. */
  structure: { dir: Dir | null; high: (Swing & { t: number }) | null; low: (Swing & { t: number }) | null };
  bias: Bias | null;
  strength: Strength;
}

const sign = (d: number): Dir => (d > 0 ? 1 : d < 0 ? -1 : 0);
const fin = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);

/** The bars whose interval has ended by `nowSec`: the forming bar (`last.t + step > now`) is dropped. Returns the same
 *  array when nothing is forming (after hours every bar is closed). */
export function closedBars(bars: Bar[], intervalMin: number, nowSec: number): Bar[] {
  const last = bars[bars.length - 1];
  if (!last) return bars;
  return last.t + intervalMin * 60 > nowSec ? bars.slice(0, -1) : bars;
}

/** The trend read on the LAST bar of `bars` (pass closed bars). Null with no bars. */
export function trendRead(bars: Bar[]): TrendRead | null {
  const n = bars.length;
  if (n === 0) return null;
  const i = n - 1;
  const b = bars[i];
  const closes = bars.map(x => x.c);
  const P = TREND_PARAMS;

  const vw = sessionVwap(bars)[i];
  const vwap = { value: fin(vw) ? vw : null, dir: fin(vw) ? sign(b.c - vw) : null };

  const fast = emaSmaSeeded(closes, P.emaFast)[i], slow = emaSmaSeeded(closes, P.emaSlow)[i];
  const ema = { fast: fin(fast) ? fast : null, slow: fin(slow) ? slow : null, dir: fin(fast) && fin(slow) ? sign(fast - slow) : null };

  const s = supertrendSeries(bars.map(x => ({ high: x.h, low: x.l, close: x.c })), P.stPeriod, P.stMult, { pine: true })[i];
  const st = { line: fin(s?.line) ? s.line : null, dir: s?.dir ?? null };

  const dmi = adxDmiArray(bars.map(x => x.h), bars.map(x => x.l), closes, P.adxPeriod);
  const a = dmi.adx[i], pd = dmi.plusDi[i], md = dmi.minusDi[i];
  const adx = {
    adx: fin(a) ? a : null, plusDi: fin(pd) ? pd : null, minusDi: fin(md) ? md : null,
    dir: fin(pd) && fin(md) ? sign(pd - md) : null,
  };

  let bias: Bias | null = null;
  if (vwap.dir !== null && ema.dir !== null && st.dir !== null) {
    bias = vwap.dir === 1 && ema.dir === 1 && st.dir === 1 ? 'bull'
      : vwap.dir === -1 && ema.dir === -1 && st.dir === -1 ? 'bear' : 'mixed';
  }
  let strength: Strength = null;
  if (adx.adx !== null) {
    if (adx.adx < P.choppyBelow) strength = 'choppy';
    else if (adx.adx >= P.strongFrom && ((bias === 'bull' && adx.dir === 1) || (bias === 'bear' && adx.dir === -1))) strength = 'strong';
  }
  const ms = marketStructure(bars, STRUCTURE_LEN);
  const structure = {
    dir: ms.dir,
    high: ms.lastHigh ? { ...ms.lastHigh, t: bars[ms.lastHigh.i].t } : null,
    low: ms.lastLow ? { ...ms.lastLow, t: bars[ms.lastLow.i].t } : null,
  };
  return { t: b.t, close: b.c, vwap, ema, st, adx, structure, bias, strength };
}

export interface MtfSummary { bull: number; bear: number; mixed: number; known: number; total: number; aligned: 'bull' | 'bear' | null }

/** Counts across timeframes; `aligned` when every timeframe has a bias and they all agree. */
export function mtfSummary(reads: (TrendRead | null)[]): MtfSummary {
  let bull = 0, bear = 0, mixed = 0;
  for (const r of reads) {
    if (r?.bias === 'bull') bull++;
    else if (r?.bias === 'bear') bear++;
    else if (r?.bias === 'mixed') mixed++;
  }
  const known = bull + bear + mixed, total = reads.length;
  const aligned = total > 0 && bull === total ? 'bull' : total > 0 && bear === total ? 'bear' : null;
  return { bull, bear, mixed, known, total, aligned };
}

/** Summary text: "4/4 bull ALIGNED", "3/4 bull", "2 bull · 2 bear", "1 bull · 1 bear · 2 mixed", "—". */
export function mtfText(s: MtfSummary): string {
  if (s.known === 0) return '—';
  if (s.aligned) return `${s.total}/${s.total} ${s.aligned} ALIGNED`;
  const parts: string[] = [];
  if (s.bull) parts.push(`${s.bull} bull`);
  if (s.bear) parts.push(`${s.bear} bear`);
  if (s.mixed) parts.push(`${s.mixed} mixed`);
  if (parts.length === 1 && !s.mixed) return `${s.bull || s.bear}/${s.total} ${s.bull ? 'bull' : 'bear'}`;
  return parts.join(' · ');
}

/** A stable key for the closed tail, so the strip recomputes once per bar close, not on every tick. */
export const closedKey = (bars: Bar[]): string => {
  const l = bars[bars.length - 1];
  return l ? `${bars.length}|${l.t}|${l.o}|${l.h}|${l.l}|${l.c}|${bars[0].t}` : '';
};

/** 1-minute bars folded into `tfMin` buckets anchored at `anchorSec` seconds after IST midnight (the session open, as the
 *  candles route and applyTick bucket them). OHLC as usual, volume summed, open interest = the bucket's last known. */
export function resampleBars(bars: Bar[], tfMin: number, anchorSec: number): Bar[] {
  if (tfMin <= 1) return bars;
  const step = tfMin * 60;
  const out: Bar[] = [];
  for (const b of bars) {
    const key = Math.floor((b.t + 19800 - anchorSec) / step) * step + anchorSec - 19800;
    const cur = out[out.length - 1];
    if (cur && cur.t === key) {
      cur.h = Math.max(cur.h, b.h); cur.l = Math.min(cur.l, b.l); cur.c = b.c;
      if (b.v !== undefined) cur.v = (cur.v ?? 0) + b.v;
      if (b.oi) cur.oi = b.oi;
    } else {
      out.push({ t: key, o: b.o, h: b.h, l: b.l, c: b.c, ...(b.v !== undefined ? { v: b.v } : {}), ...(b.oi ? { oi: b.oi } : {}) });
    }
  }
  return out;
}

export interface OiBuildupRead {
  /** Time of the closed bar read. */
  t: number;
  kind: Buildup | null;
  /** Bias of the buildup: long buildup / short covering = 1 (price up), short buildup / long unwinding = -1. */
  dir: Dir | null;
  oi: number | null; oiChg: number | null; priceChg: number | null;
}

/** Futures OI buildup on the LAST bar of `bars` (pass closed bars) against the bar before it. Null kind when either OI
 *  is unknown or OI did not change (no buildup to name). */
export function oiBuildup(bars: Bar[]): OiBuildupRead | null {
  const n = bars.length;
  if (n < 2) return null;
  const b = bars[n - 1], p = bars[n - 2];
  const oiChg = b.oi && p.oi ? b.oi - p.oi : null;
  const kind = buildupOf(oiChg, b.c, p.c);
  const dir: Dir | null = kind === 'LB' || kind === 'SC' ? 1 : kind === 'SB' || kind === 'LU' ? -1 : null;
  return { t: b.t, kind, dir, oi: b.oi ?? null, oiChg, priceChg: b.c - p.c };
}

export const buildupName = (k: Buildup | null): string => (k ? BUILDUP_TEXT[k].name : 'No OI change');

/** The strip's own settings (gear menu next to its switch), stored as JSON; anything missing is on. */
/** `structureLine`: the line joining the chart's HH / HL / LH / LL swings (the Market structure indicator's `line`). */
export interface TrendSettings { oiBuildup: boolean; structure: boolean; structureLine: boolean }
export const TREND_SETTINGS_KEY = 'indexScalper.trendSettings';
export const DEFAULT_TREND_SETTINGS: TrendSettings = { oiBuildup: true, structure: true, structureLine: true };
export function clampTrendSettings(raw: unknown): TrendSettings {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Partial<Record<keyof TrendSettings, unknown>>;
  return { oiBuildup: o.oiBuildup !== false, structure: o.structure !== false, structureLine: o.structureLine !== false };
}
