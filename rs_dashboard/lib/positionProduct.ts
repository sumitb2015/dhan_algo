// Product-aware position identity for close orders.
//
// A broker books positions per (symbol, product). Two consequences drive
// everything here:
//
//  1. Closing a MARGIN/NRML leg with an INTRADAY/MIS order does NOT reduce it.
//     The broker opens a fresh intraday position on the other side instead —
//     doubling exposure and margin at the exact moment the user asked to cut
//     risk. Every close order must carry the product of the position it closes.
//  2. The same symbol can be open under two products at once (a strategy
//     process running NRML while the terminal scalps MIS on the same strike).
//     Identifying a position by trading symbol alone then resolves both rows to
//     whichever the broker happened to list first, so one book gets closed
//     twice and the other never.
//
// Both terminals share this module so the two cannot drift apart.

import type { Broker } from '@/hooks/useBrokerSelector';

/**
 * The product a position row is booked under — upper-cased, '' when the broker
 * reported none.
 *
 * All three position shapers normalise onto `productType`: the Dhan route
 * passes the broker's own field through (INTRADAY / MARGIN / CNC), while
 * lib/zerodhaShape maps Kite's `product` and lib/kotakShape maps Neo's `prod`
 * (both MIS / NRML / CNC).
 */
export function positionProduct(pos: Record<string, unknown>): string {
  return String(pos.productType ?? pos.product ?? '').trim().toUpperCase();
}

/**
 * Identity for per-row UI state — target/SL guards, in-flight close tracking.
 *
 * Keying those by symbol alone makes two same-symbol rows share one guard, so
 * closing either deletes the other's protection while it is still open.
 */
export function positionKey(pos: Record<string, unknown>): string {
  return `${String(pos.tradingSymbol ?? '')}::${positionProduct(pos)}`;
}

/**
 * Result of locating `pos` in a freshly-fetched positions payload.
 *
 * `flat` and `ambiguous` are deliberately distinct: the first means there is
 * nothing left to close, the second means we cannot tell which book an order
 * would hit. Only the first is safe to treat as success.
 */
export type LiveMatch =
  | { kind: 'match'; row: Record<string, unknown> }
  | { kind: 'flat' }
  | { kind: 'ambiguous'; count: number };

/**
 * Locate the live row for `pos` by symbol AND product.
 *
 * When the row being closed carries no product, a symbol-only match is used
 * only if it is unambiguous — one candidate. Guessing between several is what
 * sends an order against the wrong book, so that case is reported rather than
 * resolved.
 */
export function findLivePosition(
  rows: Record<string, unknown>[],
  pos: Record<string, unknown>,
): LiveMatch {
  const sym = String(pos.tradingSymbol ?? '');
  const product = positionProduct(pos);
  const sameSymbol = rows.filter(r => String(r.tradingSymbol) === sym);

  if (product) {
    const row = sameSymbol.find(r => positionProduct(r) === product);
    return row ? { kind: 'match', row } : { kind: 'flat' };
  }

  if (sameSymbol.length === 1) return { kind: 'match', row: sameSymbol[0] };
  if (sameSymbol.length === 0) return { kind: 'flat' };
  return { kind: 'ambiguous', count: sameSymbol.length };
}

/** Products that can be closed with a plain market order, per broker vocabulary. */
const DHAN_PRODUCTS = new Set(['INTRADAY', 'MARGIN', 'CNC']);
const KITE_NEO_PRODUCTS = new Set(['MIS', 'NRML', 'CNC']);

/**
 * The order-payload fragment that books a close under the same product as the
 * position, or null when that product must not be closed this way.
 *
 * null covers CO/BO legs (the broker holds its own exit order against them; a
 * plain market order would leave that dangling) and any vocabulary this code
 * does not recognise. Callers must refuse to trade on null rather than omit the
 * field — every order route defaults a missing product to intraday, which is
 * precisely the wrong-product order this module exists to prevent.
 *
 * An empty product means the broker reported none. The field is then omitted
 * and the route's default applies, matching the behaviour before products were
 * threaded through — losing the ability to exit is a worse failure than the
 * assumption, and all three shapers do populate it in practice.
 */
export function closeOrderProduct(
  broker: Broker,
  product: string,
): { fields: Record<string, string>; assumed: boolean } | null {
  const p = String(product ?? '').trim().toUpperCase();
  if (!p) return { fields: {}, assumed: true };

  if (broker === 'dhan') {
    return DHAN_PRODUCTS.has(p) ? { fields: { productType: p }, assumed: false } : null;
  }
  return KITE_NEO_PRODUCTS.has(p) ? { fields: { product: p }, assumed: false } : null;
}
