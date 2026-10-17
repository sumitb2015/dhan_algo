/**
 * An order's FINAL traded price, from the browser (Dhan and Kotak: /api/scalper/orders reports a per-order
 * averageTradedPrice). One implementation for every terminal (Focus Tool, Synthetic Futures, Triple Straddle) — see the
 * dhan-fill-price-pnl skill.
 *
 * Only a terminal status counts (TRADED, or CANCELLED / EXPIRED with something filled): a part-traded order's average
 * covers only what has filled so far, and taking it would price the whole slice at a partial average.
 * Dhan's average is CUMULATIVE over the order's fills, so a later slice of the same order is priced on its own via
 * sliceTradedPrice, with `memo` remembering what earlier slices were already priced at.
 */
import { sliceTradedPrice } from './focusToolPnl.ts';

export type TradedSliceMemo = Map<string, { qty: number; atp: number }>;

export interface OrderPriceRead { status: string; filledQty: number; avg: number }
/** A price already in hand (e.g. the page's own order-book poll): checked before any network read. */
export type OrderPeek = (orderId: string) => OrderPriceRead | null | undefined;

const FINAL = new Set(['TRADED', 'CANCELLED', 'CANCELED', 'EXPIRED', 'REJECTED']);

/** The final average from one order read, or 0 while the order is still working / reported nothing. */
export function finalAvgOf(r: OrderPriceRead | null | undefined): number {
  if (!r || !(r.avg > 0)) return 0;
  const st = String(r.status || '').toUpperCase();
  if (st === 'TRADED') return r.avg;
  return FINAL.has(st) && r.filledQty > 0 ? r.avg : 0;
}

/** One network read of the order. Null = unreadable (rate limit, network). */
export async function readOrderPrice(orderId: string, broker: 'dhan' | 'kotak' = 'dhan'): Promise<OrderPriceRead | null> {
  try {
    const r = await fetch(`/api/scalper/orders?orderId=${encodeURIComponent(orderId)}&broker=${broker}`);
    const j = await r.json() as { success?: boolean; data?: { orderStatus?: string; filledQty?: number; averageTradedPrice?: number } };
    if (!j.success || !j.data) return null;
    return { status: String(j.data.orderStatus ?? ''), filledQty: Number(j.data.filledQty) || 0, avg: Number(j.data.averageTradedPrice) || 0 };
  } catch { return null; }
}

/**
 * The traded price of one slice of an order. Waits 1 / 2 / 4 / 8 s between tries (rate limit, order in transit).
 * With `peek`, each try reads that first and only goes to the network when it has nothing final. Null = never
 * reported final: callers fall back rather than treat an estimate as a fill.
 */
export async function fetchSliceTradedPrice(
  orderId: string, kind: 'open' | 'close', sliceQty: number, memo: TradedSliceMemo,
  opts: { peek?: OrderPeek; waits?: readonly number[]; broker?: 'dhan' | 'kotak' } = {},
): Promise<number | null> {
  for (const wait of opts.waits ?? [1000, 2000, 4000, 8000]) {
    await new Promise(res => setTimeout(res, wait));
    let atp = finalAvgOf(opts.peek?.(orderId));
    if (!(atp > 0)) atp = finalAvgOf(await readOrderPrice(orderId, opts.broker));
    if (atp > 0) {
      const key = `${orderId}:${kind}`;
      const prior = memo.get(key);
      const cumQty = (prior?.qty ?? 0) + sliceQty;
      const px = sliceTradedPrice(atp, cumQty, prior);
      memo.set(key, { qty: cumQty, atp });
      return px;
    }
  }
  return null;
}
