// One chart's price feed, the steps shared by the page (components/straddlePnf/usePnfFeed.ts) and the server AUTO engine
// (lib/pnfServerFeed.ts), so both fold the same live prices into the same bars. Pure: no I/O, no clocks.
import { foldTick, inSession, isWildTick, legsTick, type LegQuote, type Market, type Tick } from './straddlePnfLive.ts';
import type { Bar } from './straddlePnf.ts';

export type Instrument = { segment: string; security_id: string };

/** A chart bar this old (s) means the feed has stopped: AUTO enters nothing and exits on the closed brick only. */
export const FEED_FRESH_S = 180;
export const feedStale = (lastT: number | undefined, nowS: number) => lastT === undefined || nowS - lastT > FEED_FRESH_S;

/**
 * The session clock follows the contract: MCX for a commodity future / option, NSE F&O, a stock with derivatives (its continuous
 * session stops at 15:15, Closing Auction Session), else NSE.
 */
export function marketOf(instruments: Instrument[], cas?: boolean): Market {
  const seg = instruments[0]?.segment;
  return seg === 'MCX_COMM' ? 'MCX' : seg === 'NSE_FNO' ? 'NSE_FNO' : seg === 'NSE_EQ' && cas ? 'NSE_CAS' : 'NSE';
}

/** The bridge's ids for a chart's instruments: "SEG:ID[,SEG:ID]". */
export const idsOf = (instruments: Instrument[]) => instruments.map(i => `${i.segment}:${i.security_id}`).join(',');

/**
 * What one read of the live legs does: nothing (no price yet), `wild` (a print 10x from the last bar's close: never charted), `out`
 * (outside the session: header only, pre-open prices are indicative), `head` (Tick mode: the bars come from the tick log, the price
 * is for the header) or `fold` (into the 1-minute bars with foldTick).
 */
export type LiveRead = { kind: 'none' } | { kind: 'wild' | 'out' | 'head' | 'fold'; tick: Tick };

export function liveRead(lastClose: number | undefined, legs: LegQuote[], market: Market, tickMode: boolean): LiveRead {
  const tick = legsTick(legs);
  if (!tick) return { kind: 'none' };
  if (isWildTick(lastClose, tick.ce + tick.pe)) return { kind: 'wild', tick };
  if (!inSession(tick.t, market)) return { kind: 'out', tick };
  return { kind: tickMode ? 'head' : 'fold', tick };
}

/** A live read folded into the 1-minute bars (`single`: one leg, carried as ce with pe 0). */
export function foldLive(bars: Bar[], tick: Tick, single: boolean): Bar[] {
  return bars.length ? foldTick(bars, tick, single).bars : bars;
}
