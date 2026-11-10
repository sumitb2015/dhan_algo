/**
 * Fresh Money board — trade ledger rules (pure, no I/O). REAL MONEY.
 *
 * The page's positions are what ITS OWN orders filled (dhan-terminal-position-ownership Invariant 1), never the broker's
 * net quantity on the contract, which pools other desks and manual trades. Every order carries the broker's own filled
 * quantity and cumulative average traded price, so a position is rebuilt from scratch on each read (average-cost
 * method): no blended estimate can drift (dhan-fill-price-pnl). An order whose fill price is not known yet makes that
 * position's basis unknown rather than 0.
 */

export type OptType = 'CE' | 'PE';
export type FmSegment = 'NSE_FNO' | 'MCX_COMM';
export type TxnSide = 'BUY' | 'SELL';
/** sending = written before the request went out; pending = acknowledged, not yet (fully) traded; unknown = no clean
 *  reply and not found by correlationId — it MAY be live (Invariant 14). */
export type OrderState = 'sending' | 'pending' | 'partial' | 'filled' | 'rejected' | 'cancelled' | 'unknown';

export interface FmOrder {
  id: string;
  ts: number;                 // epoch ms the order was created
  underlying: string;
  expiry: string;
  strike: number;
  opt: OptType;
  securityId: string;
  /** Order segment; absent on records written before MCX support = NSE_FNO. */
  segment?: FmSegment;
  lot: number;                // order quantity per lot: the lot size on NSE, 1 on MCX (Dhan takes MCX qty in lots)
  /** Rupee multiplier per unit of qty for P&L: 1 on NSE (qty is already units), barrels per lot on MCX. Absent = 1. */
  mult?: number;
  side: TxnSide;
  qty: number;                // order quantity as sent (units on NSE, lots on MCX)
  close: boolean;             // sent by the × (square off) button
  /** Synthetic record from the down-only reconcile: the broker no longer holds this quantity (closed outside this
   *  page, e.g. an MIS auto square-off). Never sent; its price is unknown, so the day's booked P&L reads unknown. */
  external?: boolean;
  correlationId: string;
  orderId: string | null;
  state: OrderState;
  filledQty: number;          // broker's cumulative filled units
  avgPrice: number | null;    // broker's cumulative average traded price
  reason?: string;
}

export interface FmLedger { date: string; orders: FmOrder[] }

export interface FmPosition {
  securityId: string;
  segment: FmSegment;
  mult: number;
  underlying: string;
  expiry: string;
  strike: number;
  opt: OptType;
  lot: number;
  netQty: number;             // signed order quantity (units on NSE, lots on MCX): + long, - short
  avgPrice: number | null;    // basis of the open quantity; null = a fill's price is not known yet
  realised: number | null;    // rupees booked by reducing trades; null = a fill on either side had no price
  ltp: number | null;
  unrealised: number | null;
  pnl: number | null;         // realised + unrealised (null when either side is unknown)
  busy: 'pending' | 'unknown' | null; // an order on this contract is still in flight / unknown: hold new orders
}

export const FM_MAX_LOTS_PER_ORDER = 20;
/** Largest position (lots) one contract may build from this page. */
export const FM_MAX_POSITION_LOTS = 60;
/** A 'sending' record this old means the request never finished (a crash mid-send): treat it as unknown. */
export const SENDING_STALE_MS = 30_000;
/** How long an unknown order holds further orders on its contract. */
export const UNKNOWN_HOLD_MS = 60_000;
/** How long an acknowledged order may sit pending before it stops holding the contract (a MARKET order that has not
 *  traded by then is shown, but no longer blocks a deliberate next click). */
export const PENDING_HOLD_MS = 30_000;
/** Unconfirmed orders count toward exposure / in-flight closes for this long (then the broker clamp takes over). */
export const UNCONFIRMED_COUNT_MS = 10 * 60_000;
/** The broker's position book lags a fresh fill: do not reconcile a contract against it this soon after an order. */
export const RECONCILE_GRACE_MS = 20_000;

const TERMINAL: ReadonlySet<OrderState> = new Set(['filled', 'rejected', 'cancelled']);
export const isTerminal = (s: OrderState) => TERMINAL.has(s);

/**
 * Dhan orderStatus → ledger state. 'filled' is terminal (never read again), so an order only settles there once
 * BOTH its filled quantity and its average traded price are known: Dhan's price can lag the TRADED status, and the
 * correlationId lookup may carry no filledQty. Until then it stays 'partial' and is read again.
 */
export function stateFromBroker(orderStatus: string, filledQty: number, qty: number, avgPrice: number | null): OrderState {
  const s = orderStatus.toUpperCase();
  const priced = avgPrice !== null && avgPrice > 0;
  if (s === 'REJECTED') return 'rejected';
  if (s === 'CANCELLED' || s === 'EXPIRED') {
    if (filledQty <= 0) return 'cancelled';
    return priced ? 'filled' : 'partial';
  }
  if (s === 'TRADED') return filledQty > 0 && priced ? 'filled' : 'partial';
  if (s === 'PART_TRADED' || filledQty > 0) return 'partial';
  return 'pending';
}

/** Signed units of this contract's orders that may still turn into position: UNKNOWN / sending / pending orders' unfilled
 *  remainder. Counted toward the position cap as if they fill (an UNKNOWN order may be live). */
export function unconfirmedQty(orders: FmOrder[], securityId: string, now: number, side?: TxnSide): number {
  let q = 0;
  for (const o of orders) {
    if (o.securityId !== securityId || (side && o.side !== side)) continue;
    const st = effectiveState(o, now);
    if (isTerminal(st)) continue;
    // An order still unconfirmed after this long is very likely not live; the broker clamp and the down-only
    // reconcile cover it from here, so it must not block closes or the cap for the rest of the day.
    if (now - o.ts > UNCONFIRMED_COUNT_MS) continue;
    q += (o.side === 'BUY' ? 1 : -1) * Math.max(0, o.qty - Math.max(0, o.filledQty));
  }
  return q;
}

/** Quantity of orders already on their way to reduce this position (unconfirmed, opposite side). A × must close only
 *  what is left, or a close whose confirmation is slow would be sent twice. */
export function inFlightReducing(orders: FmOrder[], securityId: string, netQty: number, now: number): number {
  if (netQty === 0) return 0;
  return Math.abs(unconfirmedQty(orders, securityId, now, netQty > 0 ? 'SELL' : 'BUY'));
}

/** True while an order on this contract is unconfirmed (within UNCONFIRMED_COUNT_MS) or was placed very recently:
 *  the broker's position book can lag, so a reconcile must wait. */
export function contractSettling(orders: FmOrder[], securityId: string, now: number): boolean {
  for (const o of orders) {
    if (o.securityId !== securityId) continue;
    if (now - o.ts < RECONCILE_GRACE_MS) return true;
    if (!isTerminal(effectiveState(o, now)) && now - o.ts <= UNCONFIRMED_COUNT_MS) return true;
  }
  return false;
}

/**
 * Down-only reconcile (dhan-terminal-position-ownership Invariant 2): how much of this page's position the broker no
 * longer holds (an MIS auto square-off, a close from another desk). Never up: a larger broker position belongs to
 * someone else. 0 while the contract is settling or the broker read failed (`brokerNet` null).
 */
export function reconcileDownQty(netQty: number, brokerNet: number | null, settling: boolean): number {
  if (netQty === 0 || brokerNet === null || settling) return 0;
  const own = Math.abs(netQty);
  const broker = Math.sign(brokerNet) === Math.sign(netQty) ? Math.abs(brokerNet) : 0;
  return broker < own ? own - broker : 0;
}

/** The order's state as readers must treat it now: a stale 'sending' is unknown. */
export function effectiveState(o: FmOrder, now: number): OrderState {
  return o.state === 'sending' && now - o.ts > SENDING_STALE_MS ? 'unknown' : o.state;
}

/** Why a new order on this contract must wait, or null. */
export function contractHold(orders: FmOrder[], securityId: string, now: number): 'pending' | 'unknown' | null {
  let hold: 'pending' | 'unknown' | null = null;
  for (const o of orders) {
    if (o.securityId !== securityId) continue;
    const st = effectiveState(o, now);
    if (st === 'unknown' && now - o.ts < UNKNOWN_HOLD_MS) return 'unknown';
    if ((st === 'sending' || st === 'pending' || st === 'partial') && now - o.ts < PENDING_HOLD_MS) hold = 'pending';
  }
  return hold;
}

/** basisKnown: the open quantity's average is known (resets when the position goes flat). realisedKnown: every
 *  reducing trade today was priced on both sides (sticky: one unpriced round trip makes the day's booked P&L unknown). */
interface Acc { pos: FmPosition; avg: number | null; realised: number; basisKnown: boolean; realisedKnown: boolean }

/** Positions rebuilt from this page's own fills (average-cost), with live P&L where an LTP is known. */
export function buildPositions(orders: FmOrder[], ltps: Record<string, number>, now: number): FmPosition[] {
  const acc = new Map<string, Acc>();
  const sorted = [...orders].sort((a, b) => a.ts - b.ts);
  for (const o of sorted) {
    let a = acc.get(o.securityId);
    if (!a) {
      a = {
        avg: null, realised: 0, basisKnown: true, realisedKnown: true,
        pos: {
          securityId: o.securityId, segment: o.segment ?? 'NSE_FNO', mult: o.mult && o.mult > 0 ? o.mult : 1, underlying: o.underlying, expiry: o.expiry, strike: o.strike, opt: o.opt, lot: o.lot,
          netQty: 0, avgPrice: null, realised: 0, ltp: null, unrealised: null, pnl: null, busy: null,
        },
      };
      acc.set(o.securityId, a);
    }
    const q = Math.max(0, Math.min(o.filledQty, o.qty));
    if (q <= 0) continue;
    const px = o.avgPrice !== null && o.avgPrice > 0 ? o.avgPrice : null;
    const p = a.pos;
    const sgn = o.side === 'BUY' ? 1 : -1;
    let left = q;
    if (p.netQty !== 0 && Math.sign(p.netQty) !== sgn) {
      const closeQ = Math.min(left, Math.abs(p.netQty));
      if (px !== null && a.basisKnown && a.avg !== null) a.realised += (px - a.avg) * closeQ * Math.sign(p.netQty) * p.mult;
      else a.realisedKnown = false;
      p.netQty += sgn * closeQ;
      left -= closeQ;
      if (p.netQty === 0) { a.avg = null; a.basisKnown = true; }
    }
    if (left > 0) {
      if (px === null) {
        a.basisKnown = false;
      } else if (a.basisKnown) {
        const held = Math.abs(p.netQty);
        a.avg = held === 0 || a.avg === null ? px : (a.avg * held + px * left) / (held + left);
      }
      p.netQty += sgn * left;
    }
  }
  const out: FmPosition[] = [];
  for (const a of acc.values()) {
    const pos = a.pos;
    pos.avgPrice = pos.netQty !== 0 && a.basisKnown ? a.avg : null;
    pos.realised = a.realisedKnown ? a.realised : null;
    pos.busy = contractHold(orders, pos.securityId, now);
    const ltp = ltps[pos.securityId];
    pos.ltp = ltp > 0 ? ltp : null;
    if (pos.netQty === 0) pos.unrealised = 0;
    else pos.unrealised = pos.ltp !== null && pos.avgPrice !== null ? (pos.ltp - pos.avgPrice) * pos.netQty * pos.mult : null;
    pos.pnl = pos.unrealised === null || pos.realised === null ? null : pos.realised + pos.unrealised;
    out.push(pos);
  }
  return out;
}

/** Units for a square-off of `netQty`, clamped DOWN to what the broker still shows open in that direction
 *  (Invariant 2: never more than this page opened, never more than is there). `brokerNet` null = unreadable → own qty. */
export function closeQty(netQty: number, brokerNet: number | null): number {
  const own = Math.abs(netQty);
  if (brokerNet === null) return own;
  if (Math.sign(brokerNet) !== Math.sign(netQty)) return 0;
  return Math.min(own, Math.abs(brokerNet));
}

/** Split `qty` units into orders of at most `maxLots` lots each. */
export function slices(qty: number, lot: number, maxLots = FM_MAX_LOTS_PER_ORDER): number[] {
  const max = maxLots * lot;
  const out: number[] = [];
  for (let left = qty; left > 0; left -= max) out.push(Math.min(left, max));
  return out;
}

/** Backoff for re-reading an unsettled order: 2 s, 4 s, 8 s ... capped at 60 s. */
export function nextCheckDelay(attempts: number): number {
  return Math.min(60_000, 2_000 * 2 ** Math.max(0, attempts));
}

/** Which unsettled orders to read now: due ones, oldest first, at most `limit` (no order is starved by newer ones). */
export function dueForCheck(orders: FmOrder[], nextAt: ReadonlyMap<string, number>, now: number, limit: number): FmOrder[] {
  return orders
    .filter(o => !isTerminal(effectiveState(o, now)) && (nextAt.get(o.id) ?? 0) <= now)
    .sort((a, b) => (nextAt.get(a.id) ?? 0) - (nextAt.get(b.id) ?? 0) || a.ts - b.ts)
    .slice(0, limit);
}

/** A trading day's window in IST minutes: new positions from `open` until `cutoff`, closes until `close`. */
export interface TradeWindow { open: number; cutoff: number; close: number }

/** NSE F&O: opens stop at the repo-wide 15:17 IST intraday cutoff; closes run to the 15:30 bell. */
export const NSE_WINDOW: TradeWindow = { open: 9 * 60 + 15, cutoff: 15 * 60 + 17, close: 15 * 60 + 30 };

/** hhmm (e.g. 2340) → minutes since midnight. */
export const hhmmToMin = (hhmm: number) => Math.floor(hhmm / 100) * 60 + (hhmm % 100);
const fmtMin = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

export type SessionGate = 'open' | 'close-only' | 'closed';

/** What this page may send at `nowMs`. `window` null = no session today (weekend / holiday). */
export function sessionGate(nowMs: number, window: TradeWindow | null): SessionGate {
  if (!window) return 'closed';
  const d = new Date(nowMs + 19_800_000);
  const m = d.getUTCHours() * 60 + d.getUTCMinutes();
  if (m < window.open || m >= window.close) return 'closed';
  return m < window.cutoff ? 'open' : 'close-only';
}

export function sessionMessage(gate: SessionGate, window: TradeWindow | null, market: string): string | null {
  if (gate === 'open') return null;
  if (!window) return `${market} is closed today — no orders`;
  if (gate === 'closed') return `${market} closed — orders are taken ${fmtMin(window.open)}-${fmtMin(window.close)} IST`;
  return `After ${fmtMin(window.cutoff)} IST: closing only (×), no new positions`;
}
