// Index Scalper paper WORKING orders (SIM): a limit away from the market, a stop (SL-M) or a stop-limit (SL) rests on the
// paper book and fills when the contract's own live price reaches it, the way the exchange would:
//   LIMIT  rests; fills at ITS price once the price trades there (a resting limit is the maker: it never gets a better
//          fill on a tick feed, and never a worse one).
//   SL-M   fires when the price reaches the trigger and fills at that live price (a market order: slippage included).
//   SL     fires at the trigger and becomes a limit at its price: filled at once at the live price if that is marketable,
//          else it rests as that limit.
// Placement checks are the broker's own (`orderEditError`: a limit must not be marketable, a stop's trigger must be on
// the far side of the price). Pure: no React; the terminal keeps the list, runs `simOrderStep` on each price update and
// books fills through its paper ledger. Tested in indexScalperSimOrders.test.ts.

import type { OrderRowView } from './indexScalperAccount.ts';

export type SimOrderType = 'LIMIT' | 'STOP_LOSS_MARKET' | 'STOP_LOSS';

export interface SimOrder {
  id: string;
  /** NIFTY / CRUDEOILM / CRUDEOIL: the feed streams only the instrument on screen, so an order fills while it is shown. */
  underlying: string;
  /** The contract's live-price key (Dhan security id) and how it is shown. */
  securityId: string;
  symbol: string;
  type: 'CE' | 'PE' | 'FUT';
  strike: number;
  expiry: string;
  side: 'BUY' | 'SELL';
  orderType: SimOrderType;
  price: number | null;
  trigger: number | null;
  /** Contract units (what the paper ledger books) and lots (shown). */
  units: number;
  lots: number;
  product: string;
  /** A stop-limit whose trigger was reached: it now rests as a limit at `price`. */
  triggered?: boolean;
  placedAt: number;
  /** IST day the order was placed: paper orders are DAY orders. */
  day: string;
}

const TYPE_LABEL: Record<SimOrderType, string> = { LIMIT: 'LIMIT', STOP_LOSS_MARKET: 'SL-M', STOP_LOSS: 'SL' };

export const isSimOrderId = (id: string) => id.startsWith('SIM-');

/** True when a limit at `price` would trade at once against `live` (a buy at or above it, a sell at or below it). */
export function limitMarketable(side: 'BUY' | 'SELL', price: number, live: number): boolean {
  return side === 'BUY' ? price >= live : price <= live;
}

/** One price update for one working order: the fill price when it fills now, else the (possibly triggered) order. */
export function simOrderStep(o: SimOrder, live: number): { fill: number | null; order: SimOrder } {
  if (!(live > 0)) return { fill: null, order: o };
  const buy = o.side === 'BUY';
  const asLimit = o.orderType === 'LIMIT' || (o.orderType === 'STOP_LOSS' && o.triggered);
  if (asLimit) {
    const px = o.price ?? 0;
    if (px > 0 && (buy ? live <= px : live >= px)) return { fill: px, order: o };
    return { fill: null, order: o };
  }
  const trig = o.trigger ?? 0;
  if (!(trig > 0) || !(buy ? live >= trig : live <= trig)) return { fill: null, order: o };
  if (o.orderType === 'STOP_LOSS_MARKET') return { fill: live, order: o };
  // Stop-limit fired: marketable now -> filled at the live price; otherwise it rests as a limit from here on.
  const px = o.price ?? 0;
  if (px > 0 && limitMarketable(o.side, px, live)) return { fill: live, order: o };
  return { fill: null, order: { ...o, triggered: true } };
}

/** The paper order as an Orders-tab / chart row: own, cancellable, editable, status says SIM. */
export function simOrderRow(o: SimOrder): OrderRowView {
  const contract = o.type === 'FUT' ? `${o.underlying} FUT` : `${o.underlying} ${o.strike} ${o.type === 'CE' ? 'CALL' : 'PUT'}`;
  const hhmm = new Date(o.placedAt + 19_800_000).toISOString().slice(11, 19);
  return {
    id: o.id, securityId: o.securityId, isOption: o.type !== 'FUT',
    symbol: `${contract} (SIM)`, exchange: 'SIM', time: hhmm, sortKey: `9999-${String(o.placedAt).padStart(15, '0')}`,
    side: o.side, orderType: o.triggered ? 'SL (triggered)' : TYPE_LABEL[o.orderType], product: o.product,
    qty: o.units, tradedQty: 0, price: o.price, trigger: o.trigger, avgTraded: null,
    status: 'PENDING (SIM)', bucket: 'open', reason: '', cancellable: true, own: true,
    rawType: o.triggered ? 'LIMIT' : o.orderType, segment: 'SIM',
  };
}

/** Saved paper orders read back: today's well-formed ones only. */
export function validSimOrders(x: unknown, today: string): SimOrder[] {
  if (!Array.isArray(x)) return [];
  return x.filter((o): o is SimOrder => !!o && typeof o === 'object'
    && typeof (o as SimOrder).id === 'string' && isSimOrderId((o as SimOrder).id)
    && typeof (o as SimOrder).securityId === 'string' && typeof (o as SimOrder).underlying === 'string' && (o as SimOrder).day === today
    && ((o as SimOrder).side === 'BUY' || (o as SimOrder).side === 'SELL')
    && ['LIMIT', 'STOP_LOSS_MARKET', 'STOP_LOSS'].includes((o as SimOrder).orderType)
    && Number((o as SimOrder).units) > 0);
}
