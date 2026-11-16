/**
 * Market Profile (TPO) maths — pure, framework-free, unit-tested with node:test.
 *
 * A profile is built from 1-minute bars:
 *   - the session is cut into fixed periods (30 min by default) anchored at the 09:15 open,
 *     each with its own letter (A, B, C …);
 *   - a period prints its letter on every price row between its low and its high;
 *   - the rows, read sideways, are the distribution of TIME at price.
 *
 * Everything is derived from the bars on the client so every control (row size, period,
 * value-area %) recomputes without a refetch. Bar timestamps are IST-naive strings and are
 * parsed as text, never with `new Date` (see lib/volumeProfile.ts resampleBars).
 *
 * Classification rules (day type, power degree) follow the course the page was built
 * from; their thresholds are heuristics, named below, and documented in
 * docs/MARKET_PROFILE_GUIDE.md. They are labels to read the auction, not trading signals.
 */

import { expandValueArea, ladderStepAtLeast, stepForRanges, type Bar } from './volumeProfile.ts';

export type { Bar };

export const NSE_SESSION_START_MIN = 9 * 60 + 15;
export const NSE_SESSION_END_MIN = 15 * 60 + 30;

/** Day type: extension on one side of at most this many IB ranges is a Normal Variation day. */
export const NORMAL_VARIATION_MAX_EXT_IB = 2;
/** Day type: a one-sided extension of at least this many IB ranges, closing in the extreme, is a Trend day. */
export const TREND_MIN_EXT_IB = 1;
/** Day type: the close is "in the extreme" when it sits in this outer share of the day's range. */
export const EXTREME_CLOSE_SHARE = 0.25;
/** Day type: an IB narrower than this share of the recent average IB is "narrow" (Non-Trend day). */
export const NARROW_IB_RATIO = 0.75;
/** Recent sessions averaged for the IB comparison. */
export const IB_AVERAGE_SESSIONS = 10;
/** Statistical skew: TPOs on one side of the POC must exceed the other side by this share. */
export const SKEW_MIN_SHARE = 0.1;

export type ProfileKind = 'day' | 'week' | 'month';

export interface TpoOptions {
  /** Price height of one row. Must be > 0. */
  rowSize: number;
  /** Minutes per TPO period (default 30). */
  periodMin?: number;
  /** Value-area share in percent (default 70). */
  vaPct?: number;
  /** Periods that make up the initial balance (default: one hour's worth). */
  ibPeriods?: number;
  sessionStartMin?: number;
  sessionEndMin?: number;
  /**
   * Today's IST date. Only that session can still be developing; a past day that ended
   * early (half day, Muhurat, data gap) is final, not "developing".
   */
  today?: string;
}

export interface TpoRow {
  /** Bottom of the row's price bucket, a multiple of the row size. */
  price: number;
  /**
   * One entry per TPO printed on this row, in time order. For a day profile it is the
   * period index (0 = A); for a weekly / monthly composite it is the day index within the
   * composite (0 = first day), so a composite reads "which day spent time here".
   */
  marks: number[];
  /** 1-minute volume spread evenly over the rows each bar spans. 0 for indices. */
  volume: number;
}

export interface PeriodBar {
  /** Index of the period inside the session (0 = A). */
  index: number;
  letter: string;
  /** IST-naive start stamp of the period. */
  t: string;
  o: number;
  h: number;
  l: number;
  c: number;
}

export interface PriceRun {
  /** Lowest row price in the run. */
  from: number;
  /** Highest row price in the run. */
  to: number;
}

export interface Profile {
  key: string;
  kind: ProfileKind;
  /** First and last session date in the profile (equal for a day). */
  start: string;
  end: string;
  /** Session dates the profile covers, ascending. */
  days: string[];
  rowSize: number;
  /** Ascending by price, gap-free from low to high row. */
  rows: TpoRow[];
  periods: PeriodBar[];
  open: number;
  close: number;
  high: number;
  low: number;
  /** IST-naive stamp of the last bar. */
  lastBarT: string;
  /** True while the session has not reached its close (a day whose last bar is before the end). */
  developing: boolean;
  totalTpo: number;
  poc: number;
  vah: number;
  val: number;
  /** Volume point of control, or null when the instrument has no volume (indices). */
  vpoc: number | null;
  /** Initial balance — day profiles only. */
  ibHigh: number | null;
  ibLow: number | null;
  extUp: number;
  extDown: number;
  /** Dalton's TPO count: TPOs above / below the POC row, excluding the POC row and single-print tails. */
  tpoAbove: number;
  tpoBelow: number;
  /** Mid-profile single-print runs (count 1, at least two rows tall, not touching an extreme). */
  singlePrints: PriceRun[];
  sellingTail: PriceRun | null;
  buyingTail: PriceRun | null;
  /** Two or more TPOs on the extreme row: an auction that ended without rejection. */
  poorHigh: boolean;
  poorLow: boolean;
  /** Sum over periods of (higher high ? +1 : lower high ? −1 : 0) + same for lows. */
  rotationFactor: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Small helpers
// ─────────────────────────────────────────────────────────────────────────────

const STAMP_RE = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})/;

function parseStamp(t: string): { day: string; min: number } | null {
  const m = STAMP_RE.exec(t);
  if (!m) return null;
  return { day: m[1], min: Number(m[2]) * 60 + Number(m[3]) };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** A, B … Z, a, b … z, then wraps. Matches the convention of every TPO platform. */
export function tpoLetter(index: number): string {
  const i = ((index % 52) + 52) % 52;
  return i < 26 ? String.fromCharCode(65 + i) : String.fromCharCode(97 + i - 26);
}

/** Row index of a price. The epsilon keeps 24000 / 5 from landing on 4799.999… */
function rowIdx(price: number, rowSize: number): number {
  return Math.floor(price / rowSize + 1e-9);
}

/** Round a row price to the row-size's decimals so 0.1-sized rows print as 101.3, not 101.30000000000001. */
function rowPrice(idx: number, rowSize: number): number {
  const decimals = Math.min(6, Math.max(0, -Math.floor(Math.log10(rowSize)) + 2));
  return Number((idx * rowSize).toFixed(decimals));
}

/** ISO-8601 week key ("2026-W46") for a YYYY-MM-DD date, computed in UTC so no timezone leaks in. */
export function isoWeekKey(day: string): string {
  const [y, m, d] = day.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay() || 7; // Mon=1 … Sun=7
  date.setUTCDate(date.getUTCDate() + 4 - dow); // Thursday of this week decides the year
  const yearStart = Date.UTC(date.getUTCFullYear(), 0, 1);
  const week = Math.ceil(((date.getTime() - yearStart) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${pad2(week)}`;
}

/**
 * A display row size that puts roughly `targetRows` rows across a typical profile.
 * Sized from the MEDIAN range so one gap day cannot blow the ladder out.
 */
export function suggestRowSize(ranges: number[], targetRows = 40): number {
  return stepForRanges(ranges, targetRows);
}

/** Most rows one profile may span before the chart stops being drawable (a typo'd row size). */
export const MAX_ROWS_PER_PROFILE = 400;

/**
 * Smallest row size that keeps a profile of `maxRange` within MAX_ROWS_PER_PROFILE rows.
 * A manual row size below this is raised to it: 0.05 on a 1,500-pt monthly NIFTY profile
 * would be 30k rows and hundreds of thousands of canvas cells per frame.
 */
export function minRowSize(maxRange: number): number {
  return maxRange > 0 ? ladderStepAtLeast(maxRange / MAX_ROWS_PER_PROFILE) : 0;
}

/**
 * Bottom price of the row a price falls in, rounded the same way as every TpoRow.price, so
 * `row.price === rowFloor(x, rowSize)` is a safe equality test even for 0.05-sized rows.
 */
export function rowFloor(price: number, rowSize: number): number {
  return rowPrice(rowIdx(price, rowSize), rowSize);
}

/**
 * Top edge of the value area. `vah` is the bottom of the top value-area ROW (the level every
 * TPO platform prints), so the value area itself reaches one row higher. Price comparisons
 * against "above value" must use this, not `vah`.
 */
export function vaTop(p: Pick<Profile, 'vah' | 'rowSize'>): number {
  return p.vah + p.rowSize;
}

/** Session date → its 1-minute bars, in time order. Bars outside the session window are dropped. */
export function splitSessions(
  bars: Bar[],
  sessionStartMin = NSE_SESSION_START_MIN,
  sessionEndMin = NSE_SESSION_END_MIN,
): Map<string, Bar[]> {
  const out = new Map<string, Bar[]>();
  for (const b of bars) {
    const s = parseStamp(b.t);
    if (!s || s.min < sessionStartMin || s.min > sessionEndMin) continue;
    if (!(b.h >= b.l) || !Number.isFinite(b.h) || !Number.isFinite(b.l)) continue;
    let list = out.get(s.day);
    if (!list) out.set(s.day, (list = []));
    list.push(b);
  }
  for (const list of out.values()) list.sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return new Map([...out.entries()].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Cut one session's 1-minute bars into TPO periods anchored at the session open. */
export function sessionPeriods(
  dayBars: Bar[],
  periodMin = 30,
  sessionStartMin = NSE_SESSION_START_MIN,
): PeriodBar[] {
  const byIdx = new Map<number, PeriodBar>();
  for (const b of dayBars) {
    const s = parseStamp(b.t);
    if (!s) continue;
    const index = Math.max(0, Math.floor((s.min - sessionStartMin) / periodMin));
    const cur = byIdx.get(index);
    if (!cur) {
      const startMin = sessionStartMin + index * periodMin;
      byIdx.set(index, {
        index,
        letter: tpoLetter(index),
        t: `${s.day} ${pad2(Math.floor(startMin / 60))}:${pad2(startMin % 60)}:00`,
        o: b.o, h: b.h, l: b.l, c: b.c,
      });
    } else {
      cur.h = Math.max(cur.h, b.h);
      cur.l = Math.min(cur.l, b.l);
      cur.c = b.c;
    }
  }
  return [...byIdx.values()].sort((a, b) => a.index - b.index);
}

// ─────────────────────────────────────────────────────────────────────────────
// Profile statistics on a finished row set
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Point of control: the row with the most TPOs. A tie goes to the row nearest the middle
 * of the range — the CBOT convention — and a further tie to the lower row, so the answer
 * is deterministic.
 */
export function pocIndex(counts: number[]): number {
  if (counts.length === 0) return -1;
  const max = Math.max(...counts);
  const mid = (counts.length - 1) / 2;
  let best = -1;
  for (let i = 0; i < counts.length; i++) {
    if (counts[i] !== max) continue;
    if (best < 0 || Math.abs(i - mid) < Math.abs(best - mid)) best = i;
  }
  return best;
}

/**
 * Value area by the Steidlmayer / CBOT TPO method (lib/volumeProfile.ts expandValueArea): from
 * the POC, compare the next TWO rows above with the two below and add the heavier PAIR as a
 * whole (up wins a tie) until at least `pct` of all TPOs is enclosed. TPO counts tie far more
 * often than volumes, so the POC itself comes from pocIndex (ties toward the middle).
 * Returns row indices. Verified against an independent implementation on 50 NIFTY sessions.
 */
export function valueAreaIdx(counts: number[], poc: number, pct: number): { lo: number; hi: number } {
  return expandValueArea(counts, poc, pct, true);
}

/**
 * Runs of rows with exactly one TPO that are at least `minRows` tall. `isSingle` decides
 * which rows count, so a developing period's single prints can be excluded.
 */
function singleRuns(rows: TpoRow[], isSingle: (r: TpoRow) => boolean, minRows: number): { lo: number; hi: number }[] {
  const out: { lo: number; hi: number }[] = [];
  let start = -1;
  for (let i = 0; i <= rows.length; i++) {
    const single = i < rows.length && isSingle(rows[i]);
    if (single && start < 0) start = i;
    if (!single && start >= 0) {
      if (i - start >= minRows) out.push({ lo: start, hi: i - 1 });
      start = -1;
    }
  }
  return out;
}

interface Accumulated {
  key: string;
  kind: ProfileKind;
  days: string[];
  /** Row index → marks / volume. */
  marks: Map<number, number[]>;
  volume: Map<number, number>;
  periods: PeriodBar[];
  open: number;
  close: number;
  high: number;
  low: number;
  lastBarT: string;
  developing: boolean;
  ibHigh: number | null;
  ibLow: number | null;
  /** Mark that is still forming — its single prints are not yet final. */
  formingMark: number | null;
}

function finish(acc: Accumulated, rowSize: number, vaPct: number): Profile {
  const idxs = [...acc.marks.keys()];
  const loIdx = idxs.length ? Math.min(...idxs) : 0;
  const hiIdx = idxs.length ? Math.max(...idxs) : -1;
  const rows: TpoRow[] = [];
  for (let i = loIdx; i <= hiIdx; i++) {
    rows.push({ price: rowPrice(i, rowSize), marks: acc.marks.get(i) ?? [], volume: acc.volume.get(i) ?? 0 });
  }
  const counts = rows.map((r) => r.marks.length);
  const totalTpo = counts.reduce((s, c) => s + c, 0);
  const pocI = pocIndex(counts);
  const va = valueAreaIdx(counts, pocI, vaPct);

  let vpoc: number | null = null;
  let bestVol = 0;
  for (const r of rows) {
    if (r.volume > bestVol) {
      bestVol = r.volume;
      vpoc = r.price;
    }
  }

  // A row whose only TPO belongs to the period still forming is not a single print yet:
  // the next minutes may well print there again.
  const isSingle = (r: TpoRow) => r.marks.length === 1 && r.marks[0] !== acc.formingMark;
  const runs = singleRuns(rows, isSingle, 2);
  let sellingTail: PriceRun | null = null;
  let buyingTail: PriceRun | null = null;
  const singlePrints: PriceRun[] = [];
  for (const run of runs) {
    const pr = { from: rows[run.lo].price, to: rows[run.hi].price };
    if (run.hi === rows.length - 1) sellingTail = pr;
    else if (run.lo === 0) buyingTail = pr;
    else singlePrints.push(pr);
  }
  // A one-row profile is both top and bottom; treat it as neither tail.
  if (rows.length < 3) {
    sellingTail = null;
    buyingTail = null;
  }

  // Dalton's TPO count: TPOs above vs below the POC, leaving out the POC row itself and the
  // single-print tails (their message is already read as excess at the extremes).
  const tailRows = (t: PriceRun | null) => (t ? Math.round((t.to - t.from) / rowSize) + 1 : 0);
  const topCut = rows.length - tailRows(sellingTail);
  const bottomCut = tailRows(buyingTail);
  let tpoAbove = 0;
  let tpoBelow = 0;
  counts.forEach((c, i) => {
    if (i > pocI && i < topCut) tpoAbove += c;
    else if (i < pocI && i >= bottomCut) tpoBelow += c;
  });

  let rotationFactor = 0;
  for (let i = 1; i < acc.periods.length; i++) {
    const a = acc.periods[i - 1];
    const b = acc.periods[i];
    rotationFactor += Math.sign(b.h - a.h) + Math.sign(b.l - a.l);
  }

  const top = counts[counts.length - 1] ?? 0;
  const bottom = counts[0] ?? 0;
  const extUp = acc.ibHigh !== null ? Math.max(0, acc.high - acc.ibHigh) : 0;
  const extDown = acc.ibLow !== null ? Math.max(0, acc.ibLow - acc.low) : 0;

  return {
    key: acc.key,
    kind: acc.kind,
    start: acc.days[0] ?? '',
    end: acc.days[acc.days.length - 1] ?? '',
    days: acc.days,
    rowSize,
    rows,
    periods: acc.periods,
    open: acc.open,
    close: acc.close,
    high: acc.high,
    low: acc.low,
    lastBarT: acc.lastBarT,
    developing: acc.developing,
    totalTpo,
    poc: pocI >= 0 ? rows[pocI].price : 0,
    vah: va.hi >= 0 ? rows[va.hi].price : 0,
    val: va.lo >= 0 ? rows[va.lo].price : 0,
    vpoc,
    ibHigh: acc.ibHigh,
    ibLow: acc.ibLow,
    extUp,
    extDown,
    tpoAbove,
    tpoBelow,
    singlePrints,
    sellingTail,
    buyingTail,
    poorHigh: rows.length >= 3 && top >= 2,
    poorLow: rows.length >= 3 && bottom >= 2,
    rotationFactor,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Building profiles
// ─────────────────────────────────────────────────────────────────────────────

function newAcc(key: string, kind: ProfileKind): Accumulated {
  return {
    key, kind, days: [], marks: new Map(), volume: new Map(), periods: [],
    open: NaN, close: NaN, high: -Infinity, low: Infinity, lastBarT: '',
    developing: false, ibHigh: null, ibLow: null, formingMark: null,
  };
}

/** Add one session to an accumulator. `markFor(periodIndex)` decides what each TPO records. */
function addSession(
  acc: Accumulated,
  day: string,
  dayBars: Bar[],
  rowSize: number,
  periodMin: number,
  sessionStartMin: number,
  sessionEndMin: number,
  today: string | undefined,
  markFor: (periodIndex: number) => number,
): PeriodBar[] {
  const periods = sessionPeriods(dayBars, periodMin, sessionStartMin);
  if (periods.length === 0) return periods;
  acc.days.push(day);
  if (Number.isNaN(acc.open)) acc.open = dayBars[0].o;
  acc.close = dayBars[dayBars.length - 1].c;
  acc.lastBarT = dayBars[dayBars.length - 1].t;
  for (const p of periods) {
    acc.high = Math.max(acc.high, p.h);
    acc.low = Math.min(acc.low, p.l);
    const mark = markFor(p.index);
    for (let i = rowIdx(p.l, rowSize); i <= rowIdx(p.h, rowSize); i++) {
      let list = acc.marks.get(i);
      if (!list) acc.marks.set(i, (list = []));
      list.push(mark);
    }
  }
  for (const b of dayBars) {
    if (!(b.v > 0)) continue;
    const lo = rowIdx(b.l, rowSize);
    const hi = rowIdx(b.h, rowSize);
    const share = b.v / (hi - lo + 1);
    for (let i = lo; i <= hi; i++) acc.volume.set(i, (acc.volume.get(i) ?? 0) + share);
  }
  const last = parseStamp(acc.lastBarT);
  // Only today's session can still be forming; a bar in the final minute means it is done.
  acc.developing = day === today && !!last && last.min < sessionEndMin - 1;
  return periods;
}

/** One profile per session. */
export function buildDayProfiles(bars: Bar[], opts: TpoOptions): Profile[] {
  const rowSize = opts.rowSize;
  if (!(rowSize > 0)) return [];
  const periodMin = opts.periodMin ?? 30;
  const vaPct = opts.vaPct ?? 70;
  const ibPeriods = opts.ibPeriods ?? Math.max(1, Math.round(60 / periodMin));
  const start = opts.sessionStartMin ?? NSE_SESSION_START_MIN;
  const end = opts.sessionEndMin ?? NSE_SESSION_END_MIN;

  const out: Profile[] = [];
  for (const [day, dayBars] of splitSessions(bars, start, end)) {
    const acc = newAcc(day, 'day');
    const periods = addSession(acc, day, dayBars, rowSize, periodMin, start, end, opts.today, (i) => i);
    if (periods.length === 0) continue;
    acc.periods = periods;
    const ib = periods.filter((p) => p.index < ibPeriods);
    if (ib.length) {
      acc.ibHigh = Math.max(...ib.map((p) => p.h));
      acc.ibLow = Math.min(...ib.map((p) => p.l));
    }
    acc.formingMark = acc.developing ? periods[periods.length - 1].index : null;
    out.push(finish(acc, rowSize, vaPct));
  }
  return out;
}

/**
 * Weekly (ISO week) or monthly composites. Each TPO records the DAY it came from (A = first
 * session of the composite), so the letters answer "which day built this value".
 */
export function buildCompositeProfiles(bars: Bar[], kind: 'week' | 'month', opts: TpoOptions): Profile[] {
  const rowSize = opts.rowSize;
  if (!(rowSize > 0)) return [];
  const periodMin = opts.periodMin ?? 30;
  const vaPct = opts.vaPct ?? 70;
  const start = opts.sessionStartMin ?? NSE_SESSION_START_MIN;
  const end = opts.sessionEndMin ?? NSE_SESSION_END_MIN;

  const groups = new Map<string, Accumulated>();
  for (const [day, dayBars] of splitSessions(bars, start, end)) {
    const key = kind === 'week' ? isoWeekKey(day) : day.slice(0, 7);
    let acc = groups.get(key);
    if (!acc) groups.set(key, (acc = newAcc(key, kind)));
    const dayIndex = acc.days.length;
    const periods = addSession(acc, day, dayBars, rowSize, periodMin, start, end, opts.today, () => dayIndex);
    // Composite "periods" are its days, so the rotation factor compares day to day.
    if (periods.length) {
      acc.periods.push({
        index: dayIndex,
        letter: tpoLetter(dayIndex),
        t: periods[0].t,
        o: periods[0].o,
        h: Math.max(...periods.map((p) => p.h)),
        l: Math.min(...periods.map((p) => p.l)),
        c: periods[periods.length - 1].c,
      });
      acc.formingMark = acc.developing ? dayIndex : null;
    }
  }
  return [...groups.values()].filter((a) => a.days.length > 0).map((a) => finish(a, rowSize, vaPct));
}

// ─────────────────────────────────────────────────────────────────────────────
// Reading the profile
// ─────────────────────────────────────────────────────────────────────────────

export type DayType =
  | 'Non-Trend'
  | 'Normal'
  | 'Normal Variation Up'
  | 'Normal Variation Down'
  | 'Trend Up'
  | 'Trend Down'
  | 'Neutral Center'
  | 'Neutral Extreme';

/**
 * Classify a day by where it traded relative to its initial balance (course rules):
 *   no extension      → Non-Trend if the IB is narrow vs recent IBs, else Normal;
 *   both sides        → Neutral (Center if it closes in the middle of the range, else Extreme);
 *   one side          → Trend when the extension is ≥ TREND_MIN_EXT_IB × IB and the close sits in
 *                       that extreme, or the extension exceeds NORMAL_VARIATION_MAX_EXT_IB × IB;
 *                       otherwise Normal Variation.
 * `avgIb` is the mean IB range of recent sessions (null when there is no history).
 */
export function classifyDay(p: Profile, avgIb: number | null): DayType | null {
  if (p.kind !== 'day' || p.ibHigh === null || p.ibLow === null) return null;
  const ib = p.ibHigh - p.ibLow;
  const range = p.high - p.low;
  const up = p.extUp > 0;
  const down = p.extDown > 0;
  const closePos = range > 0 ? (p.close - p.low) / range : 0.5;

  if (!up && !down) {
    return avgIb !== null && avgIb > 0 && ib < NARROW_IB_RATIO * avgIb ? 'Non-Trend' : 'Normal';
  }
  if (up && down) {
    const center = closePos > EXTREME_CLOSE_SHARE && closePos < 1 - EXTREME_CLOSE_SHARE;
    return center ? 'Neutral Center' : 'Neutral Extreme';
  }
  const ext = up ? p.extUp : p.extDown;
  const closeInExtreme = up ? closePos >= 1 - EXTREME_CLOSE_SHARE : closePos <= EXTREME_CLOSE_SHARE;
  const trend = ib > 0 && (ext > NORMAL_VARIATION_MAX_EXT_IB * ib || (ext >= TREND_MIN_EXT_IB * ib && closeInExtreme));
  if (trend) return up ? 'Trend Up' : 'Trend Down';
  return up ? 'Normal Variation Up' : 'Normal Variation Down';
}

/** Mean IB range of up to IB_AVERAGE_SESSIONS day profiles before `index`. */
export function averageIb(profiles: Profile[], index: number): number | null {
  const prior = profiles
    .slice(Math.max(0, index - IB_AVERAGE_SESSIONS), index)
    .filter((p) => p.ibHigh !== null && p.ibLow !== null)
    .map((p) => (p.ibHigh as number) - (p.ibLow as number));
  if (prior.length === 0) return null;
  return prior.reduce((s, v) => s + v, 0) / prior.length;
}

export interface PowerDegree {
  side: 'bullish' | 'bearish' | 'balanced';
  /** 1 (weakest) … 6 (strongest); 0 when balanced. */
  degree: number;
  reason: string;
}

/**
 * Degrees of bullish / bearish power (course ladder), judged at `price` (the live price, or
 * the close of a finished day):
 *
 *   vs previous day:   above prev VA → degrees 1-3;  above prev RANGE → degrees 4-6
 *   vs own structure:  within own IB → +0;  above own IB but within own VA → +1;  above own VA → +2
 *
 * Mirror image for bearish. Inside the previous day's value area the market is balanced.
 */
export function powerDegree(today: Profile, prev: Profile, price: number): PowerDegree {
  const bull = price > vaTop(prev);
  const bear = price < prev.val;
  if (!bull && !bear) {
    return { side: 'balanced', degree: 0, reason: 'Inside the previous value area' };
  }
  const outsideRange = bull ? price > prev.high : price < prev.low;
  let step: number;
  let where: string;
  if (bull ? price > vaTop(today) : price < today.val) {
    step = 2;
    where = bull ? 'above its value area' : 'below its value area';
  } else if (today.ibHigh !== null && today.ibLow !== null && (bull ? price > today.ibHigh : price < today.ibLow)) {
    step = 1;
    where = bull ? 'above its IB, within its value area' : 'below its IB, within its value area';
  } else {
    step = 0;
    where = 'within its initial balance';
  }
  const ref = outsideRange ? 'range' : 'value area';
  return {
    side: bull ? 'bullish' : 'bearish',
    degree: (outsideRange ? 4 : 1) + step,
    reason: `${where}; ${bull ? 'above' : 'below'} the previous day's ${ref}`,
  };
}

/** Statistical trend pressure: more TPOs below the POC lean bullish (the profile wants to fill up). */
export function tpoSkew(p: Profile): 'bullish' | 'bearish' | 'balanced' {
  const total = p.tpoAbove + p.tpoBelow;
  if (total === 0) return 'balanced';
  const diff = (p.tpoBelow - p.tpoAbove) / total;
  if (diff > SKEW_MIN_SHARE) return 'bullish';
  if (diff < -SKEW_MIN_SHARE) return 'bearish';
  return 'balanced';
}

export interface NakedPoc {
  /** Key of the profile the POC belongs to. */
  key: string;
  poc: number;
  /** Key of the first later profile whose range traded through the POC, or null if still naked. */
  touchedBy: string | null;
}

/**
 * Every profile's POC and the first later profile that revisited it. A POC is "naked"
 * (virgin) until a later session trades through it. Profiles must be in time order.
 */
export function nakedPocs(profiles: Profile[]): NakedPoc[] {
  return profiles.map((p, i) => {
    let touchedBy: string | null = null;
    for (let j = i + 1; j < profiles.length; j++) {
      const q = profiles[j];
      if (q.low < p.poc + p.rowSize && q.high >= p.poc) {
        touchedBy = q.key;
        break;
      }
    }
    return { key: p.key, poc: p.poc, touchedBy };
  });
}

/** IB range — null for composites. */
export function ibRange(p: Profile): number | null {
  return p.ibHigh !== null && p.ibLow !== null ? p.ibHigh - p.ibLow : null;
}
