// Pure rules for /api/scalper/kotak/order: the per-source lot cap and derivative price snapping. Kept out of the route
// so they are unit-tested without ever reaching an order API.

/** Per-source cap on LOTS per order — the server-side twin of a page's own limit, a backstop against a UI bug, not an
 *  auth boundary (fast-order's SOURCE_QTY_CAPS has the same shape). Only a caller that names its source is capped, and
 *  callers name it on OPENING orders only: a close must never be refused for its size. 'as' = Advanced Scalper
 *  (its MAX_LOTS_PER_ORDER = 100). */
export const SOURCE_LOT_CAPS: Record<string, number> = { as: 100 };

/** NSE/BSE options and futures tick at 0.05; used only when the instrument cache has no tick for the contract. */
export const DEFAULT_FO_TICK = 0.05;

/** Why an order must be refused under its source's lot cap, or null. `lotSize` is null when the contract is unknown. */
export function sourceLotCapError(qty: number, source: string | undefined, symbol: string, lotSize: number | null): string | null {
  const cap = source ? SOURCE_LOT_CAPS[source] : undefined;
  if (cap === undefined) return null;
  // Without the contract the lot size is unknown, so a capped (opening) order fails closed. Rejected, never clamped.
  if (!(lotSize && lotSize > 0)) return `${symbol} is not in the Kotak instrument cache - cannot check the ${source} per-order cap`;
  if (qty > cap * lotSize) return `Quantity ${qty} (${qty / lotSize} lots) exceeds the ${source} per-order cap of ${cap} lots`;
  return null;
}

/** A derivative price on the contract's own tick, as the 2-decimal string Kotak takes. An MCX future ticks at 1.00
 *  (CRUDEOILM19NOV26FUT): a 0.05 grid put its limit off-tick. */
export function snapToTick(value: number, tick: number | null | undefined): string {
  const t = tick && tick > 0 ? tick : DEFAULT_FO_TICK;
  return (Math.round(value / t) * t).toFixed(2);
}
