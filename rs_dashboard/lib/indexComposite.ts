/**
 * Composite index: a weighted sum of the indices streamed by
 * scripts/tools/live_indices_ws.py (debug/live_indices_history.json), turned
 * into a line or OHLC candles for /composite-index.
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
  ticks: IndexTick[];
}

export interface CompositeComponent {
  symbol: string;
  /** May be negative (a spread such as BANKNIFTY − 2 × NIFTY). Zero drops the index. */
  weight: number;
}

/**
 * `sum`        — Σ wᵢ·Pᵢ, in index points.
 * `normalized` — 100 × Σ wᵢ·(Pᵢ / Pᵢ,base) / Σ|wᵢ|, where the base is each index's first
 *                in-session price. A 50,000-point index no longer outweighs a 900-point one.
 */
export type CompositeMode = 'sum' | 'normalized';

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

function dayEpoch(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, (m || 1) - 1, d || 1) / 1000;
}

export interface CompositeResult {
  date: string;
  points: CompositePoint[];
  /** Weighted symbols with no price in any in-session tick (deselected in the bridge, or not subscribed). */
  missing: string[];
  /** Base price per symbol used by `normalized` mode (first in-session price). */
  bases: Record<string, number>;
  /** Latest price per weighted symbol. */
  last: Record<string, number>;
}

/**
 * Composite value per tick. A symbol absent from a tick is forward-filled from its last
 * price; ticks before every weighted symbol has printed once are skipped, so the line does
 * not jump when a late component first appears.
 */
export function buildComposite(
  history: Pick<IndicesHistory, 'ticks' | 'session_date' | 'updated_at'>,
  components: CompositeComponent[],
  mode: CompositeMode,
): CompositeResult {
  const active = components.filter(c => c.symbol && Number.isFinite(c.weight) && c.weight !== 0);
  const { date, ticks } = currentSessionTicks(history);
  const base0 = dayEpoch(date);
  const last: Record<string, number> = {};
  const bases: Record<string, number> = {};
  const points: CompositePoint[] = [];
  const absWeight = active.reduce((s, c) => s + Math.abs(c.weight), 0);

  for (const { sec, tick } of ticks) {
    for (const c of active) {
      const v = Number(tick[c.symbol]);
      if (Number.isFinite(v) && v > 0) {
        last[c.symbol] = v;
        if (bases[c.symbol] === undefined) bases[c.symbol] = v;
      }
    }
    if (active.length === 0 || active.some(c => last[c.symbol] === undefined)) continue;

    let value = 0;
    if (mode === 'sum') {
      for (const c of active) value += c.weight * last[c.symbol];
    } else {
      for (const c of active) value += c.weight * (last[c.symbol] / bases[c.symbol]);
      value = (100 * value) / absWeight;
    }
    const time = base0 + sec;
    // The bridge can write two ticks in the same second after a restart; keep the later one.
    if (points.length && points[points.length - 1].time === time) points[points.length - 1].value = value;
    else points.push({ time, value });
  }

  const missing = active.filter(c => bases[c.symbol] === undefined).map(c => c.symbol);
  return { date, points, missing, bases, last };
}

/** Bucket points into `bucketSec` candles aligned to the 09:15 session open (so 3m/5m bars match the exchange's). */
export function toCandles(points: CompositePoint[], bucketSec: number): CompositeCandle[] {
  const candles: CompositeCandle[] = [];
  for (const p of points) {
    const sinceMidnight = ((p.time % 86400) + 86400) % 86400;
    const dayStart = p.time - sinceMidnight;
    const offset = sinceMidnight - SESSION_OPEN_SEC;
    const time = dayStart + SESSION_OPEN_SEC + Math.floor(offset / bucketSec) * bucketSec;
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
