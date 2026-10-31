// Previous-session levels for a P&F chart's CPR / pivot lines. Pure (tested in lib/pnfCpr.test.ts).
// The chart's history is 1-minute closes (no wicks), so the previous session's high / low are the extremes of its closes: a
// close-based approximation of the exchange's daily high / low (a little tighter on a spiky day).
import type { Bar } from './straddlePnf.ts';

export interface PrevSession { session: string; high: number; low: number; close: number }

/** The last COMPLETED session before `todayIso` that has bars, from the chart's price series (`value` picks a bar's price). */
export function prevSessionHlc(bars: Bar[], todayIso: string, value: (b: Bar) => number = b => b.ce + b.pe): PrevSession | null {
  // Whole IST days by arithmetic (no Date per bar: this runs on every page render over every 1-minute bar).
  const IST_S = 5.5 * 3600;
  const dayOf = (t: number) => Math.floor((t + IST_S) / 86400);
  const today = Math.floor(Date.parse(`${todayIso}T00:00:00Z`) / 86400_000);
  if (!Number.isFinite(today)) return null;
  let day = -Infinity;
  for (const b of bars) {
    const d = dayOf(b.t);
    if (d < today && d > day && value(b) > 0) day = d;
  }
  if (day === -Infinity) return null;
  const session = new Date(day * 86400_000).toISOString().slice(0, 10);
  let high = -Infinity, low = Infinity, close = 0, closeT = -Infinity;
  for (const b of bars) {
    if (dayOf(b.t) !== day) continue;
    const v = value(b);
    if (!(v > 0)) continue;
    if (v > high) high = v;
    if (v < low) low = v;
    if (b.t > closeT) { closeT = b.t; close = v; }
  }
  return Number.isFinite(high) && close > 0 ? { session, high, low, close } : null;
}
