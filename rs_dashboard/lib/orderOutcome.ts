/**
 * What an order route's reply means: placed, cleanly rejected, or UNKNOWN. Shared by every order-placing desk
 * (Focus Tool, Multi-Leg Focus, Advanced Scalper, Triple Straddle).
 *
 * Unknown = the order may be live at the broker and nobody can say yet: the request never got a reply (network, a
 * dashboard restart mid-request), the route answered 504 / `unknown: true` (Dhan: no clean reply and the order was
 * not found by correlationId; Kotak: no clean reply and not in the order book within ~5 s), or the server crashed
 * with a non-JSON 5xx. Reporting it as "rejected" invites a retry (a doubled position, or a flipped one on a close)
 * or an automatic unwind of the legs that did go through (a naked short when the unknown leg was the short).
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

/** POST an order and classify the reply. Never throws: a request that fails before any reply is `unknown`. `reply`
 *  is the parsed JSON body (undefined when there was none), for callers that read more than the order id. */
export async function sendOrderRequest(url: string, body: unknown): Promise<{ outcome: OrderOutcome; reply: Record<string, unknown> | undefined }> {
  let status: number | null = null;
  let reply: unknown;
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    status = res.status;
    reply = await res.json().catch(() => undefined);
  } catch { /* no reply at all */ }
  return { outcome: classifyOrderReply(status, reply), reply: reply && typeof reply === 'object' ? reply as Record<string, unknown> : undefined };
}

/** The user-facing title word for a failed order: never "failed" / "rejected" when it may be live. */
export function failedOrderWord(outcome: OrderOutcome): string {
  return outcome.kind === 'unknown' ? 'status UNKNOWN' : 'rejected';
}

/** The hint after an unknown outcome: what the user must do before acting again. */
export const UNKNOWN_ORDER_HINT = 'It may have gone through — check Positions and Orders before placing or closing anything on this contract.';
