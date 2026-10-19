import { kiteGet, kitePost, KiteRejectedError } from './zerodhaToken.ts';

// The one way a dashboard route places a Zerodha order. Three outcomes, never two (twin of lib/kotakPlaceOrder.ts):
//  - placed:   Kite returned an order id, or the order was found in the order book (by its tag) after an unclean reply;
//  - rejected: Kite answered with a refusal (KiteRejectedError), so nothing was placed and a retry is safe;
//  - unknown:  timeout / network / 5xx / id-less reply, and the order book did not show it within ~5 s. It MAY be live:
//              callers must report it as unknown and must not retry or unwind around it automatically.

export type ZerodhaPlaceResult =
  | { status: 'placed'; orderId: string; reconciled: boolean }
  | { status: 'rejected'; error: string }
  | { status: 'unknown'; error: string };

export const ZERODHA_UNKNOWN_MSG = 'Order status unknown - Zerodha did not confirm in time and it is not in the order book yet. Check Orders/Positions before retrying.';

/** Kite tags are alphanumeric, max 20 chars. */
export function newOrderTag(): string {
  return 'DX' + crypto.randomUUID().replace(/-/g, '').slice(0, 18);
}

/** The order id of the order carrying `tag`, or null. Pure. */
export function findOrderByTag(orders: unknown, tag: string): string | null {
  if (!Array.isArray(orders)) return null;
  const hit = orders.find(o => o && typeof o === 'object' && (o as { tag?: unknown }).tag === tag) as { order_id?: unknown } | undefined;
  return hit?.order_id != null && hit.order_id !== '' ? String(hit.order_id) : null;
}

async function reconcile(tag: string): Promise<string | null> {
  for (const wait of [1000, 1500, 2500]) {
    await new Promise(r => setTimeout(r, wait));
    try {
      const id = findOrderByTag(await kiteGet('/orders'), tag);
      if (id) return id;
    } catch { /* order book unreadable this time: look again */ }
  }
  return null;
}

/** `params` is Kite's own /orders/regular form body; a tag is added so an unclean reply can be reconciled. */
export async function placeZerodhaOrder(params: Record<string, string | number>): Promise<ZerodhaPlaceResult> {
  const tag = newOrderTag();
  try {
    const data = await kitePost('/orders/regular', { ...params, tag }) as { order_id?: unknown } | null;
    if (data?.order_id) return { status: 'placed', orderId: String(data.order_id), reconciled: false };
    console.error('[zerodhaPlaceOrder] reply without an order id, reconciling');
  } catch (err) {
    if (err instanceof KiteRejectedError) return { status: 'rejected', error: err.message };
    console.error('[zerodhaPlaceOrder] no clean reply, reconciling:', err);
  }
  const found = await reconcile(tag);
  return found ? { status: 'placed', orderId: found, reconciled: true } : { status: 'unknown', error: ZERODHA_UNKNOWN_MSG };
}

/**
 * Places `params` as one order per slice, in order, stopping at the first slice that is not placed. A single slice is
 * exactly `placeZerodhaOrder`. When a LATER slice fails, part of the quantity is already live, so the result is `unknown`
 * (never `rejected`): the caller must not retry or unwind around it automatically.
 */
export async function placeZerodhaOrderSliced(params: Record<string, string | number>, slices: number[]): Promise<ZerodhaPlaceResult> {
  if (slices.length <= 1) return placeZerodhaOrder(params);
  let placedQty = 0;
  let firstId = '';
  for (let i = 0; i < slices.length; i++) {
    const r = await placeZerodhaOrder({ ...params, quantity: slices[i] });
    if (r.status !== 'placed') {
      if (i === 0) return r;
      return { status: 'unknown', error: `${placedQty} of ${slices.reduce((a, b) => a + b, 0)} placed in ${i} order(s), then slice ${i + 1}/${slices.length} failed (${r.error}) - check Positions before retrying` };
    }
    placedQty += slices[i];
    firstId ||= r.orderId;
  }
  return { status: 'placed', orderId: firstId, reconciled: false };
}
