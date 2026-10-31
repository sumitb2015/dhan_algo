// Previous-session levels for a P&F chart's CPR / pivot lines. Pure (tested in lib/pnfCpr.test.ts).
// The chart's history is 1-minute closes (no wicks), so the previous session's high / low are the extremes of its closes: a
// close-based approximation of the exchange's daily high / low (a little tighter on a spiky day).
import { sessionOf, type Bar } from './straddlePnf.ts';

export interface PrevSession { session: string; high: number; low: number; close: number }

/** The last COMPLETED session before `todayIso` that has bars, from the chart's price series (`value` picks a bar's price). */
export function prevSessionHlc(bars: Bar[], todayIso: string, value: (b: Bar) => number = b => b.ce + b.pe): PrevSession | null {
  let session = '';
  for (const b of bars) {
    const s = sessionOf(b.t);
    if (s < todayIso && s > session && value(b) > 0) session = s;
  }
  if (!session) return null;
  let high = -Infinity, low = Infinity, close = 0, closeT = -Infinity;
  for (const b of bars) {
    if (sessionOf(b.t) !== session) continue;
    const v = value(b);
    if (!(v > 0)) continue;
    if (v > high) high = v;
    if (v < low) low = v;
    if (b.t > closeT) { closeT = b.t; close = v; }
  }
  return Number.isFinite(high) && close > 0 ? { session, high, low, close } : null;
}
