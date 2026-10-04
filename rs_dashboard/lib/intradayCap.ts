// Cap a Dhan INTRADAY close at what today's trades say that book actually holds.
//
// Observed 2026-09-25: a strike held short 130 under INTRADAY and short 130
// under MARGIN was closed with ONE 260-lot BUY booked as INTRADAY — the
// combined quantity under a single product. It closed the INTRADAY book,
// flipped it long 130, and left the MARGIN short untouched (two live rows on
// one strike). An INTRADAY book cannot carry over from a prior day, so today's
// trades for (securityId, INTRADAY) give its exact net. MARGIN/CNC can carry
// positions in, so they cannot be cross-checked this way and are never capped.
//
// The cap only ever REDUCES a close. A contradictory trade list (flat or
// opposite sign) is reported, not acted on: refusing a stop-loss on a stale
// trade list is worse than the status quo.

export type CapResult = {
  qty: number;
  /** True when `qty` was reduced below the request. */
  capped: boolean;
  /** Trade-derived net disagrees in sign/zero with the position row. */
  mismatch: boolean;
  tradedNet: number | null;
};

const isFno = (seg: unknown) => String(seg ?? '').toUpperCase().includes('FNO');

/** Signed net of today's trades for one (securityId, product); null if not applicable. */
export function tradedNet(
  trades: Record<string, unknown>[],
  row: Record<string, unknown>,
): number | null {
  const product = String(row.productType ?? row.product ?? '').trim().toUpperCase();
  if (product !== 'INTRADAY' || !isFno(row.exchangeSegment ?? row.exchange)) return null;
  const secId = String(row.securityId ?? row.security_id ?? '');
  if (!secId) return null;
  let net = 0;
  for (const t of trades) {
    if (String(t.securityId ?? '') !== secId) continue;
    if (String(t.productType ?? '').trim().toUpperCase() !== 'INTRADAY') continue;
    const q = Number(t.tradedQuantity);
    if (!Number.isFinite(q)) continue;
    net += String(t.transactionType ?? '').toUpperCase() === 'BUY' ? q : -q;
  }
  return net;
}

export function capCloseQty(
  row: Record<string, unknown>,
  trades: Record<string, unknown>[] | null,
  requestedAbs: number,
): CapResult {
  const base: CapResult = { qty: requestedAbs, capped: false, mismatch: false, tradedNet: null };
  if (!trades) return base;
  const net = tradedNet(trades, row);
  if (net === null) return base;
  const posNet = Number(row.netQty);
  const sameSide = Math.sign(net) === Math.sign(posNet) && net !== 0;
  if (!sameSide) return { ...base, mismatch: true, tradedNet: net };
  const own = Math.abs(net);
  return own < requestedAbs
    ? { qty: own, capped: true, mismatch: false, tradedNet: net }
    : { ...base, tradedNet: net };
}
