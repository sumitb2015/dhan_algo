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
 * A leg's P&L as a % of the premium it was opened at: `pnl` over avg × qty, the same avg and qty that produced `pnl`
 * (mtmForQty), so ₹ and % always agree. A short that has decayed from 80 to 60 shows +25 %; doubled against you, −100 %.
 * Null when the basis is unknown.
 */
export function pnlPctOfPremium(pnl: number | null | undefined, avg: number, qty: number): number | null {
  const basis = Math.abs(Number(avg) || 0) * Math.abs(Number(qty) || 0);
  if (pnl == null || !Number.isFinite(pnl) || !(basis > 0)) return null;
  return (pnl / basis) * 100;
}

/**
 * Share of a netted broker position that belongs to this row.
 *
 * Missing/zero own qty → 0, NEVER 1. A row with no recorded ownership on a
 * leg owns nothing on it — the position belongs to another row, another
 * strategy, or a manual trade until this row's own ledger says otherwise.
 * Attributing the whole netted position on an empty ledger is how a row
 * sharing a strike ends up double-counting P&L (or the whole of someone
 * else's) — see legOwnContracts in focusToolRules.ts for the same rule on
 * the quantity side.
 */
export function ownShare(ownQty: number | undefined | null, brokerQty: number): number {
  const own = Number(ownQty) || 0;
  const broker = Math.abs(Number(brokerQty) || 0);
  if (broker <= 0) return 0;
  return Math.min(1, own / broker);
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
    // Never fall back to the full brokerQty on a missing own qty — see
    // ownShare's doc comment above for why 0 owned means 0 counted.
    const own = Number(leg.ownQty) || 0;
    const qty = Math.min(own, brokerQty);
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

/**
 * Booked (already-closed) P&L for the row display / budget.
 *
 * When the server-side worker holds the row it is the authority — it banks
 * each leg-wise SL / exit into its own ledger. The page's fill.bookedPnl is
 * only written for orders THIS tab placed, so after a worker CE SL the page
 * fill would still be 0 and the row would show only the leftover PE's MTM.
 */
export function rowDisplayBookedPnl(
  fillBooked: number | undefined | null,
  workerHold?: { open?: boolean; bookedPnl?: number | null } | null,
): number {
  if (workerHold?.open) return Number(workerHold.bookedPnl) || 0;
  return Number(fillBooked) || 0;
}

/**
 * Put-call ratio = PE ÷ CE. Used for both premium-value PCR and OI PCR.
 * Null when either side is missing or CE is non-positive (undefined ratio).
 */
export function putCallRatio(
  pe: number | null | undefined,
  ce: number | null | undefined,
): number | null {
  if (pe == null || ce == null) return null;
  const p = Number(pe);
  const c = Number(ce);
  if (!(c > 0) || Number.isNaN(p) || Number.isNaN(c)) return null;
  return p / c;
}

/**
 * Absolute OI for one leg: prefer the live WS tick, else the polled option
 * chain. Unlike LTP, 0 is a real reading (empty book), so it is not treated
 * as "missing". Used so a row on a non-nearest expiry (WS bridge stays on
 * the weekly) can still populate OI PCR from the chain fallback.
 */
export function pickOpenInterest(
  fromWs: number | null | undefined,
  fromChain: number | null | undefined,
): number | null {
  if (fromWs != null && !Number.isNaN(Number(fromWs)) && Number(fromWs) >= 0) {
    return Number(fromWs);
  }
  if (fromChain != null && !Number.isNaN(Number(fromChain)) && Number(fromChain) >= 0) {
    return Number(fromChain);
  }
  return null;
}

/** Val PCR: PE ₹ ÷ CE ₹ when both values exist, else PE premium ÷ CE premium. */
export function valuePutCallRatio(
  peValue: number | null | undefined,
  ceValue: number | null | undefined,
  peLtp: number | null | undefined,
  ceLtp: number | null | undefined,
): number | null {
  return putCallRatio(peValue, ceValue) ?? putCallRatio(peLtp, ceLtp);
}

/**
 * Correction to `bookedPnl` once a close's traded average is known. A close
 * books at the LTP snapshot taken when the order went out (an estimate);
 * swapping in the traded price moves the booked P&L by the price gap times
 * the closed qty — up for a short bought back cheaper than estimated.
 */
export function closeRebaseDelta(isShort: boolean, estimateExit: number, tradedExit: number, qty: number): number {
  if (!(estimateExit > 0) || !(tradedExit > 0) || !(qty > 0)) return 0;
  return (isShort ? estimateExit - tradedExit : tradedExit - estimateExit) * qty;
}

// ── P&L basis on actual fills (fill.ceFillEntry) ───────────────────────────
// Focus Tool legs are always SHORT (it only opens with a SELL), so a higher basis = more profit.

/**
 * The leg's P&L basis after an add of `addQty` at `price` (the estimate; 0 = no price yet). Unknown stays unknown —
 * never blended toward 0: a held leg with no basis yields null, so readers fall back to the old reference.
 */
export function blendFillBasis(prevBasis: number | null | undefined, prevQty: number, price: number, addQty: number): number | null {
  const prev = Number(prevBasis) || 0;
  if (!(addQty > 0)) return prevQty > 0 && prev > 0 ? prev : null;
  if (!(prevQty > 0)) return price > 0 ? price : null;
  if (!(prev > 0)) return null;
  if (!(price > 0)) return prev;            // priced at the old basis until the traded price arrives
  return (prev * prevQty + price * addQty) / (prevQty + addQty);
}

/**
 * One slice's traded price from an order's CUMULATIVE average (Dhan reports the average of everything filled so far).
 * `prior` = what earlier slices of the same order were already priced at. A late slice therefore gets its own price,
 * not the blended one.
 */
export function sliceTradedPrice(cumAtp: number, cumQty: number, prior: { qty: number; atp: number } | undefined): number {
  if (prior && prior.qty > 0 && cumQty > prior.qty && cumAtp > 0) {
    const px = (cumAtp * cumQty - prior.atp * prior.qty) / (cumQty - prior.qty);
    if (px > 0) return px;
  }
  return cumAtp;
}

/**
 * Correct a short leg's P&L basis once an add's traded price is known.
 *  - `assumed` = the price the add was blended at (its estimate, or the old basis when it had none); 0 = unknown.
 *  - The basis moves by c = (traded − assumed) × filled / heldAfterAdd, the add's share of the average.
 *  - Qty closed since the add (heldAfterAdd − heldNow) was booked at the old basis: bookedDelta = c × that qty.
 *  - `samePosition` false (the leg went flat and re-opened since): the old position was closed in full, so only its
 *    booked P&L is corrected; the new position's basis is left alone.
 *  - A leg opened from flat with no estimate gets the traded price as its basis.
 */
export function fillRebasePatch(p: {
  curBasis: number | null | undefined; heldNow: number; heldAfterAdd: number; samePosition: boolean;
  assumed: number; traded: number; filled: number;
}): { basis?: number; bookedDelta: number } {
  if (!(p.traded > 0) || !(p.filled > 0) || !(p.heldAfterAdd > 0)) return { bookedDelta: 0 };
  if (!(p.assumed > 0)) {
    // No price at all for this add: only a from-flat open (the whole position is this order) can be priced.
    return p.samePosition && p.heldNow > 0 && p.heldAfterAdd <= p.filled && !(Number(p.curBasis) > 0)
      ? { basis: p.traded, bookedDelta: 0 } : { bookedDelta: 0 };
  }
  const c = (p.traded - p.assumed) * Math.min(p.filled, p.heldAfterAdd) / p.heldAfterAdd;
  if (!p.samePosition) return { bookedDelta: c * p.heldAfterAdd };
  const reduced = Math.max(0, p.heldAfterAdd - p.heldNow);
  const cur = Number(p.curBasis) || 0;
  return {
    ...(p.heldNow > 0 && cur > 0 ? { basis: cur + c } : {}),
    bookedDelta: c * reduced,
  };
}

/** Realized P&L of `qty` closed at `exit` against this row's own `entry` (0 when either is unknown). */
export function closedSliceBooked(isShort: boolean, entry: number, exit: number, qty: number): number {
  if (!(entry > 0) || !(exit > 0) || !(qty > 0)) return 0;
  return (isShort ? entry - exit : exit - entry) * qty;
}

/** correlationId prefix on every Dhan order the Focus Tool places (fast-order
 *  `source`), so its own trades can be told apart from an outside close. */
export const FTS_ORDER_SOURCE = 'fts';
