import { kotakGet, kotakPost, kotakRows, KOTAK_PATHS, KotakRejectedError } from '@/lib/kotakToken';
import { findRecentKotakOrder } from '@/lib/kotakShape';

// The one way a dashboard route places a Kotak order. Three outcomes, never two:
//  - placed:   Kotak returned an order number, or the order was found in the order book after an unclean reply;
//  - rejected: Kotak answered and refused (KotakRejectedError), so nothing was placed and a retry is safe;
//  - unknown:  timeout / network / unreadable or id-less reply, and the order book did not show it within ~5 s. It MAY be
//              live: callers must report it as unknown and must not retry or unwind around it automatically.
// Reporting "unknown" as "failed" invites a retry that doubles (or, for a close, flips) the position.

export type KotakPlaceResult =
  | { status: 'placed'; orderId: string; reconciled: boolean }
  | { status: 'rejected'; error: string }
  | { status: 'unknown'; error: string };

export const KOTAK_UNKNOWN_MSG = 'Order status unknown - Kotak did not confirm in time and it is not in the order book yet. Check Orders/Positions before retrying.';

async function reconcile(want: { symbol: string; side: 'BUY' | 'SELL'; qty: number; since: number }): Promise<string | null> {
  for (const wait of [1000, 1500, 2500]) {
    await new Promise(r => setTimeout(r, wait));
    try {
      const id = findRecentKotakOrder(kotakRows(await kotakGet(KOTAK_PATHS.orderBook)), want);
      if (id) return id;
    } catch { /* order book unreadable this time: look again */ }
  }
  return null;
}

/** `payload` is Kotak's own place-order body (`ts` symbol, `tt` B/S, `qt` absolute quantity, ...). */
export async function placeKotakOrder(payload: Record<string, string>): Promise<KotakPlaceResult> {
  const want = {
    symbol: String(payload.ts), side: (payload.tt === 'B' ? 'BUY' : 'SELL') as 'BUY' | 'SELL',
    qty: Math.round(Number(payload.qt)), since: Date.now(),
  };
  try {
    const json = await kotakPost(KOTAK_PATHS.placeOrder, payload);
    const data = (typeof json.data === 'object' && json.data !== null ? json.data : {}) as Record<string, unknown>;
    const orderId = json.nOrdNo ?? data.nOrdNo;
    if (json.stat === 'Ok' && orderId) return { status: 'placed', orderId: String(orderId), reconciled: false };
    console.error('[kotakPlaceOrder] reply without an order number, reconciling:', JSON.stringify(json));
  } catch (err) {
    if (err instanceof KotakRejectedError) return { status: 'rejected', error: err.message };
    console.error('[kotakPlaceOrder] no clean reply, reconciling:', err);
  }
  const found = await reconcile(want);
  return found ? { status: 'placed', orderId: found, reconciled: true } : { status: 'unknown', error: KOTAK_UNKNOWN_MSG };
}
