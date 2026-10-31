// Live-tick helpers for the Straddle P&F page. Pure: time arrives in the arguments, nothing here reads a clock.
import type { Bar, PnfSignal } from './straddlePnf.ts';
import { mcxSession } from './mcxSession.ts';

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

export type LegQuote = { ltp: number; changedMs: number; volume: number | null } | null;

/**
 * The live route's leg quotes -> one chart tick. One leg (an index, stock, future or single option) is carried as `ce` with `pe` 0;
 * two legs (a straddle, CE first) only make a tick once BOTH have a live price, at the later of the two changes, so a half-known
 * straddle never prints. Volume is summed only when both legs report it.
 */
/** A live price more than this factor away from the last bar (either way) is a bad print, not a move: it is never charted. */
export const WILD_TICK_FACTOR = 10;

/** True when `price` is a bad print against the last bar's close: >= WILD_TICK_FACTOR x or <= 1 / WILD_TICK_FACTOR of it. */
export function isWildTick(lastClose: number | undefined, price: number): boolean {
  if (!(lastClose && lastClose > 0) || !(price > 0)) return false;
  const r = price / lastClose;
  return r >= WILD_TICK_FACTOR || r <= 1 / WILD_TICK_FACTOR;
}

export function legsTick(legs: LegQuote[]): Tick | null {
  if (legs.length === 1) {
    const q = legs[0];
    return q && q.ltp > 0 ? { t: q.changedMs / 1000, ce: q.ltp, pe: 0, cumVol: q.volume ?? undefined } : null;
  }
  if (legs.length !== 2) return null;
  const [c, p] = legs;
  if (!c || !p || !(c.ltp > 0) || !(p.ltp > 0)) return null;
  const vol = c.volume !== null && p.volume !== null ? c.volume + p.volume : undefined;
  return { t: Math.max(c.changedMs, p.changedMs) / 1000, ce: c.ltp, pe: p.ltp, cumVol: vol };
}

/** 'NSE' = cash and index (09:15-15:30); 'NSE_FNO' = futures and options (09:15-15:40); 'MCX' = commodities. */
export type Market = 'NSE' | 'NSE_FNO' | 'MCX';

const IST_OFFSET_S = 5.5 * 3600;
export const istMinuteOfDay = (t: number) => Math.floor(((t + IST_OFFSET_S) % 86_400) / 60);
const istIso = (t: number) => new Date((t + IST_OFFSET_S) * 1000).toISOString().slice(0, 10);
const hhmmToMin = (hhmm: number) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);

/**
 * The trading session on the IST date of `t`, as IST minutes of the day [open, close). NSE cash and index: 09:15-15:30. NSE
 * derivatives: 09:15-15:40 (futures and options trade ten minutes longer; their bars run to 15:39 with real volume). MCX: from mcxSession
 * (lib/mcxSession.ts) — 23:30 close while the US is on daylight saving, 23:55 otherwise, holidays and half days from its
 * calendar; a closed day is an empty window [0, 0).
 */
export function sessionWindow(market: Market, t: number): readonly [number, number] {
  if (market === 'NSE') return [9 * 60 + 15, 15 * 60 + 30];
  if (market === 'NSE_FNO') return [9 * 60 + 15, 15 * 60 + 40];
  const s = mcxSession(istIso(t));
  return s.open >= s.close ? [0, 0] : [hhmmToMin(s.open), hhmmToMin(s.close)];
}

/**
 * True inside the market's continuous session. The NSE pre-open (09:00-09:08) streams indicative index values that are not
 * trades, and the history API has no bars for them: a tick outside the session must never become a chart bar.
 */
export function inSession(t: number, market: Market): boolean {
  const m = istMinuteOfDay(t);
  const [open, close] = sessionWindow(market, t);
  return m >= open && m < close;
}

/**
 * Whether the feed's previous close (the Quote packet's `close`) can be trusted at `t`. It holds the previous session's close
 * until the closing bell, then flips to today's close (equal to the LTP: a false 0.00%), and stays flipped over a weekend or a
 * holiday. So: a trading day (`tradingDay`, the caller's exchange calendar), a weekday, and before the market's close.
 * Gated on time, never on close === ltp, which is the genuine state before the open.
 */
export function feedCloseTrusted(t: number, market: Market, tradingDay: boolean): boolean {
  const weekday = new Date((t + IST_OFFSET_S) * 1000).getUTCDay();
  return tradingDay && weekday >= 1 && weekday <= 5 && istMinuteOfDay(t) < sessionWindow(market, t)[1];
}

/**
 * A history refresh laid over the bars on screen: the API's bars, then any bars built from live ticks that are newer than the
 * API's last bar (the API can lag a minute or two; dropping them would un-paint closed boxes until it catches up), then the
 * latest tick folded on top.
 */
export function mergeHistory(hist: Bar[], onScreen: Bar[], tick: Tick | null, single = false): Bar[] {
  if (!hist.length) return hist;
  const lastT = hist[hist.length - 1].t;
  const merged = [...hist, ...onScreen.filter(b => b.t > lastT)];
  return tick && tick.t >= lastT ? foldTick(merged, tick, single).bars : merged;
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
