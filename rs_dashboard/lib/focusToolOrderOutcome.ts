export { classifyOrderReply, UNKNOWN_NO_REPLY, type OrderOutcome } from './orderOutcome.ts';

/** Why this row may not OPEN anything right now because of an unknown order, or null. Exits are never held. */
export function openHoldReason(row: { orderUnknown?: { leg: string; kind: string; at: string } }): string | null {
  const h = row.orderUnknown;
  if (!h) return null;
  return h.kind === 'ladder'
    ? `A ${h.leg} limit-ladder order's status is unknown — check the order book (cancel it there if it is resting), then press "Checked" on the banner`
    : `A ${h.leg} order's status is unknown — check the broker's positions and order book, then press "Checked" on the banner (or Arm the row again)`;
}
