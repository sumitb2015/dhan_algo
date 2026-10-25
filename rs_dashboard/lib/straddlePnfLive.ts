// Live-tick helpers for the Straddle P&F page. Pure: time arrives in the arguments, nothing here reads a clock.
import type { Bar, PnfSignal } from './straddlePnf.ts';

export type Tick = { t: number; ce: number; pe: number };

const minuteOf = (t: number) => Math.floor(t / 60) * 60;

/**
 * Folds a CE+PE tick into the 1-min bars. A tick inside the open minute updates that bar's close; a tick in a later minute
 * appends a bar and reports the index of the bar that just closed (the only moment signals may be evaluated).
 * Ticks with a missing leg and ticks from an earlier minute are ignored.
 */
export function foldTick(bars: Bar[], tick: Tick): { bars: Bar[]; closedIndex: number | null } {
  if (!(tick.ce > 0) || !(tick.pe > 0)) return { bars, closedIndex: null };
  const t = minuteOf(tick.t);
  const last = bars[bars.length - 1];
  const fresh: Bar = { t, ce: tick.ce, pe: tick.pe, straddle: tick.ce + tick.pe, vol: 0 };
  if (!last) return { bars: [fresh], closedIndex: null };
  if (t < last.t) return { bars, closedIndex: null };
  if (t === last.t) {
    return { bars: [...bars.slice(0, -1), { ...last, ce: tick.ce, pe: tick.pe, straddle: tick.ce + tick.pe }], closedIndex: null };
  }
  return { bars: [...bars, fresh], closedIndex: bars.length - 1 };
}

/** Signals worth alerting on: not already seen, and not from history (bar time before the first live bar). */
export function newSignalsSince(signals: PnfSignal[], seen: Set<string>, firstLiveBarT: number): PnfSignal[] {
  return signals.filter(s => !seen.has(s.id) && s.t >= firstLiveBarT);
}

/** Newest first, at most `max` entries. */
export function capLog<T>(log: T[], entry: T, max = 30): T[] {
  return [entry, ...log].slice(0, max);
}
