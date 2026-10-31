// The P&F triangle (a squeeze): each new column sits inside the previous one (an O inside an X, an X inside that O ...). Three nested
// columns are a 3-column triangle, four a 4-column one; the more columns, the tighter the squeeze. It ends with a Double Top Buy
// (bullish breakout) or a Double Bottom Sell (bearish breakdown). The trade the pattern is taught with: entry at the breakout level,
// stop at the opposite trigger of the triangle, target from the vertical count. Pure (tested in lib/pnfTriangle.test.ts).
// Triangles are NOT signals: they are kept out of `model.signals`, which AUTO trades (lib/pnfAuto.ts maps every such kind to BUY / SELL).
import type { PnfColumn, PnfSignal } from './straddlePnf.ts';

export type TriangleState = 'forming' | 'up' | 'down' | 'ended';

export interface TriangleBreakout {
  side: 'UP' | 'DOWN';
  /** The breaking column and the bar / time its break box was drawn. */
  col: number;
  bar: number;
  t: number;
  /** Where the trade is taken (the breakout trigger) and where it is wrong (the opposite trigger). */
  entry: number;
  stop: number;
  /** Vertical count: boxes in the breakout column when it broke x reversal x box, from its bottom (up) / top (down). */
  target: number;
  /** Reward to risk of entry -> target against entry -> stop. */
  rr: number;
}

export interface PnfTriangle {
  startCol: number;
  endCol: number;
  nCols: number;
  state: TriangleState;
  /** The Double Top Buy trigger: one box above the top glyph of the triangle's last X column. */
  buyAbove: number;
  /** The Double Bottom Sell trigger: one box below the bottom glyph of the triangle's last O column. */
  sellBelow: number;
  breakout?: TriangleBreakout;
}

const EPS = 1e-9;

/** `b` sits inside `a`: no higher, no lower, and strictly smaller. */
export const nested = (a: PnfColumn, b: PnfColumn) =>
  b.low >= a.low - EPS && b.high <= a.high + EPS && b.high - b.low < a.high - a.low - EPS;

/** Every triangle of at least `minCols` columns in the CONFIRMED columns, oldest first. */
export function detectTriangles(columns: PnfColumn[], signals: PnfSignal[], box: number, reversal: number, minCols = 3): PnfTriangle[] {
  const out: PnfTriangle[] = [];
  if (!(box > 0)) return out;
  const need = Math.max(2, Math.floor(minCols));
  let s = 0;
  while (s < columns.length) {
    let e = s;
    while (e + 1 < columns.length && nested(columns[e], columns[e + 1])) e++;
    const n = e - s + 1;
    if (n >= need) {
      let lastX = -1, lastO = -1;
      for (let i = s; i <= e; i++) { if (columns[i].dir === 'X') lastX = i; else lastO = i; }
      if (lastX >= 0 && lastO >= 0) {
        const buyAbove = columns[lastX].high + box / 2;      // the column's top edge is half a box above its top glyph
        const sellBelow = columns[lastO].low - box / 2;
        const tri: PnfTriangle = { startCol: s, endCol: e, nCols: n, state: 'ended', buyAbove, sellBelow };
        if (e === columns.length - 1) tri.state = 'forming';
        else {
          const next = e + 1;
          const sig = signals.find(g => g.col === next);
          if (sig) {
            const up = sig.kind === 'DOUBLE_TOP_BUY';
            const c = columns[next];
            const drawn = c.boxBars.filter(b => b <= sig.bar).length;              // boxes the column had when it broke out
            const count = Math.max(1, drawn) * reversal * box;
            const entry = up ? buyAbove : sellBelow;
            const stop = up ? sellBelow : buyAbove;
            const target = up ? c.low + box / 2 + count : c.high - box / 2 - count;
            const risk = Math.abs(entry - stop);
            tri.state = up ? 'up' : 'down';
            tri.breakout = { side: up ? 'UP' : 'DOWN', col: next, bar: sig.bar, t: sig.t, entry, stop, target, rr: risk > 0 ? Math.abs(target - entry) / risk : 0 };
          }
        }
        out.push(tri);
      }
    }
    s = e + 1;
  }
  return out;
}

/** Breakouts newer than the watermark (the last closed bar already evaluated): the alert rule of lib/straddlePnfLive.ts newSignalsAfter. */
export function newTriangleBreakouts(triangles: PnfTriangle[], watermarkT: number): (PnfTriangle & { breakout: TriangleBreakout })[] {
  return triangles.filter((t): t is PnfTriangle & { breakout: TriangleBreakout } => !!t.breakout && t.breakout.t > watermarkT);
}
