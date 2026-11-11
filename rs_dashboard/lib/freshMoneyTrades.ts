/**
 * Fresh Money board — trade ledger rules (pure, no I/O). REAL MONEY.
 *
 * The page's positions are what ITS OWN orders filled (dhan-terminal-position-ownership Invariant 1), never the broker's
 * net quantity on the contract, which pools other desks and manual trades. Every order carries the broker's own filled
 * quantity and cumulative average traded price, so a position is rebuilt from scratch on each read (average-cost
 * method): no blended estimate can drift (dhan-fill-price-pnl). An order whose fill price is not known yet makes that
 * position's basis unknown rather than 0.
 */

import type { FmExit } from './freshMoneyExits.ts';
import type { FmGlobalExit } from './freshMoneyGlobalExit.ts';

export type OptType = 'CE' | 'PE';
export type FmSegment = 'NSE_FNO' | 'MCX_COMM';
export type TxnSide = 'BUY' | 'SELL';
export type FmBroker = 'dhan' | 'kotak' | 'zerodha';
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
  /** The broker's contract handle: Dhan's security id, or the Kotak / Zerodha trading symbol. */
  securityId: string;
  /** Broker the order went to; absent on records written before broker choice = Dhan. */
  broker?: FmBroker;
  /** Dhan security id the LTP is read with (prices always come from Dhan). Absent = `securityId` (a Dhan order). */
  priceId?: string;
  /** Order segment; absent on records written before MCX support = NSE_FNO. */
  segment?: FmSegment;
  lot: number;                // order quantity per lot, in the broker's unit: NSE lot size; MCX 1 (Dhan/Zerodha: lots) or barrels per lot (Kotak)
  /** Rupee multiplier per unit of qty for P&L: 1 when qty is already units/barrels, barrels per lot when qty is MCX lots. */
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
  /** Why this close was sent when not by a click, e.g. "Target hit at 131.00" (the exit watcher). `reason` is the
   *  broker's text and is overwritten by every order read, so the trigger lives apart. */
  trigger?: string;
}

/** `exits`: per-position target / stop-loss, by position key (lib/freshMoneyExits.ts). */
export interface FmLedger { date: string; orders: FmOrder[]; exits?: Record<string, FmExit>; global?: FmGlobalExit }

export interface FmPosition {
  /** `broker|securityId`: Kotak and Zerodha trading symbols can coincide, so a contract is only unique per broker. */
  key: string;
  broker: FmBroker;
  securityId: string;
  priceId: string;
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

/** A position / contract key: the same contract on two brokers is two positions. */
export const orderKey = (o: Pick<FmOrder, 'broker' | 'securityId'>) => `${o.broker ?? 'dhan'}|${o.securityId}`;

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
export function unconfirmedQty(orders: FmOrder[], key: string, now: number, side?: TxnSide): number {
  let q = 0;
  for (const o of orders) {
    if (orderKey(o) !== key || (side && o.side !== side)) continue;
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
export function inFlightReducing(orders: FmOrder[], key: string, netQty: number, now: number): number {
  if (netQty === 0) return 0;
  return Math.abs(unconfirmedQty(orders, key, now, netQty > 0 ? 'SELL' : 'BUY'));
}

/** True while an order on this contract is unconfirmed (within UNCONFIRMED_COUNT_MS) or was placed very recently:
 *  the broker's position book can lag, so a reconcile must wait. */
export function contractSettling(orders: FmOrder[], key: string, now: number): boolean {
  for (const o of orders) {
    if (orderKey(o) !== key) continue;
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
export function contractHold(orders: FmOrder[], key: string, now: number): 'pending' | 'unknown' | null {
  let hold: 'pending' | 'unknown' | null = null;
  for (const o of orders) {
    if (orderKey(o) !== key) continue;
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
    const key = orderKey(o);
    let a = acc.get(key);
    if (!a) {
      a = {
        avg: null, realised: 0, basisKnown: true, realisedKnown: true,
        pos: {
          key, broker: o.broker ?? 'dhan', securityId: o.securityId, priceId: o.priceId ?? o.securityId, segment: o.segment ?? 'NSE_FNO', mult: o.mult && o.mult > 0 ? o.mult : 1, underlying: o.underlying, expiry: o.expiry, strike: o.strike, opt: o.opt, lot: o.lot,
          netQty: 0, avgPrice: null, realised: 0, ltp: null, unrealised: null, pnl: null, busy: null,
        },
      };
      acc.set(key, a);
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
    pos.busy = contractHold(orders, pos.key, now);
    const ltp = ltps[pos.priceId];
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

/**
 * The order unit for a broker: `lot` = order quantity per lot, `mult` = rupees per point per unit of quantity.
 *   Dhan    NSE: Dhan's lot size, mult 1        MCX: 1 (Dhan takes LOTS), mult = barrels per lot
 *   Zerodha NSE: Kite's lot size, mult 1        MCX: Kite's lot_size must be 1 (LOTS), mult = barrels per lot
 *   Kotak   NSE: Kotak's lot size, mult 1       MCX: Kotak's lot size must equal barrels per lot (BARRELS), mult 1
 * The broker's own master must agree with Dhan's (NSE lot) or with the MCX table; anything else is refused, never
 * guessed — a wrong unit sends an order 10-100x too big or too small (dhan-crudeoil-trading).
 */
export function brokerUnits(
  broker: FmBroker, underlying: string, dhanLot: number, brokerLot: number | null, barrelsPerLot: number | null,
): { lot: number; mult: number } | { error: string } {
  const name = broker === 'kotak' ? 'Kotak' : broker === 'zerodha' ? 'Zerodha' : 'Dhan';
  if (barrelsPerLot) {
    if (broker === 'dhan') return { lot: 1, mult: barrelsPerLot };
    if (broker === 'zerodha') {
      return brokerLot === 1 ? { lot: 1, mult: barrelsPerLot }
        : { error: `Zerodha lists ${underlying} with lot size ${brokerLot ?? 'unknown'} (expected 1: quantity in lots) — refused` };
    }
    return brokerLot === barrelsPerLot ? { lot: barrelsPerLot, mult: 1 }
      : { error: `Kotak lists ${underlying} with lot size ${brokerLot ?? 'unknown'} (expected ${barrelsPerLot} barrels) — refused` };
  }
  if (!(dhanLot > 0)) return { error: `No lot size for ${underlying}` };
  if (broker === 'dhan') return { lot: dhanLot, mult: 1 };
  if (brokerLot !== dhanLot) {
    return { error: `${name} lists ${underlying} with lot size ${brokerLot ?? 'unknown'}, Dhan with ${dhanLot} — refresh the ${name} instrument cache` };
  }
  return { lot: dhanLot, mult: 1 };
}

/**
 * A close re-checked inside the ledger lock, just before it is recorded (the × and the exit watcher can race: one may
 * fill while the other waits on the broker's positions read). The position must still be open in the direction this
 * order closes, and `qty` may not exceed what is open minus what is already on its way out. Null = may send.
 */
export function closeCheck(orders: FmOrder[], key: string, side: TxnSide, qty: number, now: number): string | null {
  const net = buildPositions(orders, {}, now).find(p => p.key === key)?.netQty ?? 0;
  if (net === 0 || (side === 'SELL') !== (net > 0)) return 'This position is no longer open in that direction — nothing was sent';
  const left = Math.abs(net) - inFlightReducing(orders, key, net, now);
  if (qty > left) return `Only ${Math.max(0, left)} of it is not already on its way out — nothing was sent; check Orders`;
  return null;
}

/** How long a REST LTP sample may be reused. */
export const REST_CACHE_MS = 1500;

/** The cached REST prices for exactly these ids while still fresh, else null. Used on the success path AND when a fetch
 *  fails: an old sample served twice would satisfy the exit watcher's two-check rule on a price that is no longer there. */
export function freshRestCache(
  cache: { at: number; ids: string; data: Record<string, number> } | null, ids: string, now: number,
): Record<string, number> | null {
  return cache && cache.ids === ids && now - cache.at < REST_CACHE_MS ? cache.data : null;
}
