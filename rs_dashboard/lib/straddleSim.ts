// Pure helpers for the Straddle Simulator: parameter validation, replay speed, the replay timeline and the clock label.
import { roundToStep } from './straddlePnfStrikes.ts';
import type { Bar } from './straddlePnf.ts';

export const SPEEDS = [1, 50, 100, 200] as const;
export type Speed = (typeof SPEEDS)[number];
/** Most sessions one replay may cover (plus the preload day). */
export const MAX_SESSIONS = 6;

export type ExpiryInfo = { expiry: string; first: string; last: string };
export type SimParams = { index: string; expiry: string; from: string; to: string; atm: string };

/** One replay step is one 1-min bar closing; at speed N it takes 60 s / N. */
export const msPerBar = (speed: Speed): number => 60_000 / speed;

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/**
 * `expiries` is the store's expiry list (null = not known yet: the range check is skipped, the server repeats it);
 * `today` is the IST date YYYY-MM-DD. The replay must be strictly in the past.
 */
export function validateSimParams(
  p: SimParams,
  expiries: ExpiryInfo[] | null,
  today: string,
): { ok: true; atm: 'auto' | number } | { ok: false; error: string } {
  if (p.index.toUpperCase() === 'SENSEX') {
    return { ok: false, error: 'SENSEX has no historical option data in this repo (the store holds NIFTY only), so it cannot be replayed.' };
  }
  if (p.index.toUpperCase() !== 'NIFTY') return { ok: false, error: `Unsupported index ${p.index}: only NIFTY can be replayed.` };
  if (!ISO.test(p.expiry)) return { ok: false, error: 'Pick an expiry.' };
  if (!ISO.test(p.from) || !ISO.test(p.to)) return { ok: false, error: 'From and To must be dates (YYYY-MM-DD).' };
  if (p.from > p.to) return { ok: false, error: 'From must be on or before To.' };
  if (p.to >= today) return { ok: false, error: 'The simulator replays past sessions only: To must be before today.' };

  if (expiries) {
    const info = expiries.find(e => e.expiry === p.expiry);
    if (!info) return { ok: false, error: `No data for expiry ${p.expiry}.` };
    if (p.from < info.first || p.to > info.last) {
      return { ok: false, error: `Expiry ${p.expiry} has data from ${info.first} to ${info.last}; pick dates inside that range.` };
    }
  }

  if (p.atm === 'auto') return { ok: true, atm: 'auto' };
  const n = Number(p.atm);
  if (p.atm.trim() === '' || !Number.isFinite(n) || n <= 0) return { ok: false, error: 'ATM must be "Auto" or a positive strike.' };
  return { ok: true, atm: roundToStep(n) };
}

/** Sorted distinct bar times at or after the replay start, across all strikes: the steps of the replay. */
export function timelineOf(bars: Record<string, Bar[]>, replayStartT: number): number[] {
  const seen = new Set<number>();
  for (const series of Object.values(bars)) for (const b of series) if (b.t >= replayStartT) seen.add(b.t);
  return [...seen].sort((a, b) => a - b);
}

/** The prefix of an ascending series up to and including time `t`. */
export function barsUpTo(series: Bar[], t: number): Bar[] {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].t <= t) lo = mid + 1; else hi = mid;
  }
  return series.slice(0, lo);
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Mon 12 Oct 09:15" in IST. */
export function clockLabel(t: number): string {
  const d = new Date((t + 5.5 * 3600) * 1000);
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${DAYS[d.getUTCDay()]} ${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${hh}:${mm}`;
}

/** The latest value at or before time `t` from parallel ascending arrays, or null before the first one. */
export function valueAt(times: number[], values: number[], t: number): number | null {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= t) lo = mid + 1; else hi = mid;
  }
  return lo === 0 ? null : values[lo - 1];
}
