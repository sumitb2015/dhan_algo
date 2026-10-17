/**
 * What an order route's reply means for the Focus Tool: placed, cleanly rejected, or UNKNOWN.
 *
 * Unknown = the order may be live at the broker and nobody can say yet: the request never got a reply (network, a
 * dashboard restart mid-request), the route answered 504 / `unknown: true` (Dhan: no clean reply and the order was
 * not found by correlationId; Kotak: no clean reply and not in the order book within ~5 s), or the server crashed
 * with a non-JSON 5xx. Treating that as "rejected" made the auto-entry retry the leg (a doubled short the row only
 * half owns) and, when every leg was unknown, clear its one-entry latch and re-sell on every later tick.
 *
 * A JSON `success:false` with any other status is a clean refusal: the route checked something and sent nothing
 * (validation, product, lot cap, missing credentials) or the broker rejected it outright.
 */
export type OrderOutcome =
  | { kind: 'placed'; orderId: string | null }
  | { kind: 'rejected'; error: string }
  | { kind: 'unknown'; error: string };

export const UNKNOWN_NO_REPLY = 'No reply from the order route — the order may or may not have reached the broker.';

/** `status` is the HTTP status, or null when the request threw before any reply. `body` is the parsed JSON, or
 *  undefined when the reply was not JSON. */
export function classifyOrderReply(status: number | null, body: unknown): OrderOutcome {
  if (status == null) return { kind: 'unknown', error: UNKNOWN_NO_REPLY };
  if (!body || typeof body !== 'object') {
    return status >= 500
      ? { kind: 'unknown', error: `Order route failed with HTTP ${status} and no readable reply — the order may have gone out.` }
      : { kind: 'rejected', error: `Order route answered HTTP ${status}` };
  }
  const j = body as { success?: unknown; order_id?: unknown; unknown?: unknown; error?: unknown };
  if (j.success === true) return { kind: 'placed', orderId: j.order_id != null && j.order_id !== '' ? String(j.order_id) : null };
  const error = typeof j.error === 'string' && j.error ? j.error : 'Unknown broker error';
  if (j.unknown === true || status === 504) return { kind: 'unknown', error };
  return { kind: 'rejected', error };
}

/** Why this row may not OPEN anything right now because of an unknown order, or null. Exits are never held. */
export function openHoldReason(row: { orderUnknown?: { leg: string; kind: string; at: string } }): string | null {
  const h = row.orderUnknown;
  if (!h) return null;
  return h.kind === 'ladder'
    ? `A ${h.leg} limit-ladder order's status is unknown — check the order book (cancel it there if it is resting), then press "Checked" on the banner`
    : `A ${h.leg} order's status is unknown — check the broker's positions and order book, then press "Checked" on the banner (or Arm the row again)`;
}
