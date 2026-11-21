// Pure rule for the Kotak day lock (no imports, so node --test can load it). The order path is lib/kotakDayLock.ts.

/** Would this order take |net| of the leg further from flat (open, add, or flip through zero)? */
export function orderAddsExposure(side: 'B' | 'S', qty: number, netQty: number): boolean {
  if (!(qty > 0)) return false;
  if (netQty === 0) return true;
  const sameDirection = (side === 'B') === (netQty > 0);
  if (sameDirection) return true;
  return qty > Math.abs(netQty);   // an oversize reducing order flips the position: the excess is a new position
}

/** One position row's net quantity, as the gate's book snapshot keeps it. */
export interface LockBookRow { symbol: string; product: string; net: number }

/**
 * The gate's decision for one order on a locked day (null lock = unlocked = allow). `book` null = the book could not be read
 * and nothing recent is remembered: allow (an exit must never be trapped; the guard's flatten still closes what slips through).
 */
export function lockGateDecision(
  lock: { products: string[] } | null,
  order: { symbol: string; product: string; side: 'B' | 'S'; qty: number },
  book: LockBookRow[] | null,
): 'allow' | 'refuse' {
  if (!lock) return 'allow';
  if (order.product && !lock.products.includes(order.product)) return 'allow';   // a product the loss limit does not cover
  if (!book) return 'allow';
  const net = book.filter(r => r.symbol === order.symbol && r.product === order.product).reduce((n, r) => n + r.net, 0);
  return orderAddsExposure(order.side, order.qty, net) ? 'refuse' : 'allow';
}
