import { dhanGet } from '@/lib/dhanToken';
import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakOrderStatus } from '@/lib/kotakShape';
import { kiteGet } from '@/lib/zerodhaToken';
import { shapeZerodhaOrderStatus } from '@/lib/zerodhaShape';
import type { OrderPriceRead } from '@/lib/tradedPriceClient';

// One order's live status at Dhan, Kotak or Zerodha: /api/scalper/orders?orderId= for the browser, and the server AUTO engine
// (lib/pnfAutoEngine.ts) reading back its fill prices with no tab open. Read-only.

export interface OrderStatus { orderId: string; orderStatus: string; quantity: number; filledQty: number; averageTradedPrice: number; reason: string }
type Book = { at: number; p: Promise<Record<string, unknown>[]> } | null;
// Kotak has no single-order endpoint, so every status read is a whole order-book call. Several confirm loops poll at once (one per
// leg, ~2.5/s each): one in-flight / just-finished read serves them all. Kite the same. On globalThis: the route and the engine share it.
const BOOK_TTL_MS = 350;
const g = globalThis as unknown as { __orderStatusBooks?: { kotak: Book; zerodha: Book } };
const books = (g.__orderStatusBooks ??= { kotak: null, zerodha: null });

function shared(which: 'kotak' | 'zerodha', read: () => Promise<Record<string, unknown>[]>): Promise<Record<string, unknown>[]> {
  const b = books[which];
  if (b && Date.now() - b.at < BOOK_TTL_MS) return b.p;
  const p = read();
  books[which] = { at: Date.now(), p };
  // A failed read must not be served to the next caller.
  p.catch(() => { if (books[which]?.p === p) books[which] = null; });
  return p;
}

/** After a modify / cancel: the next status read goes to Kite again. */
export const forgetZerodhaBook = () => { books.zerodha = null; };

/** The order's status, or null when the broker does not list it. Throws on a failed read. */
export async function readBrokerOrder(orderId: string, broker: 'dhan' | 'kotak' | 'zerodha'): Promise<OrderStatus | null> {
  if (broker === 'kotak') {
    const book = await shared('kotak', () => kotakGet(KOTAK_PATHS.orderBook).then(kotakRows));
    const o = book.find(r => String(r.nOrdNo ?? r.orderId ?? '') === orderId);
    return o ? shapeKotakOrderStatus(o, orderId) as OrderStatus : null;
  }
  if (broker === 'zerodha') {
    // Kite's per-order endpoint returns the whole history; the order book already carries the latest state.
    const book = await shared('zerodha', () => kiteGet('/orders').then(r => (Array.isArray(r) ? r as Record<string, unknown>[] : [])));
    const o = book.find(r => String(r.order_id ?? '') === orderId);
    return o ? shapeZerodhaOrderStatus(o, orderId) as OrderStatus : null;
  }
  const raw = await dhanGet(`/orders/${orderId}`, 5_000);
  // Dhan returns either the order object or a one-element array.
  const o = (Array.isArray(raw) ? raw[0] : raw) as Record<string, unknown> | undefined;
  if (!o || typeof o !== 'object') return null;
  return {
    orderId: String(o.orderId ?? orderId),
    orderStatus: String(o.orderStatus ?? '').toUpperCase(),
    quantity: Number(o.quantity) || 0,
    filledQty: Number(o.filledQty) || 0,
    averageTradedPrice: Number(o.averageTradedPrice) || 0,
    reason: String(o.omsErrorDescription ?? o.omsErrorCode ?? ''),
  };
}

/** The server's twin of tradedPriceClient.readOrderPrice: null = unreadable or not listed. */
export async function readOrderPriceServer(orderId: string, broker: 'dhan' | 'kotak' | 'zerodha'): Promise<OrderPriceRead | null> {
  try {
    const o = await readBrokerOrder(orderId, broker);
    return o ? { status: o.orderStatus, filledQty: o.filledQty, avg: o.averageTradedPrice } : null;
  } catch { return null; }
}
