const DHAN_ORDERS = 'https://api.dhan.co/v2/orders';
const RECONCILE_TIMEOUT_MS = 8_000;
const RECONCILE_ATTEMPTS = 3;
const RECONCILE_GAP_MS = 2_000;

/**
 * The place-order call timed out or errored before we got a clean HTTP response — we genuinely don't know whether
 * Dhan received and booked it. Look it up by the correlationId we tagged it with rather than assuming failure: a
 * delayed-but-successful order must never be reported as failed, since that invites a dangerous duplicate exit/entry.
 * Dhan can take a few seconds to make a fresh order visible on this lookup, so retry briefly. null = still unknown.
 */
export async function reconcileByCorrelationId(correlationId: string, clientId: string, token: string): Promise<string | null> {
  for (let attempt = 0; attempt < RECONCILE_ATTEMPTS; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, RECONCILE_GAP_MS));
    try {
      const res = await fetch(`${DHAN_ORDERS}/external/${correlationId}`, {
        headers: { 'access-token': token, 'client-id': clientId, Accept: 'application/json' },
        signal: AbortSignal.timeout(RECONCILE_TIMEOUT_MS),
      });
      if (!res.ok) continue;
      const json = await res.json() as Record<string, unknown> | Record<string, unknown>[];
      const row = (Array.isArray(json) ? json[0] : json) as Record<string, unknown> | undefined;
      // Only trust this row if it actually echoes back the correlationId we
      // sent — never adopt an order_id from a mismatched/unrelated row.
      if (row && String(row.correlationId ?? '') === correlationId) {
        const orderId = String(row.orderId ?? '');
        if (orderId) return orderId;
      }
    } catch {
      // Dhan may still be catching up — keep trying within the attempt budget.
    }
  }
  return null;
}

/** A reply with no order id that still leaves the outcome open: the server failed (5xx), it did not refuse (4xx). */
export const isAmbiguousReply = (httpStatus: number): boolean => httpStatus >= 500;
