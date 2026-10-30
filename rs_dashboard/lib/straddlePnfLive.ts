// Live-tick helpers for the Straddle P&F page. Pure: time arrives in the arguments, nothing here reads a clock.
import type { Bar, PnfSignal } from './straddlePnf.ts';

/** `cumVol` is the bridge's cumulative day volume for both legs (CE + PE), the same units as the history bars' per-minute volume. */
export type Tick = { t: number; ce: number; pe: number; cumVol?: number };

const minuteOf = (t: number) => Math.floor(t / 60) * 60;

/**
 * Folds a CE+PE tick into the 1-min bars. A tick inside the open minute updates that bar's close; a tick in a later minute
 * appends a bar and reports the index of the bar that just closed (the only moment signals may be evaluated).
 * Ticks with a missing leg (unless `single`) and ticks from an earlier minute are ignored.
 *
 * Volume: a bar's volume is the growth of the cumulative figure since its baseline, so VWAP keeps weighting live bars.
 * A history bar still forming keeps the volume it already has and gains the growth on top; a counter that goes backwards
 * (bridge restart) re-baselines instead of producing a negative or lost volume.
 */
export function foldTick(bars: Bar[], tick: Tick, single = false): { bars: Bar[]; closedIndex: number | null } {
  // `single`: a plain price (index / stock / future) is carried as ce with pe 0, the shape the history bars already have.
  if (!(tick.ce > 0) || (!single && !(tick.pe > 0))) return { bars, closedIndex: null };
  const t = minuteOf(tick.t);
  const cv = Number.isFinite(tick.cumVol) && (tick.cumVol as number) >= 0 ? (tick.cumVol as number) : null;
  const last = bars[bars.length - 1];
  const straddle = tick.ce + tick.pe;

  const fresh = (): Bar => {
    const base = cv === null ? undefined : last?.cum !== undefined && cv >= last.cum ? last.cum : cv;
    return {
      t, ce: tick.ce, pe: tick.pe, straddle,
      vol: cv !== null && base !== undefined ? Math.max(0, cv - base) : 0,
      ...(cv !== null ? { cum: cv, cumBase: base } : {}),
    };
  };
  if (!last) return { bars: [fresh()], closedIndex: null };
  if (t < last.t) return { bars, closedIndex: null };
  if (t > last.t) return { bars: [...bars, fresh()], closedIndex: bars.length - 1 };

  let { vol, cumBase } = last;
  if (cv !== null) {
    if (cumBase === undefined || (last.cum !== undefined && cv < last.cum)) cumBase = cv - vol; // first live tick on this bar, or a counter reset
    else vol = Math.max(0, cv - cumBase);
  }
  const next: Bar = { ...last, ce: tick.ce, pe: tick.pe, straddle, vol };
  if (cv !== null) { next.cum = cv; next.cumBase = cumBase; }
  return { bars: [...bars.slice(0, -1), next], closedIndex: null };
}

/**
 * Signals worth alerting on: those whose breaking bar is newer than the watermark (the last closed bar already evaluated).
 * Keyed on bar time, not on column numbers, so a re-built chart (the history window moving on, tick bars swapped for API
 * bars) can never re-alert an old signal or lose a new one.
 */
export function newSignalsAfter(signals: PnfSignal[], watermark: number): PnfSignal[] {
  return signals.filter(s => s.t > watermark);
}

/** The watermark after an evaluation: the last closed bar now seen. Never moves backwards. */
export function nextWatermark(prev: number, lastClosedBarT: number | null): number {
  return lastClosedBarT === null ? prev : Math.max(prev, lastClosedBarT);
}

/** Newest first, at most `max` entries. */
export function capLog<T>(log: T[], entry: T, max = 30): T[] {
  return [entry, ...log].slice(0, max);
}
