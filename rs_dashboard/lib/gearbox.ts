/**
 * Gearbox maths — pure functions over CLOSED bars (spec §5). A rule-for-rule port of the
 * artifact's `build()`: EMA 9/20/50/100/200, ATR(14, Wilder), session VWAP, Supertrend(14, 3),
 * the mode (road direction / fog), the gear (1..5, 0 = neutral), the Setup -> Shift-up signal,
 * and the "ghost" driver that follows the rules mechanically.
 *
 * Two deliberate differences from the artifact, ghost only (the states stay identical):
 *  - the stop is tested against the bar's low / high and exits AT the stop price (the artifact
 *    compared the close, which hides intrabar stop-outs);
 *  - a mode of 0 (fog) never exits the ghost (the artifact already behaved so; now it is a rule).
 *
 * EMA reuses `emaArray` (seeded with the first close, same as the artifact). ATR, VWAP and
 * Supertrend stay local: the artifact's Supertrend carries bands with a previous-CLOSE rule and
 * starts on the first bar, which `supertrendSeries` in lib/indicators.ts does not do.
 */
import { emaArray } from './indicators.ts';

export interface GbBar { t: number; o?: number; h?: number; l?: number; c: number; v: number } // t = bar open, unix s
export type Mode = 1 | -1 | 0;
export interface GbState {
  c: number; gear: 0 | 1 | 2 | 3 | 4 | 5; mode: Mode; armed: boolean; signal: boolean; vwOK: boolean; stOK: boolean;
  sd: 1 | -1; sl: number; sp: number; acc: number; rpm: number; alt: number; t: number; sessionBar: number;
}
export interface GhostTrade {
  side: 1 | -1; ei: number; xi: number; ep: number; xp: number;
  why: 'stop hit' | 'mode flipped' | 'gear collapsed' | 'session close';
}
export interface GbSession { openMin: number; autoExitMin: number } // IST minutes of day

export const WARM_BARS = 200;
export const ENTRY_AFTER_OPEN_MIN = 15;
export const ENTRY_BEFORE_EXIT_MIN = 40;

const IST_OFFSET_S = 19800;
const istMinute = (t: number): number => Math.floor((((t + IST_OFFSET_S) % 86400) + 86400) % 86400 / 60);
const istDay = (t: number): number => Math.floor((t + IST_OFFSET_S) / 86400);

/** Entry window: from open + ENTRY_AFTER_OPEN_MIN to autoExit - ENTRY_BEFORE_EXIT_MIN (bar open time). */
function inEntryWindow(t: number, s: GbSession): boolean {
  const m = istMinute(t);
  return m - s.openMin >= ENTRY_AFTER_OPEN_MIN && m <= s.autoExitMin - ENTRY_BEFORE_EXIT_MIN;
}

const hi = (b: GbBar): number => b.h ?? b.c;
const lo = (b: GbBar): number => b.l ?? b.c;

export function computeGearbox(bars: GbBar[], session: (t: number) => GbSession): GbState[] {
  const n = bars.length;
  if (!n) return [];
  const C = bars.map(b => b.c);
  const E9 = emaArray(C, 9), E20 = emaArray(C, 20), E50 = emaArray(C, 50), E100 = emaArray(C, 100), E200 = emaArray(C, 200);

  // Wilder ATR(14), first bar = its own true range.
  const A: number[] = [];
  let a = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i], pc = i ? bars[i - 1].c : b.c;
    const tr = Math.max(hi(b) - lo(b), Math.abs(hi(b) - pc), Math.abs(lo(b) - pc));
    a = i ? (a * 13 + tr) / 14 : tr;
    A.push(a);
  }

  // Session bars and VWAP (hlc3 x volume), reset at each session's first bar.
  const SB: number[] = [], VW: number[] = [];
  const step = n > 1 && bars[1].t > bars[0].t ? (bars[1].t - bars[0].t) / 60 : 5;
  let pv = 0, vv = 0, sb = 0;
  for (let i = 0; i < n; i++) {
    const b = bars[i];
    if (i === 0) {
      const s0 = session(b.t);
      sb = Math.max(0, Math.round((istMinute(b.t) - s0.openMin) / step));
    } else if (istDay(b.t) !== istDay(bars[i - 1].t)) { sb = 0; pv = 0; vv = 0; } else sb++;
    SB.push(sb);
    const v = b.v > 0 ? b.v : 0;
    pv += (hi(b) + lo(b) + b.c) / 3 * v; vv += v;
    VW.push(vv > 0 ? pv / vv : (hi(b) + lo(b) + b.c) / 3);
  }

  // Supertrend(ATR 14, x3).
  const SD: (1 | -1)[] = [], SL: number[] = [];
  let fu = 0, fl = 0, d: 1 | -1 = 1;
  for (let i = 0; i < n; i++) {
    const b = bars[i], m = (hi(b) + lo(b)) / 2, bu = m + 3 * A[i], bl = m - 3 * A[i];
    if (!i) { fu = bu; fl = bl; } else {
      const pc = bars[i - 1].c;
      fu = (bu < fu || pc > fu) ? bu : fu;
      fl = (bl > fl || pc < fl) ? bl : fl;
      d = d === 1 ? (b.c < fl ? -1 : 1) : (b.c > fu ? 1 : -1);
    }
    SD.push(d); SL.push(d === 1 ? fl : fu);
  }

  const S: GbState[] = [];
  let side: Mode = 0, mode: Mode = 0, age = 0, armed = false, seen = false;
  for (let i = 0; i < n; i++) {
    const b = bars[i], c = b.c, at = A[i];
    if (i && c > E200[i] && C[i - 1] > E200[i - 1]) side = 1;
    else if (i && c < E200[i] && C[i - 1] < E200[i - 1]) side = -1;
    const slope = i >= 10 ? E200[i] - E200[i - 10] : 0;
    let m: Mode = side;
    if (Math.abs(c - E200[i]) < 0.3 * at) m = 0;
    if (m === 1 && slope < -0.15 * at) m = 0;
    if (m === -1 && slope > 0.15 * at) m = 0;
    if (m !== mode) { age = 0; armed = false; seen = false; mode = m; } else age++;
    const gear = (m === 0 ? 0 : 1 + [E9[i], E20[i], E50[i], E100[i]].filter(e => (m === 1 ? c > e : c < e)).length) as GbState['gear'];
    const pg = i ? S[i - 1].gear : 0;
    const vwOK = m === 1 ? c > VW[i] : m === -1 ? c < VW[i] : false;
    const stOK = m !== 0 && SD[i] === m;
    let signal = false;
    if (m !== 0) {
      if (gear >= 4) seen = true;
      if (gear === 1) armed = false;
      else if (armed && gear > pg && pg >= 2 && pg <= 3) {
        signal = vwOK && stOK && inEntryWindow(b.t, session(b.t)) && age > 3;
        armed = false; seen = gear >= 4;
      } else if (seen && (gear === 2 || gear === 3) && gear < pg) armed = true;
    }
    const sp = i >= 3 ? (E9[i] / E9[i - 3] - 1) * 1e4 / 3 : 0;
    S.push({
      c, gear, mode: m, armed, signal, vwOK, stOK, sd: SD[i], sl: SL[i], sp,
      acc: i >= 6 ? sp - S[i - 3].sp : 0,
      rpm: at > 0 ? Math.abs(c - E9[i]) / at : 0,
      alt: at > 0 ? (c - E200[i]) / at : 0,
      t: b.t, sessionBar: SB[i],
    });
  }
  return S;
}

/** Trades the rules would have taken. Starts after WARM_BARS; one position at a time. The trade
 *  open on the last bar (if any) is the final element, with xi === bars.length. */
export function ghostTrades(bars: GbBar[], states: GbState[], session: (t: number) => GbSession): GhostTrade[] {
  const T: GhostTrade[] = [];
  const n = Math.min(bars.length, states.length);
  let pos: Mode = 0, ent = 0, stop = 0, ei = 0;
  const lastOfSession = (i: number): boolean => {
    const t = bars[i].t;
    return istMinute(t) >= session(t).autoExitMin || (i + 1 < n && istDay(bars[i + 1].t) !== istDay(t));
  };
  for (let i = WARM_BARS; i < n; i++) {
    const s = states[i], b = bars[i];
    if (pos) {
      if (s.gear >= 4 && s.sd === pos) stop = pos > 0 ? Math.max(stop, s.sl) : Math.min(stop, s.sl);
      let why: GhostTrade['why'] | '' = '';
      let xp = b.c;
      if (pos > 0 ? lo(b) < stop : hi(b) > stop) { why = 'stop hit'; xp = stop; }
      else if (s.mode === -pos) why = 'mode flipped';
      else if (s.mode === pos && s.gear === 1) why = 'gear collapsed';
      else if (lastOfSession(i)) why = 'session close';
      if (why) { T.push({ side: pos, ei, xi: i, ep: ent, xp, why }); pos = 0; }
    }
    if (!pos && s.signal && s.mode !== 0 && !lastOfSession(i) && inEntryWindow(b.t, session(b.t))) {
      pos = s.mode; ent = b.c; ei = i;
      let sw = pos > 0 ? 1e18 : -1e18;
      for (let j = Math.max(0, i - 10); j <= i; j++) sw = pos > 0 ? Math.min(sw, lo(bars[j])) : Math.max(sw, hi(bars[j]));
      stop = pos > 0 ? Math.max(sw, s.sl) : Math.min(sw, s.sl);
    }
  }
  // A trade still open on the last bar is listed with xi === bars.length (one past the data) and
  // xp = the last close, so ghostScore can mark it; `why` is a placeholder until it really exits.
  if (pos) T.push({ side: pos, ei, xi: n, ep: ent, xp: bars[n - 1].c, why: 'session close' });
  return T;
}

/** Ghost score as of bar i: closed trades plus the open one marked at that bar's close. */
export function ghostScore(trades: GhostTrade[], states: GbState[], i: number): { points: number; closed: number; wins: number; open: 1 | -1 | 0 } {
  let points = 0, closed = 0, wins = 0, open: 1 | -1 | 0 = 0;
  for (const x of trades) {
    if (x.xi <= i) { const p = (x.xp - x.ep) * x.side; points += p; closed++; if (p > 0) wins++; }
    else if (x.ei <= i) { open = x.side; points += (states[i].c - x.ep) * x.side; }
  }
  return { points, closed, wins, open };
}
