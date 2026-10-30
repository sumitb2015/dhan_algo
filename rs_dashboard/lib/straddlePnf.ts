// Point & Figure engine for straddle charts. Pure: no I/O, no clocks (time arrives in the bars).
//
// Construction is close-based on 1-min straddle closes (CE + PE), the usual close-only P&F rules. The box is a fixed % of the
// first usable price and the grid is anchored on it: box k is the price label anchor + k*box, and glyph cells are centred on
// their label. An X is plotted for every label the close has reached from below (k = floor(x)), an O for every label it has
// reached from above (k = ceil(x)), with x = (close - anchor) / box. A column reverses only when the close is `reversal` full
// boxes from the column's last label (3 boxes = 1.5% at the default 0.5% box), measured with the rounding of the new
// direction, so a 2.1-box move never reverses. The first column starts once the close is a full box from the anchor
// (X: labels 1..k, O: labels -1..k).

export type Bar = {
  t: number; ce: number; pe: number; straddle: number; vol: number;
  /** Live bars only: the feed's cumulative day volume (CE + PE) at the latest tick, and its value when this bar's volume started counting. */
  cum?: number; cumBase?: number;
};

export type PnfColumn = {
  dir: 'X' | 'O';
  /** Bottom and top edge of the column's glyph cells in price (cells are centred on their box label). */
  low: number;
  high: number;
  boxes: number;
  /** Indexes into the `bars` array handed to buildPnf. */
  startBar: number;
  endBar: number;
  /** IST YYYY-MM-DD of the bar that opened the column. */
  session: string;
  /** First bar where this column passed the previous same-direction column's extreme (X above its top, O below its bottom); null if it never did. */
  breakBar: number | null;
  /** For each glyph, bottom to top (k = 0 is the lowest box): the index of the bar that drew it. */
  boxBars: number[];
};

export type PnfSignal = {
  id: string;
  kind: 'DOUBLE_TOP_BUY' | 'DOUBLE_BOTTOM_SELL';
  col: number;
  bar: number;
  t: number;
  price: number;
  belowVwap: boolean;
};

const IST_OFFSET_S = 5.5 * 3600;
const EPS = 1e-9;

export function sessionOf(t: number): string {
  return new Date((t + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
}

/** `drawn` maps each box label to the bar that first plotted it. */
type Work = { dir: 'X' | 'O'; lo: number; hi: number; startBar: number; endBar: number; breakBar: number | null; drawn: Map<number, number> };

const drawnRange = (from: number, to: number, bar: number, into = new Map<number, number>()) => {
  for (let k = from; k <= to; k++) if (!into.has(k)) into.set(k, bar);
  return into;
};

/**
 * `anchorPrice` overrides the price the grid and the box are anchored on (default: the first usable close). The page passes the
 * first 1-minute price so that changing the chart interval regroups the bars without moving the grid or resizing the box.
 */
export function buildPnf(bars: Bar[], boxPct = 0.005, reversal = 3, anchorPrice?: number): { anchor: number; box: number; columns: PnfColumn[] } {
  const first = bars.find(b => b.straddle > 0);
  if (!first) return { anchor: 0, box: 0, columns: [] };
  const anchor = anchorPrice !== undefined && anchorPrice > 0 ? anchorPrice : first.straddle;
  const box = anchor * boxPct;
  const work: Work[] = [];

  const markBreak = (c: Work, i: number) => {
    if (c.breakBar !== null || work.length < 3) return;
    const prev = work[work.length - 3]; // same direction, two columns back (the last element is `c`)
    if (c.dir === 'X' ? c.hi > prev.hi : c.lo < prev.lo) c.breakBar = i;
  };

  bars.forEach((b, i) => {
    if (!(b.straddle > 0)) return;
    const x = (b.straddle - anchor) / box;
    const up = Math.floor(x + EPS);   // highest label the close has reached from below
    const down = Math.ceil(x - EPS);  // lowest label the close has reached from above
    const cur = work[work.length - 1];
    if (!cur) {
      if (up >= 1) work.push({ dir: 'X', lo: 1, hi: up, startBar: i, endBar: i, breakBar: null, drawn: drawnRange(1, up, i) });
      else if (down <= -1) work.push({ dir: 'O', lo: down, hi: -1, startBar: i, endBar: i, breakBar: null, drawn: drawnRange(down, -1, i) });
      return;
    }
    if (cur.dir === 'X') {
      if (up > cur.hi) { drawnRange(cur.hi + 1, up, i, cur.drawn); cur.hi = up; cur.endBar = i; markBreak(cur, i); }
      else if (down <= cur.hi - reversal) {
        work.push({ dir: 'O', lo: down, hi: cur.hi - 1, startBar: i, endBar: i, breakBar: null, drawn: drawnRange(down, cur.hi - 1, i) });
        markBreak(work[work.length - 1], i);
      }
    } else if (down < cur.lo) { drawnRange(down, cur.lo - 1, i, cur.drawn); cur.lo = down; cur.endBar = i; markBreak(cur, i); }
    else if (up >= cur.lo + reversal) {
      work.push({ dir: 'X', lo: cur.lo + 1, hi: up, startBar: i, endBar: i, breakBar: null, drawn: drawnRange(cur.lo + 1, up, i) });
      markBreak(work[work.length - 1], i);
    }
  });

  const columns = work.map<PnfColumn>(c => ({
    dir: c.dir,
    low: anchor + (c.lo - 0.5) * box,
    high: anchor + (c.hi + 0.5) * box,
    boxes: c.hi - c.lo + 1,
    startBar: c.startBar,
    endBar: c.endBar,
    session: sessionOf(bars[c.startBar].t),
    breakBar: c.breakBar,
    boxBars: Array.from({ length: c.hi - c.lo + 1 }, (_, k) => c.drawn.get(c.lo + k) as number),
  }));
  return { anchor, box, columns };
}

export function detectSignals(columns: PnfColumn[], bars: Bar[], vwapSeries: (number | null)[]): PnfSignal[] {
  const out: PnfSignal[] = [];
  columns.forEach((c, col) => {
    if (c.breakBar === null) return;
    const kind = c.dir === 'X' ? 'DOUBLE_TOP_BUY' : 'DOUBLE_BOTTOM_SELL';
    const price = bars[c.breakBar].straddle;
    const v = vwapSeries[c.breakBar];
    out.push({ id: `${kind}:${col}`, kind, col, bar: c.breakBar, t: bars[c.breakBar].t, price, belowVwap: v != null && price < v });
  });
  return out.sort((a, b) => a.bar - b.bar || a.col - b.col);
}

/**
 * Cumulative VWAP of the straddle over the whole loaded range (it does not reset each morning: a point & figure chart has no time
 * axis, and the previous days keep weighting it); cumulative mean while no volume has traded.
 */
export function vwap(bars: Bar[]): (number | null)[] {
  let sumPV = 0, sumV = 0, sumP = 0, n = 0;
  let last: number | null = null;
  return bars.map(b => {
    if (b.straddle > 0) {
      sumPV += b.straddle * b.vol; sumV += b.vol; sumP += b.straddle; n += 1;
      last = sumV > 0 ? sumPV / sumV : sumP / n;
    }
    return last;
  });
}

export function sma(values: number[], n = 10): (number | null)[] {
  let sum = 0;
  return values.map((v, i) => {
    sum += v;
    if (i >= n) sum -= values[i - n];
    return i >= n - 1 ? sum / n : null;
  });
}

/** For each green X column: the first bar inside it that trades above VWAP (the video's exit cue). */
export function exitTags(columns: PnfColumn[], bars: Bar[], vwapSeries: (number | null)[]): { col: number; bar: number }[] {
  const tags: { col: number; bar: number }[] = [];
  columns.forEach((c, col) => {
    if (c.dir !== 'X') return;
    for (let i = c.startBar; i <= c.endBar; i++) {
      const v = vwapSeries[i];
      if (v != null && bars[i].straddle > v) { tags.push({ col, bar: i }); break; }
    }
  });
  return tags;
}
