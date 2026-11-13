/**
 * Fresh Money: price a close made OUTSIDE this page (pure, no I/O). REAL MONEY bookkeeping.
 *
 * The down-only reconcile writes a synthetic `external` record when the broker no longer holds a quantity this page
 * opened (an MIS auto square-off, a close from the broker's app or another desk). Without a price the day's booked P&L
 * reads unknown for the rest of the day (2026-11-13: a Kotak app close at 15:13 blanked Booked and P&L). The broker's
 * order book usually shows that close with its fill price; this picks it, and ONLY when the match is unambiguous:
 *   same contract handle, same side, intraday product, filled, an order id this ledger never sent, entered between the
 *   page's last own order on that contract and the reconcile (plus a little skew), and the fills add up to exactly the
 *   quantity written down (one order of exactly that size, or all candidates together). Anything else stays unknown —
 *   never a guess. NSE only: Kotak's MCX order quantity is in a different unit from the ledger's.
 */
import type { FmOrder } from './freshMoneyTrades.ts';

/** One filled order-book row, normalised across brokers. `ts` null = its time could not be read. */
export interface BookFill {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  filledQty: number;
  avgPrice: number;
  ts: number | null;
  product: string;
}

const SKEW_MS = 2_000;
/** The reconcile reads positions after the close; the order is entered at most this long before... after the record. */
const AFTER_MS = 10_000;

export interface ExternalPrice { avgPrice: number; orderIds: string[] }

export function priceExternalClose(rec: FmOrder, orders: FmOrder[], book: BookFill[], intraday: string): ExternalPrice | null {
  if (!rec.external || rec.avgPrice !== null || (rec.segment ?? 'NSE_FNO') !== 'NSE_FNO') return null;
  const key = (o: FmOrder) => `${o.broker ?? 'dhan'}|${o.securityId}`;
  const k = key(rec);
  // The window opens at the page's last own order on this contract before the record.
  let since = -Infinity;
  const known = new Set<string>();
  for (const o of orders) {
    if (o.orderId) known.add(o.orderId);
    for (const id of o.externalOrderIds ?? []) known.add(id);
    if (o !== rec && !o.external && key(o) === k && o.ts <= rec.ts) since = Math.max(since, o.ts);
  }
  if (since === -Infinity) return null;
  const match = book.filter(f =>
    f.symbol === rec.securityId && f.side === rec.side && f.product.toUpperCase() === intraday && f.filledQty > 0
    && f.avgPrice > 0 && !known.has(f.orderId));
  // A matching row whose time cannot be read makes the window undecidable.
  if (match.some(f => f.ts === null)) return null;
  const inWin = match.filter(f => (f.ts as number) >= since - SKEW_MS && (f.ts as number) <= rec.ts + AFTER_MS);
  if (!inWin.length) return null;
  const exact = inWin.filter(f => f.filledQty === rec.qty);
  const pick = exact.length === 1 ? exact
    : inWin.reduce((s, f) => s + f.filledQty, 0) === rec.qty ? inWin : null;
  if (!pick) return null;
  const qty = pick.reduce((s, f) => s + f.filledQty, 0);
  const avgPrice = Math.round((pick.reduce((s, f) => s + f.avgPrice * f.filledQty, 0) / qty) * 100) / 100;
  return { avgPrice, orderIds: pick.map(f => f.orderId) };
}
