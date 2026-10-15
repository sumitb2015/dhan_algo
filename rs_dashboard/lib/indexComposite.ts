/**
 * Composite index: a weighted combination of the indices streamed by
 * scripts/tools/live_indices_ws.py (debug/live_indices_history.json), turned
 * into a line or OHLC candles, plus one overlay line per index, for /composite-index.
 *
 * Pure — no React, no fetch — so the maths is unit-tested in
 * indexComposite.test.ts.
 */

/** One row of the bridge's `ticks` array: `t` is IST wall-clock HH:MM:SS, every other key is a symbol's LTP. */
export type IndexTick = { t: string } & Record<string, number | string>;

export interface IndicesHistory {
  session_date: string;
  updated_at: string;
  catalogue: string[];
  available: string[];
  labels: Record<string, string>;
  categories?: Record<string, string>;
  ticks: IndexTick[];
}

export interface CompositeComponent {
  symbol: string;
  /** Influence. May be negative (a spread such as BANKNIFTY − 2 × NIFTY). Zero drops the index. */
  weight: number;
  /** Unticked rows keep their weight but are left out. Missing = enabled (v1 saved state). */
  enabled?: boolean;
}

/**
 * `equal` — S × Σ wᵢ·(Pᵢ / Bᵢ) / Σ|wᵢ|: each index's move from its first in-session price Bᵢ,
 *           weighted by influence, so a 69,000-point index has no more say than an 830-point
 *           one at equal weight. S is NIFTY's base (100 if NIFTY is left out), so the composite
 *           opens at Nifty's level and reads in Nifty-like points.
 * `sum`   — Σ wᵢ·Pᵢ, raw index points; high-priced indices dominate.
 */
export type CompositeMode = 'equal' | 'sum';

/** A volatility gauge, not a price: it has no meaning inside a price composite. */
export const EXCLUDED_SYMBOLS = new Set(['INDIA VIX']);
export const SCALE_SYMBOL = 'NIFTY';

/** UTCTimestamp carrying IST wall-clock time, so lightweight-charts' UTC formatting reads IST. */
export interface CompositePoint { time: number; value: number }
export interface CompositeCandle { time: number; open: number; high: number; low: number; close: number }

const SESSION_OPEN_SEC = 9 * 3600 + 15 * 60;
const SESSION_CLOSE_SEC = 15 * 3600 + 30 * 60;

function secondsOfDay(t: string): number | null {
  const m = /^(\d{2}):(\d{2}):(\d{2})$/.exec(t);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Every price index in the feed at equal influence — the page's starting set. */
export function defaultComponents(catalogue: string[]): CompositeComponent[] {
  return catalogue.filter(s => !EXCLUDED_SYMBOLS.has(s)).map(symbol => ({ symbol, weight: 1, enabled: true }));
}

/** Rows that take part: enabled, finite, non-zero weight. */
export function activeComponents(components: CompositeComponent[]): CompositeComponent[] {
  return components.filter(c => c.symbol && c.enabled !== false && Number.isFinite(c.weight) && c.weight !== 0);
}

/** Each active row's share of total influence, in % (Σ|share| = 100). */
export function influenceShares(components: CompositeComponent[]): Record<string, number> {
  const active = activeComponents(components);
  const total = active.reduce((s, c) => s + Math.abs(c.weight), 0);
  const out: Record<string, number> = {};
  for (const c of active) out[c.symbol] = total ? (c.weight / total) * 100 : 0;
  return out;
}

/**
 * The bridge's `session_date` is fixed when the process starts, so a bridge left running
 * overnight keeps yesterday's ticks and date while appending today's. Its `t` field has
 * no date, so the day boundary shows up only as time going backwards: keep the run after
 * the last backwards step, and date it from `updated_at` (the day the newest tick was written).
 */
export function currentSessionTicks(history: Pick<IndicesHistory, 'ticks' | 'session_date' | 'updated_at'>): {
  date: string;
  ticks: { sec: number; tick: IndexTick }[];
} {
  const parsed: { sec: number; tick: IndexTick }[] = [];
  for (const tick of history.ticks ?? []) {
    const sec = secondsOfDay(String(tick.t));
    if (sec !== null) parsed.push({ sec, tick });
  }
  let start = 0;
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].sec < parsed[i - 1].sec) start = i;
  }
  const wrapped = start > 0;
  const date = (wrapped ? history.updated_at?.slice(0, 10) : history.session_date) || history.session_date;
  return {
    date,
    ticks: parsed.slice(start).filter(p => p.sec >= SESSION_OPEN_SEC && p.sec <= SESSION_CLOSE_SEC),
  };
}

/** A run this long with every index unchanged is a dead feed, not a quiet market (25 indices never all sit still). */
const STALE_RUN_TICKS = 3;

/**
 * Index of the first live tick. When the hub has no live data (expired token, hub restart) the
 * bridge keeps writing the last known prices, so the session opens with a frozen stretch. Bases
 * taken there would be stale prices and the whole session would read as one jump at feed-up time.
 * Returns 0 when there is no such stretch (or the feed never came alive).
 */
export function firstLiveTick(ticks: { tick: IndexTick }[]): number {
  if (ticks.length === 0) return 0;
  const first = ticks[0].tick;
  for (let i = 1; i < ticks.length; i++) {
    const t = ticks[i].tick;
    const changed = Object.keys(t).some(k => k !== 't' && k in first && t[k] !== first[k]);
    if (changed) return i >= STALE_RUN_TICKS ? i : 0;
  }
  return 0;
}

function dayEpoch(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) / 1000;
}

export interface CompositeResult {
  date: string;
  points: CompositePoint[];
  /** `equal` mode only: per active symbol, S × Pᵢ/Bᵢ — on the composite's axis, all starting at S. */
  overlays: Record<string, CompositePoint[]>;
  /** S: NIFTY's first in-session price (100 if NIFTY is not active). Undefined in `sum` mode. */
  scale?: number;
  /** Active symbols with no price in any in-session tick (deselected in the bridge, or not subscribed). */
  missing: string[];
  /** First in-session price per active symbol. */
  bases: Record<string, number>;
  /** Latest price per active symbol. */
  last: Record<string, number>;
  /** HH:MM:SS of the first live tick when a frozen opening stretch was skipped (see firstLiveTick). */
  staleUntil?: string;
}

function pushPoint(arr: CompositePoint[], time: number, value: number) {
  // The bridge can write two ticks in the same second after a restart; keep the later one.
  if (arr.length && arr[arr.length - 1].time === time) arr[arr.length - 1].value = value;
  else arr.push({ time, value });
}

/**
 * Composite value per tick. A symbol absent from a tick is forward-filled from its last
 * price; ticks before every active symbol has printed once are skipped, so the line does
 * not jump when a late component first appears.
 */
export function buildComposite(
  history: Pick<IndicesHistory, 'ticks' | 'session_date' | 'updated_at'>,
  components: CompositeComponent[],
  mode: CompositeMode,
): CompositeResult {
  const active = activeComponents(components);
  const session = currentSessionTicks(history);
  const { date } = session;
  const liveFrom = firstLiveTick(session.ticks);
  const ticks = session.ticks.slice(liveFrom);
  const staleUntil = liveFrom > 0 ? String(session.ticks[liveFrom].tick.t) : undefined;
  const base0 = dayEpoch(date);
  const last: Record<string, number> = {};
  const bases: Record<string, number> = {};
  const points: CompositePoint[] = [];
  const overlays: Record<string, CompositePoint[]> = {};
  if (mode === 'equal') for (const c of active) overlays[c.symbol] = [];
  const absWeight = active.reduce((s, c) => s + Math.abs(c.weight), 0);
  const scaleActive = active.some(c => c.symbol === SCALE_SYMBOL);
  let scale: number | undefined;

  for (const { sec, tick } of ticks) {
    for (const c of active) {
      const v = Number(tick[c.symbol]);
      if (Number.isFinite(v) && v > 0) {
        last[c.symbol] = v;
        if (bases[c.symbol] === undefined) bases[c.symbol] = v;
      }
    }
    if (active.length === 0 || active.some(c => last[c.symbol] === undefined)) continue;
    const time = base0 + sec;

    if (mode === 'sum') {
      let value = 0;
      for (const c of active) value += c.weight * last[c.symbol];
      pushPoint(points, time, value);
    } else {
      scale ??= scaleActive ? bases[SCALE_SYMBOL] : 100;
      let value = 0;
      for (const c of active) {
        const ratio = last[c.symbol] / bases[c.symbol];
        value += c.weight * ratio;
        pushPoint(overlays[c.symbol], time, scale * ratio);
      }
      pushPoint(points, time, (scale * value) / absWeight);
    }
  }

  const missing = active.filter(c => bases[c.symbol] === undefined).map(c => c.symbol);
  return { date, points, overlays, scale, missing, bases, last, staleUntil };
}

function bucketStart(time: number, bucketSec: number): number {
  const sinceMidnight = ((time % 86400) + 86400) % 86400;
  const dayStart = time - sinceMidnight;
  return dayStart + SESSION_OPEN_SEC + Math.floor((sinceMidnight - SESSION_OPEN_SEC) / bucketSec) * bucketSec;
}

/** Bucket points into `bucketSec` candles aligned to the 09:15 session open (so 3m/5m bars match the exchange's). */
export function toCandles(points: CompositePoint[], bucketSec: number): CompositeCandle[] {
  const candles: CompositeCandle[] = [];
  for (const p of points) {
    const time = bucketStart(p.time, bucketSec);
    const bar = candles[candles.length - 1];
    if (bar && bar.time === time) {
      bar.high = Math.max(bar.high, p.value);
      bar.low = Math.min(bar.low, p.value);
      bar.close = p.value;
    } else {
      candles.push({ time, open: p.value, high: p.value, low: p.value, close: p.value });
    }
  }
  return candles;
}

/** Last value per `bucketSec` bucket, stamped at the bucket start — overlay lines that line up with toCandles' bars. */
export function toLineCloses(points: CompositePoint[], bucketSec: number): CompositePoint[] {
  const out: CompositePoint[] = [];
  for (const p of points) pushPoint(out, bucketStart(p.time, bucketSec), p.value);
  return out;
}
