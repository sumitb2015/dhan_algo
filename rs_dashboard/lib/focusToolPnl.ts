/**
 * Focus Tool row P&L helpers.
 *
 * A row pins at most ONE strike per leg. Rolling (or partially closing) a leg
 * leaves realized P&L on the OLD security id — if the row only reads the new
 * pin, that booked money disappears from the row and from the tool budget.
 *
 * `bookedPnl` on the fill ledger is the running total of P&L that left the
 * live book (reduces + full closes before a roll). Live row P&L is then
 * booked + mark-to-market on whatever the pin still holds.
 */

export interface MtmInput {
  /** Broker net quantity (signed). Short = negative. */
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  ltp: number;
  /** Absolute units to mark. Clamped to |netQty| by the caller when needed. */
  qty: number;
}

/** Mark-to-market for `qty` units of a position at `ltp`. */
export function mtmForQty(input: MtmInput): number {
  const qty = Math.abs(Number(input.qty) || 0);
  const ltp = Number(input.ltp) || 0;
  if (!(qty > 0) || !(ltp > 0)) return 0;
  const net = Number(input.netQty) || 0;
  if (net === 0) return 0;
  const isShort = net < 0;
  const avg = isShort ? Number(input.sellAvg) || 0 : Number(input.buyAvg) || 0;
  if (!(avg > 0)) return 0;
  return (isShort ? avg - ltp : ltp - avg) * qty;
}

/**
 * Share of a netted broker position that belongs to this row.
 * Missing/zero own qty → 1 (treat the whole position as this row's).
 */
export function ownShare(ownQty: number | undefined | null, brokerQty: number): number {
  const own = Number(ownQty) || 0;
  const broker = Math.abs(Number(brokerQty) || 0);
  if (own > 0 && broker > 0) return Math.min(1, own / broker);
  return 1;
}

export interface LiveLegPnl {
  netQty: number;
  buyAvg: number;
  sellAvg: number;
  ltp: number | null;
  /** Broker unrealized snapshot — fallback when LTP is missing. */
  unrealizedProfit: number;
  /** Absolute units this row owns on this leg. */
  ownQty: number | undefined | null;
}

/**
 * Row P&L = booked (from closed/rolled qty) + live MTM on still-open legs.
 *
 * Deliberately ignores broker `realizedProfit` on the open pin: that figure
 * mixes other rows' closes on a netted security id, and a roll's realized
 * sits on the OLD security which this row no longer looks up. Booked is the
 * only place closed P&L survives a strike move.
 */
export function computeRowPnl(bookedPnl: number, legs: LiveLegPnl[]): number {
  let pnl = Number(bookedPnl) || 0;
  for (const leg of legs) {
    const brokerQty = Math.abs(Number(leg.netQty) || 0);
    if (brokerQty <= 0) continue;
    const own = Number(leg.ownQty) || 0;
    const qty = own > 0 ? Math.min(own, brokerQty) : brokerQty;
    const ltp = Number(leg.ltp) || 0;
    if (ltp > 0) {
      pnl += mtmForQty({
        netQty: leg.netQty,
        buyAvg: leg.buyAvg,
        sellAvg: leg.sellAvg,
        ltp,
        qty,
      });
    } else {
      pnl += (Number(leg.unrealizedProfit) || 0) * ownShare(leg.ownQty, brokerQty);
    }
  }
  return pnl;
}

/**
 * True when we can bank a non-placeholder MTM for a closed slice.
 * Missing LTP/avg would bank 0 and recreate the "P&L vanished on roll" bug.
 */
export function canMarkMtm(input: Pick<MtmInput, 'netQty' | 'buyAvg' | 'sellAvg' | 'ltp' | 'qty'>): boolean {
  const qty = Math.abs(Number(input.qty) || 0);
  const ltp = Number(input.ltp) || 0;
  const net = Number(input.netQty) || 0;
  if (!(qty > 0) || !(ltp > 0) || net === 0) return false;
  const isShort = net < 0;
  const avg = isShort ? Number(input.sellAvg) || 0 : Number(input.buyAvg) || 0;
  return avg > 0;
}

/**
 * Strike-shift reopen gate after a close attempt.
 *
 * Requires OUR fill to match the requested close AND the broker book to have
 * dropped to (or below) the shared-strike floor. Book-floor alone is not
 * enough — another strategy flattening the same security must not green-light
 * our reopen while our close is still open.
 */
export function shiftCloseConfirmed(opts: {
  requestedClose: number;
  filled: number;
  brokerQtyAfter: number;
  targetRemaining: number;
}): boolean {
  const want = Math.abs(Number(opts.requestedClose) || 0);
  const filled = Math.max(0, Number(opts.filled) || 0);
  const after = Math.max(0, Number(opts.brokerQtyAfter) || 0);
  const floor = Math.max(0, Number(opts.targetRemaining) || 0);
  return want > 0 && filled === want && after <= floor;
}

/**
 * A strike shift may reopen only when the close fully flattened this row's
 * qty at the old strike. Partial closedUnits must never reopen or move the pin.
 */
export function shiftMayReopen(qtyBefore: number, closedUnits: number): boolean {
  const before = Math.abs(Number(qtyBefore) || 0);
  const closed = Number(closedUnits) || 0;
  return before > 0 && closed === before;
}
