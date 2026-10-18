/**
 * Bar and indicator helpers for strategies. Everything here works on CLOSED bars only, so a strategy that builds on
 * these never reads a forming candle in live and therefore signals the same in the backtest.
 */

import { resampleBars, type Bar } from '../volumeProfile.ts';
import { closedBarsOnly, sessionVwap } from '../bearishStrikes.ts';
import { emaSmaSeeded, supertrendSeries } from '../indicators.ts';

export { emaSmaSeeded, supertrendSeries, sessionVwap };

const pad = (n: number) => String(n).padStart(2, '0');
export const minToHm = (m: number) => `${pad(Math.floor(m / 60))}:${pad(m % 60)}`;
export const hmToMin = (hm: string) => Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3, 5));
export const SESSION_OPEN = 9 * 60 + 15;
export const SESSION_LAST = 15 * 60 + 29;

/** IST wall clock of a decision at `date` `hm` as epoch ms on the IST axis (Date.UTC of the IST stamp). */
export const istMsOf = (date: string, hm: string) =>
  Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1, +date.slice(8, 10), +hm.slice(0, 2), +hm.slice(3, 5));

/**
 * resampleBars (lib/volumeProfile.ts, the NSE grid anchored at 09:15) without the regex, and incremental: when called
 * on a longer slice of the same bar objects (the backtest builds each minute's view as a prefix slice of one array),
 * it only folds in the new bars. Keyed by the first bar object; a different array (live re-merges every tick) simply
 * recomputes. Returned arrays never change afterwards: the forming bucket is handed out as a copy.
 */
const rsCache = new WeakMap<Bar, Map<number, { n: number; last: Bar; out: Bar[] }>>();
export function resampleFast(bars: Bar[], tf: number): Bar[] {
  if (tf <= 1 || !bars.length) return bars;
  let perTf = rsCache.get(bars[0]);
  if (!perTf) rsCache.set(bars[0], (perTf = new Map()));
  let st = perTf.get(tf);
  if (!st || st.n > bars.length || bars[st.n - 1] !== st.last) st = { n: 0, last: bars[0], out: [] };
  const out = st.out;
  for (let i = st.n; i < bars.length; i++) {
    const b = bars[i];
    const t = b.t;
    const mins = (t.charCodeAt(11) - 48) * 600 + (t.charCodeAt(12) - 48) * 60 + (t.charCodeAt(14) - 48) * 10 + (t.charCodeAt(15) - 48);
    const off = mins - SESSION_OPEN;
    const floored = off < 0 ? SESSION_OPEN : SESSION_OPEN + Math.floor(off / tf) * tf;
    const key = `${t.slice(0, 10)} ${minToHm(floored)}:00`;
    const cur = out[out.length - 1];
    if (cur && cur.t === key) {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    } else {
      out.push({ ...b, t: key });
    }
  }
  st.n = bars.length;
  st.last = bars[bars.length - 1];
  perTf.set(tf, st);
  return out.length ? [...out.slice(0, -1), { ...out[out.length - 1] }] : [];
}

/** 1-minute bars resampled to `tf` with the forming bucket dropped. Bars must be in time order. */
export function closedTfBars(bars1m: Bar[], tf: number, nowIstMs: number): Bar[] {
  return closedBarsOnly(resampleFast(bars1m, tf), tf, nowIstMs);
}

export { resampleBars };

export const dayOf = (b: Bar) => b.t.slice(0, 10);
export const todayOnly = (bars: Bar[], date: string) => bars.filter((b) => dayOf(b) === date);

/** pandas ewm(span, adjust=False).mean() last value — matches cyber_scalper_feed.py's EMA9/EMA20. */
export function ewmLast(values: number[], span: number): number | null {
  if (!values.length) return null;
  const a = 2 / (span + 1);
  let v = values[0];
  for (let i = 1; i < values.length; i++) v = a * values[i] + (1 - a) * v;
  return v;
}

/** Running mean of closes: the index VWAP stand-in (an index has no volume; the live feed falls back to it too). */
export function closeMean(bars: Bar[]): number | null {
  if (!bars.length) return null;
  return bars.reduce((a, b) => a + b.c, 0) / bars.length;
}

/** Close-only 1-minute bar (the shape of ctx.spotBars1m in both modes). */
export const closeBar = (date: string, hm: string, c: number): Bar => ({ t: `${date} ${hm}:00`, o: c, h: c, l: c, c, v: 0 });
