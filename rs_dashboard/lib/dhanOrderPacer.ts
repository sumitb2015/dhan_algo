/**
 * Account-wide order pacing. Dhan allows about 10 order requests/second per ACCOUNT, and
 * several routes (scalper/fast-order, super-order) place orders from this one Node process.
 * The window lives on globalThis so route bundles that get their own copy of this module
 * (Turbopack can split them) still share ONE window.
 */
const ORDER_RATE_LIMIT = 8;   // below 10 to leave headroom
export const ORDER_WINDOW_MS = 1_000;

const g = globalThis as unknown as { __dhanOrderSendTimes?: number[] };
const orderSendTimes: number[] = (g.__dhanOrderSendTimes ??= []);

export async function reserveOrderSlot(): Promise<void> {
  for (;;) {
    const now = Date.now();
    while (orderSendTimes.length && now - orderSendTimes[0] >= ORDER_WINDOW_MS) orderSendTimes.shift();
    if (orderSendTimes.length < ORDER_RATE_LIMIT) { orderSendTimes.push(now); return; }
    await new Promise(r => setTimeout(r, orderSendTimes[0] + ORDER_WINDOW_MS - now + 5));
  }
}
