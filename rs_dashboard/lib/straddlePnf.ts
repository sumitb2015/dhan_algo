// Point & Figure engine for straddle charts. Pure: no I/O, no clocks (time arrives in the bars).
//
// Construction is close-based on 1-min straddle closes (CE + PE). The box is a fixed % of the first usable price and the
// grid is anchored on that price; a level is the number of whole boxes the price sits from the anchor, truncated toward
// zero, so a one-box move prints exactly one X or O in either direction. A column reverses only after `reversal` boxes
// against its extreme (3-box reversal = 1.5% at the default 0.5% box).

export type Bar = { t: number; ce: number; pe: number; straddle: number; vol: number };

export type PnfColumn = {
  dir: 'X' | 'O';
  /** Bottom and top edge of the column in price. */
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

type Work = { dir: 'X' | 'O'; lo: number; hi: number; startBar: number; endBar: number; breakBar: number | null };

export function buildPnf(bars: Bar[], boxPct = 0.005, reversal = 3): { box: number; columns: PnfColumn[] } {
  const first = bars.find(b => b.straddle > 0);
  if (!first) return { box: 0, columns: [] };
  const anchor = first.straddle;
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
    const lvl = Math.trunc(x + Math.sign(x) * EPS);
    const cur = work[work.length - 1];
    if (!cur) {
      if (lvl >= 1) work.push({ dir: 'X', lo: 1, hi: lvl, startBar: i, endBar: i, breakBar: null });
      else if (lvl <= -1) work.push({ dir: 'O', lo: lvl, hi: -1, startBar: i, endBar: i, breakBar: null });
      return;
    }
    if (cur.dir === 'X') {
      if (lvl > cur.hi) { cur.hi = lvl; cur.endBar = i; markBreak(cur, i); }
      else if (lvl <= cur.hi - reversal) {
        work.push({ dir: 'O', lo: lvl, hi: cur.hi - 1, startBar: i, endBar: i, breakBar: null });
        markBreak(work[work.length - 1], i);
      }
    } else if (lvl < cur.lo) { cur.lo = lvl; cur.endBar = i; markBreak(cur, i); }
    else if (lvl >= cur.lo + reversal) {
      work.push({ dir: 'X', lo: cur.lo + 1, hi: lvl, startBar: i, endBar: i, breakBar: null });
      markBreak(work[work.length - 1], i);
    }
  });

  const columns = work.map<PnfColumn>(c => ({
    dir: c.dir,
    low: anchor + c.lo * box,
    high: anchor + (c.hi + 1) * box,
    boxes: c.hi - c.lo + 1,
    startBar: c.startBar,
    endBar: c.endBar,
    session: sessionOf(bars[c.startBar].t),
    breakBar: c.breakBar,
  }));
  return { box, columns };
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

/** Cumulative VWAP of the straddle over the loaded range; cumulative mean while no volume has traded. */
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
