// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL was not
// distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
//
// TypeScript port of the TradingView script "Dow Structure - Swings, BOS & CHoCH" v1.0, (c) K'u Hero, MPL-2.0
// (Pine v6; source supplied by the user on 2026-11-28). The port keeps its rules one for one; only the drawing is mapped
// to the chart engine (lib/indexScalperIndicators.ts, kind 'dow').
//
// Swing structure (HH / HL / LH / LL), trend state and structure breaks for the chart timeframe only.
//  - Swing high/low: fractal with L bars on the left (strictly lower) and R bars on the right (lower or equal). A swing
//    is known only R bars later, so its label appears R bars after the swing bar (it never moves afterwards).
//  - Method "Pullback low / rally high": uptrend = the last pullback low has not been broken. When price breaks above
//    the reference swing high, the lowest low since that swing high becomes the new pullback low (BOS). The reference
//    swing high is the trend high (a lower high does not move the pullback low). Downtrend = mirror image with rally
//    highs. Breaking the pullback low (rally high) changes the trend (CHoCH).
//  - Method "HH-HL / LH-LL": up when the last two swing highs AND lows are higher, down when both are lower, else range.
//  - Only closed bars are processed (Pine barstate.isconfirmed), so nothing on past bars changes.
// Display only. This is not a buy/sell signal.

import type { Bar } from './indexScalperIndicators.ts';

const MAXLOOK = 1000;

export interface DowOptions {
  left?: number;
  right?: number;
  /** 'pullback' = "Pullback low / rally high" (default); 'hhhl' = "HH-HL / LH-LL". */
  method?: 'pullback' | 'hhhl';
  /** Break by the close (default) or the wick. */
  breakBy?: 'close' | 'wick';
  /** Last bar index that counts as closed (Pine's barstate.isconfirmed); later bars carry the state unchanged.
   *  Default: every bar. */
  lastClosedIndex?: number;
}

/** Per bar, as the script's f_dow returns it. dir: 1 up, −1 down, 0 range. evt: 1 BOS up, −1 BOS down, 2 CHoCH up,
 *  −2 CHoCH down, 3 range (method 2), 0 none. swH / swL: 0 none, 1 H/L, 2 HH/HL, 3 LH/LL, 4 EQH/EQL — the swing bar is
 *  this bar − right. */
export interface DowBar {
  dir: number; lvl: number | null; lvlBar: number | null;
  evt: number; evtLv: number | null; evtFrom: number | null;
  swH: number; swL: number;
}

export function dowStructure(bars: Bar[], opts: DowOptions = {}): DowBar[] {
  const L = Math.max(1, Math.floor(opts.left ?? 3));
  const R = Math.max(1, Math.floor(opts.right ?? 3));
  const m1 = (opts.method ?? 'pullback') === 'pullback';
  const wick = opts.breakBy === 'wick';
  const lastClosed = opts.lastClosedIndex ?? bars.length - 1;
  const high = (i: number) => bars[i].h, low = (i: number) => bars[i].l;

  // lowest low in (fromBar, b], [bar, price]; the earliest bar wins ties (Pine loops k = 0 .. n-1 with <=)
  const minLow = (b: number, fromBar: number | null): [number | null, number | null] => {
    if (fromBar === null) return [null, null];
    const n = Math.min(b - fromBar, MAXLOOK);
    let bb: number | null = null, bp: number | null = null;
    for (let k = 0; k < n; k++) if (bp === null || low(b - k) <= bp) { bp = low(b - k); bb = b - k; }
    return [bb, bp];
  };
  const maxHigh = (b: number, fromBar: number | null): [number | null, number | null] => {
    if (fromBar === null) return [null, null];
    const n = Math.min(b - fromBar, MAXLOOK);
    let bb: number | null = null, bp: number | null = null;
    for (let k = 0; k < n; k++) if (bp === null || high(b - k) >= bp) { bp = high(b - k); bb = b - k; }
    return [bb, bp];
  };
  const isSwingHigh = (b: number) => {
    if (b < L + R) return false;
    const p = high(b - R);
    for (let k = 1; k <= L; k++) if (!(p > high(b - R - k))) return false;
    for (let k = 0; k <= R - 1; k++) if (!(p >= high(b - k))) return false;
    return true;
  };
  const isSwingLow = (b: number) => {
    if (b < L + R) return false;
    const p = low(b - R);
    for (let k = 1; k <= L; k++) if (!(p < low(b - R - k))) return false;
    for (let k = 0; k <= R - 1; k++) if (!(p <= low(b - k))) return false;
    return true;
  };

  // var state
  let dir = 0;
  let lvl: number | null = null, lvlBar: number | null = null;
  let refH: number | null = null, refHp: number | null = null;
  let refL: number | null = null, refLp: number | null = null;
  let lastH: number | null = null, prevH: number | null = null, lastL: number | null = null, prevL: number | null = null;
  let lastHb: number | null = null, lastLb: number | null = null;
  let hiBase: number | null = null, loBase: number | null = null;
  let m2 = 0;

  const out: DowBar[] = [];
  for (let b = 0; b < bars.length; b++) {
    let evt = 0, evtLv: number | null = null, evtFrom: number | null = null, swH = 0, swL = 0;
    if (b <= lastClosed) {
      const h = high(b), l = low(b), c = bars[b].c;
      hiBase = hiBase === null ? h : Math.max(hiBase, h);
      loBase = loBase === null ? l : Math.min(loBase, l);
      const i = b - R;
      // (1) swings confirmed on this bar
      if (isSwingHigh(b)) {
        const p = high(b - R);
        swH = lastH === null ? 1 : p > lastH ? 2 : p < lastH ? 3 : 4;
        prevH = lastH; lastH = p; lastHb = i;
        if (!m1 || dir !== 1 || p >= hiBase) { refH = i; refHp = p; }
      }
      if (isSwingLow(b)) {
        const p = low(b - R);
        swL = lastL === null ? 1 : p > lastL ? 2 : p < lastL ? 3 : 4;
        prevL = lastL; lastL = p; lastLb = i;
        if (!m1 || dir !== -1 || p <= loBase) { refL = i; refLp = p; }
      }
      if (m1) {
        const up = wick ? h : c, dn = wick ? l : c;
        let reset = false;
        if (dir === 1) {
          if (lvl !== null && dn < lvl) {
            evt = -2; evtLv = lvl; evtFrom = lvlBar;
            const [hb, hp] = maxHigh(b, lvlBar);
            dir = -1; lvl = hp === null ? h : hp; lvlBar = hb === null ? b : hb;
            refL = null; reset = true;
          } else if (refH !== null && up > (refHp as number)) {
            evt = 1; evtLv = refHp; evtFrom = refH;
            const [lb, lp] = minLow(b, refH);
            if (lb !== null) { lvl = lp; lvlBar = lb; }
            refH = null; reset = true;
          }
        } else if (dir === -1) {
          if (lvl !== null && up > lvl) {
            evt = 2; evtLv = lvl; evtFrom = lvlBar;
            const [lb, lp] = minLow(b, lvlBar);
            dir = 1; lvl = lp === null ? l : lp; lvlBar = lb === null ? b : lb;
            refH = null; reset = true;
          } else if (refL !== null && dn < (refLp as number)) {
            evt = -1; evtLv = refLp; evtFrom = refL;
            const [hb, hp] = maxHigh(b, refL);
            if (hb !== null) { lvl = hp; lvlBar = hb; }
            refL = null; reset = true;
          }
        } else {
          if (refH !== null && up > (refHp as number)) {
            evt = 2; evtLv = refHp; evtFrom = refH;
            const [lb, lp] = minLow(b, refH);
            dir = 1; lvl = lp === null ? l : lp; lvlBar = lb === null ? b : lb;
            refH = null; reset = true;
          } else if (refL !== null && dn < (refLp as number)) {
            evt = -2; evtLv = refLp; evtFrom = refL;
            const [hb, hp] = maxHigh(b, refL);
            dir = -1; lvl = hp === null ? h : hp; lvlBar = hb === null ? b : hb;
            refL = null; reset = true;
          }
        }
        if (reset) { hiBase = h; loBase = l; }
      } else if (lastH !== null && prevH !== null && lastL !== null && prevL !== null) {
        const cc = lastH > prevH && lastL > prevL ? 1 : lastH < prevH && lastL < prevL ? -1 : 0;
        if (cc !== m2) {
          evt = cc === 1 ? 2 : cc === -1 ? -2 : 3;
          evtLv = cc === 1 ? lastL : cc === -1 ? lastH : c;
          evtFrom = cc === 1 ? lastLb : cc === -1 ? lastHb : b;
          m2 = cc;
        }
        dir = m2;
        lvl = dir === 1 ? lastL : dir === -1 ? lastH : null;
        lvlBar = dir === 1 ? lastLb : dir === -1 ? lastHb : null;
      }
    }
    out.push({ dir, lvl, lvlBar, evt, evtLv, evtFrom, swH, swL });
  }
  return out;
}

/** The script's key-level plot: the level while the trend and the level are unchanged from the bar before, else a gap
 *  (plot.style_linebr: the line breaks for one bar where the level moves, no vertical connector). */
export function dowKeyLevel(d: DowBar[]): (number | null)[] {
  return d.map((x, i) => (i > 0 && x.dir !== 0 && x.dir === d[i - 1].dir && x.lvl !== null && x.lvl === d[i - 1].lvl ? x.lvl : null));
}

/** Swing labels (bar = swing bar, price = its high / low, text H/HH/LH/EQH or L/HL/LL/EQL) and structure-break segments
 *  (from evtFrom, capped at 4999 bars back, to the break bar, at the broken level; label at the middle bar). */
export function dowDrawings(bars: Bar[], d: DowBar[], right: number) {
  const R = Math.max(1, Math.floor(right));
  const swings: { i: number; price: number; high: boolean; text: string; tone: 1 | -1 | 0 }[] = [];
  const events: { from: number; to: number; level: number; bos: boolean; up: boolean; mid: number }[] = [];
  d.forEach((x, b) => {
    if (x.swH > 0) swings.push({ i: b - R, price: bars[b - R].h, high: true, text: ['', 'H', 'HH', 'LH', 'EQH'][x.swH], tone: x.swH === 2 ? 1 : x.swH === 3 ? -1 : 0 });
    if (x.swL > 0) swings.push({ i: b - R, price: bars[b - R].l, high: false, text: ['', 'L', 'HL', 'LL', 'EQL'][x.swL], tone: x.swL === 2 ? 1 : x.swL === 3 ? -1 : 0 });
    if (x.evt !== 0 && x.evt !== 3 && x.evtLv !== null && x.evtFrom !== null) {
      const from = Math.max(x.evtFrom, b - 4999);
      events.push({ from, to: b, level: x.evtLv, bos: Math.abs(x.evt) === 1, up: x.evt > 0, mid: Math.round((from + b) / 2) });
    }
  });
  return { swings, events };
}
