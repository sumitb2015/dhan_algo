// Resting orders on a Point & Figure chart's B / S rail: what a click means and when a held order fills. Pure (tested in
// lib/pnfResting.test.ts). The click rule is the Price Ladder's own Plain / "Anywhere" rule (lib/priceLadder.ts classifyClick):
// a BUY below the last price / SELL above it is a LIMIT; the other side is an SL-limit (trigger at the level, limit a buffer
// past it, stopLimitPrice). Prices are snapped to the contract's tick so the exchange accepts them.
import { classifyClick, stopLimitPrice } from './priceLadder.ts';

export type RestingSide = 'BUY' | 'SELL';
export type RestingKind = 'limit' | 'stop';
export const DEFAULT_BUFFER_PCT = 2;

export interface RestingSpec {
  side: RestingSide;
  kind: RestingKind;
  /** The box price clicked. */
  level: number;
  /** LIMIT: the limit. SL-limit: the limit once triggered. */
  price: number;
  /** SL-limit only. */
  trigger?: number;
}

/** `v` on the tick grid: `up` / `down` / to the nearest. A 2-decimal result (exchange prices), never 0 or less. */
export function snapToTick(v: number, tick: number, dir: 'up' | 'down' | 'nearest'): number {
  const t = tick > 0 ? tick : 0.05;
  const n = v / t;
  const k = dir === 'up' ? Math.ceil(n - 1e-9) : dir === 'down' ? Math.floor(n + 1e-9) : Math.round(n);
  return Number((k * t).toFixed(2));
}

/**
 * The order a click on the rail places: `level` = the box price, `ref` = the last price. A LIMIT is snapped so it never
 * pays more than the box (BUY down, SELL up); an SL-limit's trigger is snapped past the box (BUY up, SELL down) so it
 * never triggers before the price reaches it.
 */
export function planResting(p: { side: RestingSide; level: number; ref: number; tick: number; bufferPct?: number }): RestingSpec | { error: string } {
  const v = classifyClick({ mode: 'plain', opt: 'CE', side: p.side, level: p.level, ref: p.ref, orderType: 'SL', zones: 'anywhere' });
  if (!v.ok) return { error: v.error };
  if (v.kind === 'limit') {
    const price = snapToTick(p.level, p.tick, p.side === 'BUY' ? 'down' : 'up');
    return price > 0 ? { side: p.side, kind: 'limit', level: p.level, price } : { error: 'Invalid price' };
  }
  const trigger = snapToTick(p.level, p.tick, p.side === 'BUY' ? 'up' : 'down');
  const price = stopLimitPrice(p.side, trigger, p.bufferPct ?? DEFAULT_BUFFER_PCT, p.tick > 0 ? p.tick : 0.05);
  if (!(trigger > 0) || price === null) return { error: 'Invalid trigger' };
  return { side: p.side, kind: 'stop', level: p.level, price, trigger };
}

/** True once the live price has reached a held level: a BUY limit at or below it, a BUY stop at or above, SELL mirrored. */
export function reached(side: RestingSide, kind: RestingKind, level: number, live: number): boolean {
  if (!(live > 0) || !(level > 0)) return false;
  const below = kind === 'limit' ? side === 'BUY' : side === 'SELL';
  return below ? live <= level : live >= level;
}

/**
 * A PAPER resting order against the live price: a LIMIT fills once reached, at its limit or better; an SL-limit triggers
 * once the trigger is reached and then fills at its limit or better while the price is still inside the limit. `triggered`
 * carries the trigger over ticks.
 */
export function paperStep(o: Pick<RestingSpec, 'side' | 'kind' | 'price' | 'trigger'> & { triggered?: boolean }, live: number):
  { fill: false; triggered: boolean } | { fill: true; price: number } {
  if (!(live > 0)) return { fill: false, triggered: !!o.triggered };
  const better = (px: number) => (o.side === 'BUY' ? Math.min(px, live) : Math.max(px, live));
  if (o.kind === 'limit') return reached(o.side, 'limit', o.price, live) ? { fill: true, price: better(o.price) } : { fill: false, triggered: false };
  const triggered = !!o.triggered || reached(o.side, 'stop', o.trigger ?? o.price, live);
  if (!triggered) return { fill: false, triggered: false };
  const inside = o.side === 'BUY' ? live <= o.price : live >= o.price;
  return inside ? { fill: true, price: better(o.price) } : { fill: false, triggered: true };
}
