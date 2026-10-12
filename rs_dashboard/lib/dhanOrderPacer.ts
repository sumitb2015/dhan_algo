import { waitForSharedOrderSlot } from './dhanOrderLaneFile.ts';

/**
 * Account-wide order pacing. Dhan allows about 10 order requests/second per ACCOUNT, and several routes
 * (scalper/fast-order, scalper/order, super-order) place orders from this one Node process, while running
 * strategies place theirs from Python.
 *
 * Primary: the cross-process lane (debug/dhan_order_lane.json, shared with lib/dhan_order_lane.py), so the
 * dashboard and every strategy stay under the limit TOGETHER. Fallback, when the lane is unavailable: an
 * in-process sliding window. The window lives on globalThis so route bundles that get their own copy of this
 * module (Turbopack can split them) still share ONE window.
 */
const ORDER_RATE_LIMIT = 8;   // below 10 to leave headroom
export const ORDER_WINDOW_MS = 1_000;

const g = globalThis as unknown as { __dhanOrderSendTimes?: number[] };
const orderSendTimes: number[] = (g.__dhanOrderSendTimes ??= []);

async function reserveInProcessSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (orderSendTimes.length && now - orderSendTimes[0] >= ORDER_WINDOW_MS) orderSendTimes.shift();
    if (orderSendTimes.length < ORDER_RATE_LIMIT) { orderSendTimes.push(now); return; }
    await new Promise(r => setTimeout(r, orderSendTimes[0] + ORDER_WINDOW_MS - now + 5));
  }
}

export async function reserveOrderSlot(): Promise<void> {
  if (await waitForSharedOrderSlot()) return;
  await reserveInProcessSlot();
}
