/**
 * Exit-condition alerts for short positions opened from the Bearish Strikes page.
 *
 * A short wants the option below its Supertrend, VWAP and EMA20. This watches the SAME three levels for the
 * contracts this page holds and says when one turns against the position. Pure module (no I/O, no timers):
 * the page feeds it observations once a second and acts on the events it returns.
 *
 * Rules that matter:
 *  - A level that is still warming up is UNKNOWN, never "breached" and never "fine": unknown does not alert.
 *    Whether the position is being watched at all is a separate question (see watchState).
 *  - A breach must hold for CONFIRM_MS before it alerts, so a single flickering tick does not cry wolf.
 *  - After alerting it stays quiet until the level is respected again for REARM_MS, then it can alert again.
 *  - Basis 'live' compares the live price to the level (earliest warning). Basis 'closed' waits for the last
 *    closed bar to be on the wrong side (slower, fewer false alarms).
 */
import type { Indicators } from './bearishStrikes.ts';

export type Level = 'st' | 'vwap' | 'ema';
export type Basis = 'live' | 'closed';
export const LEVELS: Level[] = ['st', 'vwap', 'ema'];
export const LEVEL_LABEL: Record<Level, string> = { st: 'Supertrend', vwap: 'VWAP', ema: 'EMA20' };

export const CONFIRM_MS = 5_000;
export const REARM_MS = 15_000;

/** true = this level is now against a short; false = respected; null = cannot tell yet. */
export type LevelState = boolean | null;

export function levelStates(ind: Indicators, ltp: number | null, basis: Basis): Record<Level, LevelState> {
  const price = basis === 'live' ? ltp : ind.close;
  if (price == null || !(price > 0)) return { st: null, vwap: null, ema: null };
  // Supertrend: a bullish direction on the last closed bar is itself adverse for a short, wherever the price sits.
  const st: LevelState = ind.stLine == null || ind.stDir == null ? null : (ind.stDir === 1 || price >= ind.stLine);
  const vwap: LevelState = ind.vwap == null ? null : price >= ind.vwap;
  const ema: LevelState = ind.ema == null ? null : price >= ind.ema;
  return { st, vwap, ema };
}

export interface TrackerEntry {
  /** Currently breached (as of the last observation). */
  breached: boolean;
  /** Since when the current breach / respected streak has lasted (ms). */
  since: number;
  /** An alert has already been raised for this breach. */
  fired: boolean;
}
export type Tracker = Record<string, TrackerEntry>;

export interface AlertEvent { key: string; positionId: string; level: Level; kind: 'breach' | 'recovered' }

export const trackerKey = (positionId: string, level: Level) => `${positionId}:${level}`;

/**
 * One observation round. `obs` lists every (position, level) being watched with its state; anything in the
 * tracker that is no longer listed (position closed, level unticked) is dropped.
 */
export function stepTracker(
  prev: Tracker,
  obs: { positionId: string; level: Level; state: LevelState }[],
  now: number,
): { tracker: Tracker; events: AlertEvent[] } {
  const tracker: Tracker = {};
  const events: AlertEvent[] = [];
  for (const o of obs) {
    const key = trackerKey(o.positionId, o.level);
    const old = prev[key];
    if (o.state == null) {                       // unknown: hold whatever we knew, change nothing
      if (old) tracker[key] = old;
      continue;
    }
    if (!old) {                                  // first sight: a breach that already exists is a breach
      tracker[key] = { breached: o.state, since: now, fired: false };
      continue;
    }
    let e = old;
    if (o.state !== old.breached) e = { breached: o.state, since: now, fired: old.fired };   // streak restarts
    if (e.breached && !e.fired && now - e.since >= CONFIRM_MS) {
      e = { ...e, fired: true };
      events.push({ key, positionId: o.positionId, level: o.level, kind: 'breach' });
    } else if (!e.breached && e.fired && now - e.since >= REARM_MS) {
      e = { ...e, fired: false };                // respected long enough: arm again
      events.push({ key, positionId: o.positionId, level: o.level, kind: 'recovered' });
    }
    tracker[key] = e;
  }
  return { tracker, events };
}

/** Levels currently alerting (fired and still breached) for one position. */
export function activeLevels(tracker: Tracker, positionId: string): Level[] {
  return LEVELS.filter((l) => {
    const t = tracker[trackerKey(positionId, l)];
    return !!t && t.fired && t.breached;
  });
}

export type WatchState = 'watching' | 'other-chain' | 'no-price' | 'no-bars' | 'warming';

/**
 * Why a position can or cannot be watched right now. Silent non-monitoring is the dangerous failure, so every
 * reason other than 'watching' is shown to the user.
 */
export function watchState(args: {
  inScope: boolean;            // same underlying + expiry as the page's live feed
  feedFresh: boolean;
  hasPrice: boolean;
  hasBars: boolean;
  states: Record<Level, LevelState>;
  watch: Record<Level, boolean>;
}): WatchState {
  if (!args.inScope) return 'other-chain';
  if (!args.feedFresh || !args.hasPrice) return 'no-price';
  if (!args.hasBars) return 'no-bars';
  const watched = LEVELS.filter((l) => args.watch[l]);
  if (watched.length && watched.every((l) => args.states[l] == null)) return 'warming';
  return 'watching';
}
