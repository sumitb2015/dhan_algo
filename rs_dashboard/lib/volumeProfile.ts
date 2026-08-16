/**
 * Volume-profile and footprint math.
 *
 * IMPORTANT — the buy/sell split is DERIVED, not observed. Dhan serves no bid/ask tick
 * history, so there is no way to know which side of the spread a trade hit. Two estimators
 * are offered, both of which conserve total volume exactly:
 *
 *   geometric — model each candle's price path (o→l→h→c for an up bar, o→h→l→c for a down
 *               bar), attribute each leg's share of volume to buying or selling by its
 *               direction, and spread it uniformly over the ticks the leg traverses.
 *   intrabar  — treat every constituent 1-minute bar as one print: its whole volume is
 *               buying or selling by its own direction, spread over its own range.
 *
 * Both are approximations of a true footprint. Any UI built on this must say so.
 *
 * Everything here is pure and framework-free so it can be unit-tested with node:test and
 * run client-side — which is the point: every slider in the UI re-derives these values
 * without a refetch.
 */

export interface Bar {
  /** IST-naive "YYYY-MM-DD HH:MM:SS". Never parse with `new Date` — see resampleBars. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type VolumeEngine = 'geometric' | 'intrabar';

export interface FootprintCell {
  price: number;
  buy: number;
  sell: number;
  total: number;
  /** Buy at this price dominates sell one tick below by at least `imbalancePct`. */
  buyImb: boolean;
  /** Sell at this price dominates buy one tick above by at least `imbalancePct`. */
  sellImb: boolean;
}

export interface FootprintColumn extends Bar {
  cells: FootprintCell[];
  /** Volume-weighted levels for this column alone. */
  poc: number;
  vah: number;
  val: number;
  buy: number;
  sell: number;
  delta: number;
}

export interface ValueArea {
  poc: number;
  vah: number;
  val: number;
  total: number;
}

export interface ProfileRow {
  price: number;
  buy: number;
  sell: number;
  total: number;
}

/** NSE continuous session opens at 09:15 = 555 minutes past midnight. */
export const SESSION_START_MIN = 9 * 60 + 15;

/**
 * A single column is capped at this many tick rows. A 0.05 tick on a 24,000 index across
 * a wide 60-minute bar would otherwise expand to tens of thousands of rows per column and
 * stall the main thread. When the cap binds, the tick size is coarsened for computation
 * and reported back so the UI can say what it actually used.
 */
const MAX_TICKS_PER_COLUMN = 4000;

// ─────────────────────────────────────────────────────────────────────────────
// Resampling
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Aggregate 1-minute bars onto the NSE grid anchored at 09:15.
 *
 * Timestamps are parsed as literal strings, not via `new Date`: the whole intraday store
 * is IST-naive, so constructing a Date reinterprets the stamp in the server's timezone
 * and `toISOString()` shifts it again — that rendered the 09:15 open as 06:25.
 *
 * Buckets are anchored to the session open rather than to midnight. For 5m and 15m the
 * two agree (555 divides evenly), but for 30m and 60m only the session anchor puts a
 * boundary at 09:15, which is where every Indian charting platform places it.
 */
export function resampleBars(bars: Bar[], minutes: number): Bar[] {
  if (minutes <= 1) return bars;
  const pad = (n: number) => String(n).padStart(2, '0');
  const buckets = new Map<string, Bar>();

  for (const b of bars) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(b.t);
    if (!m) continue;
    const [, day, hh, mm] = m;

    const mins = Number(hh) * 60 + Number(mm);
    const offset = mins - SESSION_START_MIN;
    // Pre-open prints (should not survive the session filter) collapse into the first bucket.
    const floored =
      offset < 0 ? SESSION_START_MIN : SESSION_START_MIN + Math.floor(offset / minutes) * minutes;
    const key = `${day} ${pad(Math.floor(floored / 60))}:${pad(floored % 60)}:00`;

    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { ...b, t: key });
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
      cur.v += b.v;
    }
  }
  // Keys are fixed-width and chronological, so lexical order is time order.
  return [...buckets.keys()].sort().map((k) => buckets.get(k)!);
}

/** Group 1-minute bars by the higher-timeframe bucket they belong to. */
export function groupByBucket(bars: Bar[], minutes: number): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  if (minutes <= 1) {
    for (const b of bars) out.set(b.t, [b]);
    return out;
  }
  const pad = (n: number) => String(n).padStart(2, '0');
  for (const b of bars) {
    const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/.exec(b.t);
    if (!m) continue;
    const [, day, hh, mm] = m;
    const mins = Number(hh) * 60 + Number(mm);
    const offset = mins - SESSION_START_MIN;
    const floored =
      offset < 0 ? SESSION_START_MIN : SESSION_START_MIN + Math.floor(offset / minutes) * minutes;
    const key = `${day} ${pad(Math.floor(floored / 60))}:${pad(floored % 60)}:00`;
    const arr = out.get(key);
    if (arr) arr.push(b);
    else out.set(key, [b]);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Volume splitting
// ─────────────────────────────────────────────────────────────────────────────

/** Accumulator keyed by integer tick index, so neighbour lookups (P ± 1 tick) are exact. */
type TickMap = Map<number, { buy: number; sell: number }>;

function bump(map: TickMap, tick: number, buy: number, sell: number) {
  const cur = map.get(tick);
  if (cur) {
    cur.buy += buy;
    cur.sell += sell;
  } else {
    map.set(tick, { buy, sell });
  }
}

/** Spread `volume` uniformly over every tick between two prices, inclusive. */
function spread(map: TickMap, fromTick: number, toTick: number, volume: number, isBuy: boolean) {
  if (volume <= 0) return;
  const lo = Math.min(fromTick, toTick);
  const hi = Math.max(fromTick, toTick);
  const n = hi - lo + 1;
  const per = volume / n;
  for (let t = lo; t <= hi; t++) bump(map, t, isBuy ? per : 0, isBuy ? 0 : per);
}

/**
 * Attribute one candle's volume by modelling the path price must have taken.
 *
 * An up candle is assumed to travel o→l→h→c, a down candle o→h→l→c. Each leg gets volume
 * in proportion to its length and is entirely buying or selling by its direction. The leg
 * weights sum to 1, so total volume is conserved exactly.
 */
export function splitGeometric(bar: Bar, tickSize: number, map: TickMap) {
  const { o, h, l, c, v } = bar;
  if (v <= 0) return;
  const tick = (p: number) => Math.round(p / tickSize);

  if (h <= l) {
    // Flat bar: no path to model, direction decides. A true doji splits evenly.
    if (c > o) bump(map, tick(c), v, 0);
    else if (c < o) bump(map, tick(c), 0, v);
    else bump(map, tick(c), v / 2, v / 2);
    return;
  }

  const up = c >= o;
  const legs: { from: number; to: number; len: number; buy: boolean }[] = up
    ? [
        { from: o, to: l, len: o - l, buy: false },
        { from: l, to: h, len: h - l, buy: true },
        { from: h, to: c, len: h - c, buy: false },
      ]
    : [
        { from: o, to: h, len: h - o, buy: true },
        { from: h, to: l, len: h - l, buy: false },
        { from: l, to: c, len: c - l, buy: true },
      ];

  const totalLen = legs.reduce((s, leg) => s + leg.len, 0);
  if (totalLen <= 0) {
    bump(map, tick(c), v / 2, v / 2);
    return;
  }
  for (const leg of legs) {
    if (leg.len <= 0) continue;
    spread(map, tick(leg.from), tick(leg.to), (v * leg.len) / totalLen, leg.buy);
  }
}

/**
 * Attribute a 1-minute print wholly to one side by its own direction, spread over its own
 * range. `prevClose` breaks the tie on a flat print using the uptick rule.
 */
export function splitIntrabarPrint(
  bar: Bar,
  prevClose: number | null,
  tickSize: number,
  map: TickMap,
) {
  const { o, h, l, c, v } = bar;
  if (v <= 0) return;
  const tick = (p: number) => Math.round(p / tickSize);

  let dir = c > o ? 1 : c < o ? -1 : 0;
  if (dir === 0 && prevClose !== null) dir = c > prevClose ? 1 : c < prevClose ? -1 : 0;

  if (dir === 0) {
    spread(map, tick(l), tick(h), v / 2, true);
    spread(map, tick(l), tick(h), v / 2, false);
    return;
  }
  spread(map, tick(l), tick(h), v, dir > 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Value area
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Classic value area: start at the point of control and expand outward, at each step
 * taking whichever side's next two rows hold more volume, until `pct` of total volume is
 * enclosed. Rows must be sorted ascending by price.
 */
export function valueArea(rows: ProfileRow[], pct: number): ValueArea {
  if (rows.length === 0) return { poc: 0, vah: 0, val: 0, total: 0 };

  const total = rows.reduce((s, r) => s + r.total, 0);
  let pocIdx = 0;
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].total > rows[pocIdx].total) pocIdx = i;
  }
  const poc = rows[pocIdx].price;
  if (total <= 0) return { poc, vah: poc, val: poc, total: 0 };

  const target = (total * Math.min(Math.max(pct, 1), 100)) / 100;
  let cum = rows[pocIdx].total;
  let up = pocIdx + 1;
  let down = pocIdx - 1;

  const pairAt = (start: number, step: number) => {
    let sum = 0;
    for (let k = 0; k < 2; k++) {
      const i = start + k * step;
      if (i >= 0 && i < rows.length) sum += rows[i].total;
    }
    return sum;
  };

  while (cum < target && (up < rows.length || down >= 0)) {
    const upSum = up < rows.length ? pairAt(up, 1) : -1;
    const downSum = down >= 0 ? pairAt(down, -1) : -1;
    if (upSum >= downSum) {
      for (let k = 0; k < 2 && up < rows.length && cum < target; k++, up++) cum += rows[up].total;
    } else {
      for (let k = 0; k < 2 && down >= 0 && cum < target; k++, down--) cum += rows[down].total;
    }
  }

  const vahIdx = Math.min(up - 1 < pocIdx ? pocIdx : up - 1, rows.length - 1);
  const valIdx = Math.max(down + 1 > pocIdx ? pocIdx : down + 1, 0);
  return { poc, vah: rows[vahIdx].price, val: rows[valIdx].price, total };
}

// ─────────────────────────────────────────────────────────────────────────────
// Footprint construction
// ─────────────────────────────────────────────────────────────────────────────

export interface FootprintOptions {
  tfMinutes: number;
  tickSize: number;
  engine: VolumeEngine;
  valueAreaPct: number;
  imbalancePct: number;
  /** A cell must hold this multiple of the column's median cell volume to flag as an
   *  imbalance — without it every thinly-traded row at the extremes flags. */
  volumeConcentration: number;
  /** Build full cells only for the last N columns; earlier columns are returned as bars
   *  with no cells. Expanding every column of a 5-session load is pure waste. */
  columnLimit?: number;
}

export interface FootprintResult {
  columns: FootprintColumn[];
  /** May exceed the requested tick size when MAX_TICKS_PER_COLUMN binds. */
  effectiveTickSize: number;
  coarsened: boolean;
}

/** Flag diagonal imbalances: buy at P vs sell one tick below, sell at P vs buy one tick above. */
export function markImbalances(
  cells: FootprintCell[],
  tickSize: number,
  imbalancePct: number,
  volumeConcentration: number,
): void {
  if (cells.length === 0) return;

  const nonZero = cells.map((c) => c.total).filter((t) => t > 0).sort((a, b) => a - b);
  const median = nonZero.length ? nonZero[Math.floor(nonZero.length / 2)] : 0;
  const floorVol = median * Math.max(volumeConcentration, 0);
  const ratio = imbalancePct / 100;

  // Cells are ascending by price and gap-free, so index ±1 is exactly one tick away.
  const half = tickSize / 2;
  for (let i = 0; i < cells.length; i++) {
    const cell = cells[i];
    const below = i > 0 && Math.abs(cells[i - 1].price + tickSize - cell.price) < half ? cells[i - 1] : null;
    const above = i < cells.length - 1 && Math.abs(cells[i + 1].price - tickSize - cell.price) < half ? cells[i + 1] : null;

    if (below && cell.buy >= floorVol && cell.buy > 0) {
      cell.buyImb = below.sell === 0 ? true : cell.buy >= below.sell * ratio;
    }
    if (above && cell.sell >= floorVol && cell.sell > 0) {
      cell.sellImb = above.buy === 0 ? true : cell.sell >= above.buy * ratio;
    }
  }
}

/** Build footprint columns from 1-minute bars. */
export function buildFootprint(bars1m: Bar[], opts: FootprintOptions): FootprintResult {
  const grouped = groupByBucket(bars1m, opts.tfMinutes);
  const keys = [...grouped.keys()].sort();
  const limit = opts.columnLimit ?? keys.length;
  const detailedFrom = Math.max(0, keys.length - limit);

  // Coarsen once, globally, so every column shares a tick grid — otherwise the table's
  // price rows would not line up across columns.
  let tickSize = opts.tickSize;
  let coarsened = false;
  for (let i = detailedFrom; i < keys.length; i++) {
    const members = grouped.get(keys[i])!;
    let hi = -Infinity;
    let lo = Infinity;
    for (const m of members) {
      if (m.h > hi) hi = m.h;
      if (m.l < lo) lo = m.l;
    }
    const span = (hi - lo) / tickSize;
    if (span > MAX_TICKS_PER_COLUMN) {
      tickSize = (hi - lo) / MAX_TICKS_PER_COLUMN;
      coarsened = true;
    }
  }

  const columns: FootprintColumn[] = [];
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const members = grouped.get(key)!;

    const bar: Bar = {
      t: key,
      o: members[0].o,
      h: Math.max(...members.map((m) => m.h)),
      l: Math.min(...members.map((m) => m.l)),
      c: members[members.length - 1].c,
      v: members.reduce((s, m) => s + m.v, 0),
    };

    if (i < detailedFrom) {
      columns.push({ ...bar, cells: [], poc: bar.c, vah: bar.h, val: bar.l, buy: 0, sell: 0, delta: 0 });
      continue;
    }

    const map: TickMap = new Map();
    if (opts.engine === 'geometric') {
      // The higher-timeframe candle as a whole, not its parts — that is what makes this
      // estimator differ from intrabar at timeframes above 1 minute.
      splitGeometric(bar, tickSize, map);
    } else {
      let prevClose: number | null = null;
      for (const m of members) {
        splitIntrabarPrint(m, prevClose, tickSize, map);
        prevClose = m.c;
      }
    }

    // Emit a gap-free ascending tick ladder so the ±1-tick neighbour test is index-local.
    const ticks = [...map.keys()];
    const loTick = Math.min(...ticks);
    const hiTick = Math.max(...ticks);
    const cells: FootprintCell[] = [];
    for (let t = loTick; t <= hiTick; t++) {
      const e = map.get(t);
      const buy = e?.buy ?? 0;
      const sell = e?.sell ?? 0;
      cells.push({ price: t * tickSize, buy, sell, total: buy + sell, buyImb: false, sellImb: false });
    }

    markImbalances(cells, tickSize, opts.imbalancePct, opts.volumeConcentration);

    const va = valueArea(cells, opts.valueAreaPct);
    const buy = cells.reduce((s, c) => s + c.buy, 0);
    const sell = cells.reduce((s, c) => s + c.sell, 0);
    columns.push({ ...bar, cells, poc: va.poc, vah: va.vah, val: va.val, buy, sell, delta: buy - sell });
  }

  return { columns, effectiveTickSize: tickSize, coarsened };
}

// ─────────────────────────────────────────────────────────────────────────────
// Aggregate statistics
// ─────────────────────────────────────────────────────────────────────────────

export interface WindowStats extends ValueArea {
  volume: number;
  buy: number;
  sell: number;
  delta: number;
  rows: ProfileRow[];
}

/** Merge the last `windowBars` columns' cells into one profile. */
export function windowStats(
  columns: FootprintColumn[],
  windowBars: number,
  valueAreaPct: number,
): WindowStats {
  const slice = columns.slice(-Math.max(1, windowBars)).filter((c) => c.cells.length > 0);
  const merged = new Map<number, ProfileRow>();

  for (const col of slice) {
    for (const cell of col.cells) {
      if (cell.total <= 0) continue;
      const key = cell.price;
      const cur = merged.get(key);
      if (cur) {
        cur.buy += cell.buy;
        cur.sell += cell.sell;
        cur.total += cell.total;
      } else {
        merged.set(key, { price: key, buy: cell.buy, sell: cell.sell, total: cell.total });
      }
    }
  }

  const rows = [...merged.values()].sort((a, b) => a.price - b.price);
  const va = valueArea(rows, valueAreaPct);
  const buy = rows.reduce((s, r) => s + r.buy, 0);
  const sell = rows.reduce((s, r) => s + r.sell, 0);
  return { ...va, volume: buy + sell, buy, sell, delta: buy - sell, rows };
}

export interface ChartProfile extends ValueArea {
  rows: ProfileRow[];
  binSize: number;
}

/**
 * The chart-side profile over the last `profilePeriod` bars, binned to `resolution` price
 * levels. Binned directly from bar geometry rather than from footprint cells — at chart
 * scale the tick ladder is both unnecessary and expensive.
 */
export function chartProfile(
  bars1m: Bar[],
  opts: { tfMinutes: number; profilePeriod: number; resolution: number; engine: VolumeEngine; valueAreaPct: number },
): ChartProfile {
  const grouped = groupByBucket(bars1m, opts.tfMinutes);
  const keys = [...grouped.keys()].sort().slice(-Math.max(1, opts.profilePeriod));
  const members = keys.flatMap((k) => grouped.get(k)!);
  if (members.length === 0) return { poc: 0, vah: 0, val: 0, total: 0, rows: [], binSize: 0 };

  let hi = -Infinity;
  let lo = Infinity;
  for (const m of members) {
    if (m.h > hi) hi = m.h;
    if (m.l < lo) lo = m.l;
  }
  const bins = Math.max(2, Math.min(opts.resolution, 1000));
  const binSize = (hi - lo) / bins || 1;

  const map: TickMap = new Map();
  if (opts.engine === 'geometric') {
    for (const k of keys) {
      const grp = grouped.get(k)!;
      const bar: Bar = {
        t: k,
        o: grp[0].o,
        h: Math.max(...grp.map((m) => m.h)),
        l: Math.min(...grp.map((m) => m.l)),
        c: grp[grp.length - 1].c,
        v: grp.reduce((s, m) => s + m.v, 0),
      };
      splitGeometric(bar, binSize, map);
    }
  } else {
    let prevClose: number | null = null;
    for (const m of members) {
      splitIntrabarPrint(m, prevClose, binSize, map);
      prevClose = m.c;
    }
  }

  const rows: ProfileRow[] = [...map.entries()]
    .map(([tick, e]) => ({ price: tick * binSize, buy: e.buy, sell: e.sell, total: e.buy + e.sell }))
    .sort((a, b) => a.price - b.price);

  return { ...valueArea(rows, opts.valueAreaPct), rows, binSize };
}

export interface Balance {
  /** Share of the recent window's volume that traded inside the chart value area, 0–1. */
  ovl: number;
  balanced: boolean;
  /** Signed distance of the window POC from the chart value-area centre, as a % of its width. */
  tiltPct: number;
}

/**
 * How well the short window agrees with the broader chart profile. A window whose volume
 * sits mostly inside the chart value area, with its POC near that area's centre, is
 * balanced; a window pushing out of it is not.
 */
export function balance(win: WindowStats, chart: ChartProfile, balanceTiltPct: number): Balance {
  if (win.rows.length === 0 || win.volume <= 0 || chart.vah <= chart.val) {
    return { ovl: 0, balanced: false, tiltPct: 0 };
  }
  const inside = win.rows
    .filter((r) => r.price >= chart.val && r.price <= chart.vah)
    .reduce((s, r) => s + r.total, 0);
  const ovl = inside / win.volume;

  const centre = (chart.vah + chart.val) / 2;
  const halfWidth = (chart.vah - chart.val) / 2;
  const tiltPct = halfWidth > 0 ? ((win.poc - centre) / halfWidth) * 100 : 0;

  return { ovl, balanced: Math.abs(tiltPct) <= balanceTiltPct, tiltPct };
}

export interface Residual {
  ppm: number;
  exact: boolean;
}

/**
 * Conservation check on the volume split: every unit of source volume must reappear in the
 * cells. A non-zero residual means the estimator lost or invented volume, which would make
 * every downstream figure quietly wrong — so it is surfaced, not assumed.
 */
export function residual(columns: FootprintColumn[], tolerancePpm: number): Residual {
  const detailed = columns.filter((c) => c.cells.length > 0);
  const source = detailed.reduce((s, c) => s + c.v, 0);
  const split = detailed.reduce((s, c) => s + c.buy + c.sell, 0);
  if (source <= 0) return { ppm: 0, exact: true };
  const ppm = (Math.abs(source - split) / source) * 1_000_000;
  return { ppm, exact: ppm <= tolerancePpm };
}

/** Tick sizes offered by `suggestTickSize`, chosen to read as round numbers on a price axis. */
export const TICK_LADDER = [0.05, 0.1, 0.25, 0.5, 1, 2, 2.5, 5, 10, 25, 50, 100];

/**
 * A tick size that puts roughly `targetRows` rows inside a typical bar.
 *
 * NSE's actual tick is ₹0.05 for everything, which is the honest exchange tick but a poor
 * display tick: a ₹3000 stock moves several rupees a minute, so a 0.05 ladder puts ~99% of
 * the bar's volume outside any reasonable on-screen window. Sized off the MEDIAN bar range
 * rather than the mean so one climax bar cannot blow the ladder out.
 */
export function suggestTickSize(bars: Bar[], tfMinutes: number, targetRows = 20): number {
  const tf = resampleBars(bars, tfMinutes);
  const ranges = tf.map((b) => b.h - b.l).filter((r) => r > 0).sort((a, b) => a - b);
  if (ranges.length === 0) return TICK_LADDER[0];

  const median = ranges[Math.floor(ranges.length / 2)];
  const ideal = median / Math.max(targetRows, 1);
  return TICK_LADDER.find((t) => t >= ideal) ?? TICK_LADDER[TICK_LADDER.length - 1];
}

/** The tick rows to render: `ticks` above and below the anchor price, gap-free. */
export function priceWindow(
  columns: FootprintColumn[],
  anchorPrice: number,
  tickSize: number,
  ticks: number,
): number[] {
  if (columns.length === 0) return [];
  const anchorTick = Math.round(anchorPrice / tickSize);
  const out: number[] = [];
  for (let t = anchorTick + ticks; t >= anchorTick - ticks; t--) out.push(t * tickSize);
  return out;
}
