// Gearbox Drive page helpers, pure: the feed's 1-minute bars -> closed GbBars at the page timeframe (IST clock, volume kept for
// the session VWAP), the MCX session the engine reads, and the event log the game printed (mode changes, setups, shift-ups and
// the ghost's trades). Relative imports only so `node --test` runs it.

import { mcxSession } from './mcxSession.ts';
import { istDateIso } from './nseHolidays.ts';
import type { GbBar, GbSession, GbState, GhostTrade } from './gearbox.ts';

const IST_S = 19_800;

export type FeedBar = { t: number; straddle: number; vol: number; h?: number; l?: number };

export const hhmmToMin = (hhmm: number): number => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

/** The MCX session (open, square-off) of the IST day a bar (unix s) falls on. */
export function gbSession(t: number): GbSession {
  const s = mcxSession(istDateIso(t * 1000));
  return { openMin: hhmmToMin(s.open), autoExitMin: hhmmToMin(s.autoExit) };
}

/** 1-minute bars -> `tf`-minute bars on the IST clock; the bucket still forming at `nowS` is dropped. */
export function gbClosedBars(bars1m: FeedBar[], tf: number, nowS: number): GbBar[] {
  const size = tf * 60;
  const out: GbBar[] = [];
  for (const b of bars1m) {
    const c = b.straddle;
    if (!(c > 0) || !Number.isFinite(c)) continue;
    // a range that does not contain the close is not trusted (a stitched or bad row): the close stands in for it
    const ok = b.h !== undefined && b.l !== undefined && Number.isFinite(b.h) && Number.isFinite(b.l) && b.l > 0 && b.l <= c && c <= b.h;
    const hi = ok ? b.h! : c, lo = ok ? b.l! : c;
    const v = Number.isFinite(b.vol) && b.vol > 0 ? b.vol : 0;
    const t = Math.floor((b.t + IST_S) / size) * size - IST_S;
    const cur = out[out.length - 1];
    if (cur && cur.t === t) { cur.c = c; cur.h = Math.max(cur.h!, hi); cur.l = Math.min(cur.l!, lo); cur.v += v; }
    else out.push({ t, o: c, h: hi, l: lo, c, v });
  }
  while (out.length && nowS < out[out.length - 1].t + size) out.pop();
  return out;
}

/** Changes only when a `tf` bar closes or the history reloads (the forming minute moving does not change it). */
export function gbClosedKey(bars1m: FeedBar[], tf: number, nowS: number, histVersion: number): string {
  const size = tf * 60;
  const lastClosedStart = Math.floor((nowS + IST_S) / size) * size - IST_S - size;
  let i = bars1m.length - 1;
  while (i >= 0 && bars1m[i].t >= lastClosedStart + size) i--;
  return `${histVersion}|${tf}|${lastClosedStart}|${i}|${bars1m[i]?.t}|${bars1m[i]?.straddle}`;
}

export type GbEvent = { t: number; msg: string; tone: 'info' | 'good' | 'bad' | 'hot' };

const fmt = (v: number) => (v > 0 ? '+' : '') + v.toFixed(1);

/** The game's event lines for bars `from`.. (newest first). */
export function gbEvents(states: GbState[], ghost: GhostTrade[], from: number): GbEvent[] {
  const out: GbEvent[] = [];
  for (let i = Math.max(1, from); i < states.length; i++) {
    const s = states[i], p = states[i - 1];
    if (s.mode !== p.mode) {
      out.push({ t: s.t, tone: 'info', msg: s.mode === 0 ? 'Fog: near the EMA200 ridge — neutral' : `Mode change: now ${s.mode > 0 ? 'climbing' : 'descending'}` });
    } else if (s.gear !== p.gear) {
      if (s.signal) out.push({ t: s.t, tone: 'hot', msg: `Shift up to gear ${s.gear} with VWAP + Supertrend — entry signal` });
      else if (s.armed && !p.armed) out.push({ t: s.t, tone: 'info', msg: `Pullback to gear ${s.gear} — setup armed` });
    }
  }
  for (const x of ghost) {
    if (x.ei >= from && x.ei < states.length) out.push({ t: states[x.ei].t, tone: 'info', msg: `Ghost went ${x.side > 0 ? 'long' : 'short'} at ${x.ep.toFixed(1)}` });
    if (!x.open && x.xi >= from && x.xi < states.length) {
      const q = (x.xp - x.ep) * x.side;
      out.push({ t: states[x.xi].t, tone: q >= 0 ? 'good' : 'bad', msg: `Ghost closed ${fmt(q)} pts · ${x.why}` });
    }
  }
  return out.sort((a, b) => b.t - a.t);
}
