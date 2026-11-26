// Editing a working order from the /index-scalper chart: drag its line to a new price, or change its lots. Pure: no
// React. Tested in indexScalperOrderEdit.test.ts. The terminal sends the result through PATCH /api/scalper/orders
// (Dhan PUT /orders/{id}, Kotak modify) with `source: 'isx'`, so the server applies the page's lot cap too.

import { MAX_LOTS } from './indexScalperPositions.ts';

export type EditableType = 'LIMIT' | 'STOP_LOSS' | 'STOP_LOSS_MARKET';

export interface EditableOrder {
  id: string;
  side: 'BUY' | 'SELL' | '';
  rawType: string;
  price: number | null;
  trigger: number | null;
  qty: number | null;
  tradedQty: number | null;
  bucket: string;
  own: boolean;
}

const TYPES = new Set<string>(['LIMIT', 'STOP_LOSS', 'STOP_LOSS_MARKET']);

/** Only this page's own working Limit / SL-limit / SL-M orders are edited here; another placer's order (a strategy's
 *  stop, the mobile app's) is never moved from this page (it can still be cancelled, after a confirmation). */
export function isEditable(o: EditableOrder): boolean {
  return o.own && o.bucket === 'open' && (o.side === 'BUY' || o.side === 'SELL') && TYPES.has(o.rawType);
}

const snap = (v: number, tick: number) => Number((Math.round(v / tick) * tick).toFixed(2));

/** The order's levels after its line moves to `level` (a Limit's line sits at its price, a stop's at its TRIGGER:
 *  `orderLevel`). A Limit moves its price; an SL-M its trigger; an SL-limit's trigger goes to the line and its limit moves
 *  by the same amount, so the cushion stays. */
export function movedLevels(o: EditableOrder, level: number, tick: number): { price: number; trigger: number } {
  const lv = snap(level, tick);
  if (o.rawType === 'LIMIT') return { price: lv, trigger: 0 };
  if (o.rawType === 'STOP_LOSS_MARKET') return { price: 0, trigger: lv };
  const from = o.trigger !== null && o.trigger > 0 ? o.trigger : o.price ?? lv;
  const delta = lv - from;
  return { price: snap((o.price !== null && o.price > 0 ? o.price : from) + delta, tick), trigger: lv };
}

/**
 * Why these levels cannot be sent (null = they can). Checked against the LIVE price, like a new order: a Buy Limit above
 * it (or a Sell Limit below) would fill at once, and a stop on the wrong side would trigger at once; an SL-limit's limit
 * must be at or beyond its trigger in the order's direction. Prices must be on the tick.
 */
export function orderEditError(type: string, side: 'BUY' | 'SELL', price: number, trigger: number, ltp: number | null, tick: number): string | null {
  if (!TYPES.has(type)) return `A ${type || 'market'} order has no price to move`;
  if (ltp === null || !(ltp > 0)) return 'No live price: cannot move the order now';
  const onTick = (v: number) => Math.abs(snap(v, tick) - v) < 1e-6;
  const buy = side === 'BUY';
  if (type === 'LIMIT') {
    if (!(price > 0) || !onTick(price)) return `Enter a price above 0 on the ${tick} tick`;
    if (buy && price >= ltp) return `A Buy Limit at or above the live price ${ltp.toFixed(2)} fills at once: place a Buy Stop instead`;
    if (!buy && price <= ltp) return `A Sell Limit at or below the live price ${ltp.toFixed(2)} fills at once: place a Sell Stop instead`;
    return null;
  }
  if (!(trigger > 0) || !onTick(trigger)) return `Enter a trigger above 0 on the ${tick} tick`;
  if (buy && trigger <= ltp) return `A Buy stop's trigger must be above the live price ${ltp.toFixed(2)}`;
  if (!buy && trigger >= ltp) return `A Sell stop's trigger must be below the live price ${ltp.toFixed(2)}`;
  if (type === 'STOP_LOSS') {
    if (!(price > 0) || !onTick(price)) return `Enter a limit price above 0 on the ${tick} tick`;
    if (buy && price < trigger) return 'A Buy SL-limit\'s limit price must be at or above its trigger';
    if (!buy && price > trigger) return 'A Sell SL-limit\'s limit price must be at or below its trigger';
  }
  return null;
}

/** Why the lots cannot be changed to `lots` (null = they can): whole lots within 1..MAX_LOTS, and not on an order that has
 *  already part-filled (its remaining quantity and the broker's view of the total would then disagree). */
export function editLotsError(lots: number, tradedQty: number | null, maxLots: number = MAX_LOTS): string | null {
  if (!Number.isInteger(lots) || lots < 1) return 'Lots must be a whole number from 1';
  if (lots > maxLots) return `Max ${maxLots} lots per order`;
  if (tradedQty !== null && tradedQty > 0) return 'This order has part-filled: cancel it and place a new one to change its size';
  return null;
}
