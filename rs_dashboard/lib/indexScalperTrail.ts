// Index Scalper trailing stop loss (TSL) on one position: the stop sits `pts` behind the best price the position's own
// instrument has reached (an option's premium, the future's price) and only ever tightens. The rule IS the XY ladder's
// continuous trail (`bracketStep` with `trailMode: 'distance'`, lib/priceLadder.ts), reused, not copied.
//
// Browser-only, by the owner's choice (2026-11-25): no order rests at the broker. The terminal's leader tab watches the
// price and sends a market exit when the stop is crossed; closing the tab or the dashboard stops the trail. Pure: no React.

import { bracketStep } from './priceLadder.ts';

export interface TrailState {
  legId: string;
  securityId: string;
  isLong: boolean;
  /** Distance behind the best price, in the instrument's own points. */
  pts: number;
  /** Best price reached since the trail was set (highest for a long, lowest for a short). */
  peak: number;
  /** The trailed stop. */
  sl: number;
  /** Price when the trail was set. */
  entry: number;
  mode: 'SIM' | 'REAL';
  broker: string;
  setAt: number;
}

const DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;

const onTick = (x: number, tick: number) => Math.abs(Math.round(x / tick) * tick - x) < 1e-6;

/** Snap a stop to the tick AWAY from the price (a long's stop down, a short's up), tolerant of float noise. */
function snapStop(price: number, tick: number, isLong: boolean): number {
  const steps = price / tick;
  const n = isLong ? Math.floor(steps + 1e-9) : Math.ceil(steps - 1e-9);
  return Number((n * tick).toFixed(2));
}

/** The typed distance: plain decimal points, at least one tick, on the tick. */
export function parseTrailPoints(text: string, tick: number): { pts: number; error: null } | { pts: null; error: string } {
  const t = text.trim();
  if (!DECIMAL.test(t)) return { pts: null, error: 'Enter the trail distance in points (e.g. 10)' };
  const pts = Number(t);
  if (!(pts > 0)) return { pts: null, error: 'Enter a distance above 0' };
  if (pts < tick - 1e-9) return { pts: null, error: `At least one tick (${tick.toFixed(2)})` };
  if (!onTick(pts, tick)) return { pts: null, error: `Use the ${tick.toFixed(2)} tick` };
  return { pts, error: null };
}

/** A new trail from the live price: stop `pts` behind it. Error text without a live price or with a stop at or below 0. */
export function armTrail(
  leg: { id: string; securityId: string; netQty: number }, ltp: number | null, pts: number, tick: number,
  mode: 'SIM' | 'REAL', broker: string, now = Date.now(),
): TrailState | string {
  if (leg.netQty === 0) return 'The position is flat';
  if (ltp === null || !(ltp > 0)) return 'No live price: cannot start a trailing stop now';
  const isLong = leg.netQty > 0;
  const sl = snapStop(isLong ? ltp - pts : ltp + pts, tick, isLong);
  if (!(sl > 0)) return `A ${pts}-point trail from ${ltp.toFixed(2)} leaves a stop at 0 or below`;
  return { legId: leg.id, securityId: leg.securityId, isLong, pts, peak: ltp, sl, entry: ltp, mode, broker, setAt: now };
}

/** One price update: ratchet the peak and the stop (never loosening), and say whether the stop was crossed. */
export function stepTrail(t: TrailState, ltp: number, tick: number): { state: TrailState; hit: boolean } {
  if (!(ltp > 0)) return { state: t, hit: false };
  const b = t.isLong ? 1 : -1;
  const r = bracketStep(
    { entryY: t.entry, slY: t.sl, peakY: t.peak, bracket: { tgtPts: 0, slPts: t.pts, trailPts: t.pts, trailMode: 'distance' } },
    b, ltp,
  );
  const raw = r.slY ?? t.sl;
  const snapped = snapStop(raw, tick, t.isLong);
  const sl = t.isLong ? Math.max(t.sl, snapped) : Math.min(t.sl, snapped);
  const peak = r.peakY ?? t.peak;
  const hit = t.isLong ? ltp <= sl : ltp >= sl;
  const state = sl === t.sl && peak === t.peak ? t : { ...t, sl, peak };
  return { state, hit };
}

/** A new distance on a running trail. The stop is kept where it is (tightened at once if the new distance is closer to
 *  the best price); a wider distance applies from the next new best price, so it never loosens the stop. */
export function retrail(t: TrailState, pts: number, tick: number): TrailState {
  const next = { ...t, pts };
  const cand = snapStop(t.isLong ? t.peak - pts : t.peak + pts, tick, t.isLong);
  const sl = t.isLong ? Math.max(t.sl, cand) : Math.min(t.sl, cand);
  return { ...next, sl };
}

/** False when the trail no longer belongs to an open position: the leg is gone, flipped side, or the page is in another
 *  mode / on another broker than the one it was set in. */
export function trailStillValid(t: TrailState, leg: { netQty: number } | undefined, mode: 'SIM' | 'REAL', broker: string): boolean {
  if (!leg || leg.netQty === 0) return false;
  if ((leg.netQty > 0) !== t.isLong) return false;
  return t.mode === mode && (mode === 'SIM' || t.broker === broker);
}

/** Rows read back from storage: anything malformed is dropped. */
export function validTrails(x: unknown): Record<string, TrailState> {
  const out: Record<string, TrailState> = {};
  if (!x || typeof x !== 'object') return out;
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) {
    const t = v as Partial<TrailState>;
    if (!t || typeof t !== 'object') continue;
    if (typeof t.legId !== 'string' || t.legId !== k || typeof t.securityId !== 'string' || typeof t.isLong !== 'boolean') continue;
    if (![t.pts, t.peak, t.sl, t.entry].every(n => typeof n === 'number' && Number.isFinite(n) && n > 0)) continue;
    if (t.mode !== 'SIM' && t.mode !== 'REAL') continue;
    out[k] = { legId: t.legId, securityId: t.securityId, isLong: t.isLong, pts: t.pts!, peak: t.peak!, sl: t.sl!, entry: t.entry!, mode: t.mode, broker: String(t.broker ?? ''), setAt: Number(t.setAt) || 0 };
  }
  return out;
}
