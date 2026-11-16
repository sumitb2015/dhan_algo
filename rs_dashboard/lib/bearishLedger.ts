/**
 * Own fill ledger for the Bearish Strikes page (debug/bearish_strikes_state.json).
 *
 * Deliberately NOT multi_leg_baskets.json: Multi-Leg Focus reconciles any leg it does not own
 * away, which would erase paper (SIM) positions. Ownership is this ledger — exits are sized
 * from `qty` here, never from the broker's netted position (see dhan-terminal-position-ownership).
 * Pure functions; the route does the locking and the file I/O.
 */
import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';

export type LedgerMode = 'SIM' | 'REAL';

export interface PendingOrder {
  orderId: string;
  kind: 'entry' | 'exit';
  side: 'BUY' | 'SELL';
  qty: number;
  at: number;
  /** MARKET or LIMIT. Absent on older rows. Auto-exit replaces a resting LIMIT exit, never a working MARKET one. */
  type?: 'MARKET' | 'LIMIT';
}

export interface BsPosition {
  id: string;
  mode: LedgerMode;
  underlying: string;
  expiry: string;
  option: 'CE' | 'PE';
  strike: number;
  /** Always 'S' for this page's entries; kept explicit so a future buy-hedge cannot be misread. */
  side: 'S' | 'B';
  lotSize: number;
  /** Units currently owned (lots * lotSize). Drops to 0 on close. */
  qty: number;
  avgPrice: number;
  /** Account the row trades on. Absent on older rows = Dhan. Every later order for the row goes to THIS broker. */
  broker?: 'dhan' | 'kotak' | 'zerodha';
  /** Dhan contract id (Dhan rows) ... */
  securityId?: string;
  /** ... or the trading symbol (Kotak and Zerodha rows: neither has a usable numeric id). */
  symbol?: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: number;
  filledAt: number;
  closedAt?: number;
  /** Largest qty this row ever held — what a CLOSED row reports as its size (qty itself drops to 0). */
  maxQty?: number;
  /** Realized P&L from exits so far (rupees). */
  realized: number;
  exitPrice?: number;
  /** Lowest premium seen while open (the trailing stop's anchor). Only ever moves down; survives a reload. */
  low?: number;
  pendingOrders?: PendingOrder[];
  note?: string;
}

export interface LedgerFile { rev: number; positions: BsPosition[] }

export type LedgerOp =
  | { op: 'open'; position: BsPosition }
  | { op: 'add'; id: string; qty: number; price: number; at: number }
  | { op: 'reduce'; id: string; qty: number; price: number; at: number }
  /** Down-only reconcile against the broker. `price` (live LTP, optional) books the vanished qty's P&L as an estimate. */
  | { op: 'clamp'; id: string; qty: number; at: number; price?: number }
  /**
   * Record (or clear / replace) a working order. Recorded BEFORE the order is sent, under a RESERVATION_PREFIX id, and
   * swapped for the broker's id once it is ACKed: an exit that would take the working exits past the owned qty, or any
   * order on a CLOSED row, is refused here, so a second tab cannot send a second buy-back.
   */
  | { op: 'pending'; id: string; pending: PendingOrder | null; clearOrderId?: string }
  /** An order reached its outcome: book `filledQty` at `avgPrice` (0 = rejected / cancelled / never filled). */
  | { op: 'settle'; id: string; orderId: string; filledQty: number; avgPrice: number; at: number }
  /** Trailing anchor. Only ever lowers, except `reset` (the trail was just switched on: start trailing from here). */
  | { op: 'low'; id: string; low: number; reset?: boolean }
  | { op: 'remove'; id: string };                                   // SIM clean-up only

/** Id prefix of an order recorded before it is sent (no broker id yet). */
export const RESERVATION_PREFIX = 'resv-';
export const isReservation = (orderId: string) => orderId.startsWith(RESERVATION_PREFIX);

export class LedgerError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

/** Same contract on another broker is a different position (two accounts), so the broker is part of the key. */
export const contractKey = (p: Pick<BsPosition, 'mode' | 'underlying' | 'expiry' | 'option' | 'strike' | 'broker'>) =>
  `${p.mode}|${p.broker ?? 'dhan'}|${p.underlying}|${p.expiry}|${p.option}|${p.strike}`;

/** Rupees per 1.00 premium move per ledger qty unit. Dhan takes MCX quantity in LOTS (lotSize 1), so qty is lots and
 *  one lot of CRUDEOILM is 10 barrels (CRUDEOIL 100): P&L must be scaled by barrels/lot. Every other underlying is 1
 *  because its lotSize already makes qty real contract units. */
export const pnlMultiplier = (underlying: string, broker: 'dhan' | 'kotak' | 'zerodha' = 'dhan'): number =>
  // Kotak counts MCX in barrels (its lot size is barrels per lot), so its qty is already real units. Dhan and Zerodha
  // count lots, so the barrels-per-lot multiplier applies.
  (broker === 'kotak' ? 1 : MCX_LOT_MULTIPLIER[underlying] ?? 1);

/** PnL sign: a short gains when price falls. */
export function legPnl(p: BsPosition, ltp: number | null): number | null {
  const sign = p.side === 'S' ? 1 : -1;
  let open: number | null = 0;
  if (p.qty > 0) {
    if (ltp == null || !(ltp > 0)) open = null;       // no live price = no P&L, never zero
    else open = (p.avgPrice - ltp) * p.qty * sign * pnlMultiplier(p.underlying, p.broker);
  }
  return open == null ? null : open + p.realized;
}

export function applyOp(file: LedgerFile, op: LedgerOp): LedgerFile {
  const positions = file.positions.map((p) => ({ ...p }));
  const find = (id: string) => {
    const p = positions.find((x) => x.id === id);
    if (!p) throw new LedgerError(`position ${id} not found`, 404);
    return p;
  };

  switch (op.op) {
    case 'open': {
      const p = op.position;
      // qty 0 is allowed only as a placeholder for an order whose outcome is still unknown (it is tracked, not forgotten).
      const awaiting = !(p.qty > 0) && (p.pendingOrders?.length ?? 0) > 0;
      if (!(p.lotSize > 0) || (!awaiting && (!(p.qty > 0) || !(p.avgPrice > 0)))) throw new LedgerError('qty, avgPrice and lotSize must be positive');
      if (p.mode === 'REAL' && ((p.broker ?? 'dhan') !== 'dhan' ? !p.symbol : !p.securityId)) {
        throw new LedgerError(`REAL position needs a ${p.broker === 'kotak' ? 'Kotak trading symbol' : p.broker === 'zerodha' ? 'Zerodha trading symbol' : 'securityId'}`);
      }
      // One strike per row: the same contract in the same mode is added to, never duplicated.
      if (positions.some((x) => x.status === 'OPEN' && contractKey(x) === contractKey(p))) {
        throw new LedgerError('contract already open in this mode — add lots to it instead', 409);
      }
      positions.push({ ...p, status: 'OPEN', realized: 0, maxQty: Math.max(p.qty, 0) });
      break;
    }
    case 'add': {
      const p = find(op.id);
      if (p.status !== 'OPEN') throw new LedgerError('position is closed', 409);
      if (!(op.qty > 0) || !(op.price > 0)) throw new LedgerError('qty and price must be positive');
      p.avgPrice = (p.avgPrice * p.qty + op.price * op.qty) / (p.qty + op.qty);
      p.qty += op.qty;
      p.maxQty = Math.max(p.maxQty ?? 0, p.qty);
      p.filledAt = op.at;
      break;
    }
    case 'reduce': {
      const p = find(op.id);
      if (p.status !== 'OPEN') throw new LedgerError('position is closed', 409);
      if (!(op.qty > 0) || !(op.price > 0)) throw new LedgerError('qty and price must be positive');
      // Exit what THIS ledger owns, never more.
      const q = Math.min(op.qty, p.qty);
      const sign = p.side === 'S' ? 1 : -1;
      p.realized += (p.avgPrice - op.price) * q * sign * pnlMultiplier(p.underlying, p.broker);
      p.qty -= q;
      p.filledAt = op.at;
      if (p.qty <= 0) { p.qty = 0; p.status = 'CLOSED'; p.closedAt = op.at; p.exitPrice = op.price; }
      break;
    }
    case 'clamp': {
      const p = find(op.id);
      if (p.status !== 'OPEN') break;
      // Reconcile is down-only: a broker reading never grows the ledger.
      if (op.qty < p.qty) {
        const gone = p.qty - Math.max(0, op.qty);
        const priced = op.price != null && op.price > 0;
        if (priced) {
          const sign = p.side === 'S' ? 1 : -1;
          p.realized += (p.avgPrice - op.price!) * gone * sign * pnlMultiplier(p.underlying, p.broker);
        }
        p.qty = Math.max(0, op.qty);
        if (p.qty === 0) {
          p.status = 'CLOSED'; p.closedAt = op.at;
          if (priced) p.exitPrice = op.price;
          p.note = priced ? 'closed outside this page (P&L at LTP, estimate)' : 'closed outside this page (P&L unknown)';
        }
      }
      break;
    }
    case 'pending': {
      const p = find(op.id);
      const list = (p.pendingOrders ?? []).filter((o) => o.orderId !== (op.clearOrderId ?? op.pending?.orderId));
      if (op.pending) {
        if (p.status !== 'OPEN') throw new LedgerError('position is closed — refresh before placing on it', 409);
        if (op.pending.kind === 'exit') {
          const working = list.filter((o) => o.kind === 'exit').reduce((a, o) => a + o.qty, 0);
          if (working + op.pending.qty > p.qty) throw new LedgerError(`exit of ${op.pending.qty} would exceed the ${p.qty - working} owned and not already being exited`, 409);
        }
        list.push(op.pending);
      }
      p.pendingOrders = list.length ? list : undefined;
      // A placeholder row whose only order was never sent (reservation cleared) holds nothing: close it.
      if (p.status === 'OPEN' && !(p.qty > 0) && !p.pendingOrders) {
        p.qty = 0; p.status = 'CLOSED'; p.closedAt = Date.now();
        if (p.realized === 0 && p.exitPrice == null) p.note = 'order not placed';
      }
      break;
    }
    case 'settle': {
      const p = find(op.id);
      const order = (p.pendingOrders ?? []).find((o) => o.orderId === op.orderId);
      if (!order) break;                                   // already settled — idempotent by order id
      const rest = (p.pendingOrders ?? []).filter((o) => o.orderId !== op.orderId);
      p.pendingOrders = rest.length ? rest : undefined;
      const q = Math.max(0, Math.min(op.filledQty, order.qty));
      if (q > 0 && op.avgPrice > 0) {
        if (order.kind === 'entry') {
          // A fill always lands on an OPEN row: a short the page cannot see is a short with no alerts, SL or Exit button.
          if (p.status !== 'OPEN') { p.status = 'OPEN'; p.closedAt = undefined; p.note = 'reopened: entry filled after close'; }
          p.avgPrice = p.qty > 0 ? (p.avgPrice * p.qty + op.avgPrice * q) / (p.qty + q) : op.avgPrice;
          p.qty += q;
          p.maxQty = Math.max(p.maxQty ?? 0, p.qty);
          p.filledAt = op.at;
        } else if (p.qty > 0) {
          const eq = Math.min(q, p.qty);
          const sign = p.side === 'S' ? 1 : -1;
          p.realized += (p.avgPrice - op.avgPrice) * eq * sign * pnlMultiplier(p.underlying, p.broker);
          p.qty -= eq;
          p.filledAt = op.at;
          p.exitPrice = op.avgPrice;
        }
      }
      if (p.qty <= 0 && !p.pendingOrders) {
        p.qty = 0; p.status = 'CLOSED'; p.closedAt = op.at;
        if (order.kind === 'entry' && p.realized === 0 && p.exitPrice == null) p.note = 'order did not fill';
      }
      break;
    }
    case 'low': {
      const p = find(op.id);
      if (p.status !== 'OPEN' || !(op.low > 0)) return file;     // no-op: nothing to anchor
      if (!op.reset && p.low != null && op.low >= p.low) return file;   // only ever lowers
      p.low = op.low;
      break;
    }
    case 'remove': {
      const p = find(op.id);
      if (p.mode !== 'SIM') throw new LedgerError('only SIM rows can be removed', 403);
      return { rev: file.rev + 1, positions: positions.filter((x) => x.id !== op.id) };
    }
  }
  return { rev: file.rev + 1, positions };
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

/**
 * Shape check for an op arriving over HTTP. applyOp's arithmetic assumes numbers: a string qty would concatenate
 * (`p.qty += "2"`) instead of adding. Throws LedgerError(400) on anything malformed.
 */
export function validateOp(raw: unknown): LedgerOp {
  const bad = (what: string): never => { throw new LedgerError(`invalid op: ${what}`); };
  if (!raw || typeof raw !== 'object') bad('body must be an object');
  const o = raw as Record<string, unknown>;
  const num = (k: string, optional = false) => { if (optional && o[k] == null) return; if (!isNum(o[k])) bad(`${k} must be a number`); };
  const str = (k: string) => { if (!isStr(o[k])) bad(`${k} must be a non-empty string`); };
  const pend = (v: unknown) => {
    const x = v as Record<string, unknown>;
    if (!x || typeof x !== 'object' || !isStr(x.orderId) || !isNum(x.qty) || !(x.qty > 0) || !isNum(x.at)
      || (x.kind !== 'entry' && x.kind !== 'exit') || (x.side !== 'BUY' && x.side !== 'SELL')
      || (x.type != null && x.type !== 'MARKET' && x.type !== 'LIMIT')) bad('pending order shape');
  };
  switch (o.op) {
    case 'open': {
      const p = o.position as Record<string, unknown>;
      if (!p || typeof p !== 'object') bad('position required');
      for (const k of ['id', 'underlying', 'expiry']) if (!isStr(p[k])) bad(`position.${k}`);
      for (const k of ['strike', 'lotSize', 'qty', 'avgPrice', 'openedAt', 'filledAt']) if (!isNum(p[k])) bad(`position.${k}`);
      if (p.mode !== 'SIM' && p.mode !== 'REAL') bad('position.mode');
      if (p.option !== 'CE' && p.option !== 'PE') bad('position.option');
      if (p.side !== 'S' && p.side !== 'B') bad('position.side');
      if (p.broker != null && p.broker !== 'dhan' && p.broker !== 'kotak' && p.broker !== 'zerodha') bad('position.broker');
      if (p.securityId != null && typeof p.securityId !== 'string') bad('position.securityId');
      if (p.symbol != null && typeof p.symbol !== 'string') bad('position.symbol');
      if (p.pendingOrders != null) { if (!Array.isArray(p.pendingOrders)) bad('position.pendingOrders'); (p.pendingOrders as unknown[]).forEach(pend); }
      break;
    }
    case 'add': case 'reduce': str('id'); num('qty'); num('price'); num('at'); break;
    case 'clamp': str('id'); num('qty'); num('at'); num('price', true); break;
    case 'pending':
      str('id');
      if (o.pending !== null) pend(o.pending);
      if (o.clearOrderId != null && !isStr(o.clearOrderId)) bad('clearOrderId');
      break;
    case 'settle': str('id'); str('orderId'); num('filledQty'); num('avgPrice'); num('at'); break;
    case 'low': str('id'); num('low'); if (o.reset != null && typeof o.reset !== 'boolean') bad('reset'); break;
    case 'remove': str('id'); break;
    default: bad('unknown op');
  }
  return o as unknown as LedgerOp;
}

/** Dhan correlationId for an order this page sends (8-25 lowercase letters/digits), derived from its idempotency key so a
 *  reservation alone is enough to find the order again. */
export const correlationIdOf = (idem: string): string => idem.replace(/[^a-z0-9]/g, '').slice(0, 25);

/** IST wall-clock stamp from an order book ('2026-11-16 10:15:02', '16-Nov-2026 10:15:02', ISO) to epoch ms; null if unknown. */
export function parseIstStamp(s: string): number | null {
  const t = s.trim();
  if (!t) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(t) && !Number.isNaN(Date.parse(t))) return Date.parse(t);
  const MON: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  let m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  let y: number, mo: number, d: number;
  if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else {
    m = /^(\d{1,2})[-/ ]([A-Za-z]{3})[-/ ](\d{4})[ ,]+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
    if (!m || !MON[m[2].toLowerCase()]) return null;
    d = +m[1]; mo = MON[m[2].toLowerCase()]; y = +m[3];
  }
  return Date.UTC(y, mo - 1, d, +m[4], +m[5], +(m[6] ?? 0)) - 5.5 * 3600_000;
}

/**
 * A reservation whose tab died (or whose send came back "unknown") may still have reached the broker. Find that order in
 * the broker's order book before the reservation is dropped, so a real fill is not lost:
 *  - Dhan: by the exact correlationId the page sent (entries and exits);
 *  - Kotak / Zerodha (no correlation id): ENTRIES only, by trading symbol + SELL + qty, not already tracked, and not
 *    placed before the reservation (when the book's time can be read). Adopting the wrong sell can only make the ledger
 *    too big, which the down-only reconcile corrects; adopting the wrong buy-back would make it too small, which nothing
 *    corrects — so exits there are never guessed.
 */
export function findSentOrder(
  orders: Record<string, unknown>[],
  q: { broker: 'dhan' | 'kotak' | 'zerodha'; reservation: PendingOrder; symbol?: string; tracked: Set<string> },
): string | null {
  const r = q.reservation;
  if (!isReservation(r.orderId)) return null;
  const idem = r.orderId.slice(RESERVATION_PREFIX.length);
  if (q.broker === 'dhan') {
    const corr = correlationIdOf(idem);
    const hit = orders.find((o) => String(o.correlationId ?? '') === corr && String(o.orderId ?? ''));
    return hit ? String(hit.orderId) : null;
  }
  if (r.kind !== 'entry' || !q.symbol) return null;
  const hits = orders.filter((o) => {
    const id = String(o.orderId ?? '');
    if (!id || q.tracked.has(id)) return false;
    if (String(o.tradingSymbol ?? '') !== q.symbol) return false;
    if (String(o.transactionType ?? '').toUpperCase() !== 'SELL') return false;
    if (Number(o.quantity) !== r.qty) return false;
    const at = parseIstStamp(String(o.createTime ?? ''));
    return at == null || at >= r.at - 5_000;
  });
  // Newest first when the book has times; otherwise the last row (both brokers list oldest first).
  hits.sort((a, b) => (parseIstStamp(String(b.createTime ?? '')) ?? 0) - (parseIstStamp(String(a.createTime ?? '')) ?? 0));
  return hits.length ? String(hits[0].orderId) : null;
}
