/**
 * Own fill ledger for the Bearish Strikes page (debug/bearish_strikes_state.json).
 *
 * Deliberately NOT multi_leg_baskets.json: Multi-Leg Focus reconciles any leg it does not own
 * away, which would erase paper (SIM) positions. Ownership is this ledger — exits are sized
 * from `qty` here, never from the broker's netted position (see dhan-terminal-position-ownership).
 * Pure functions; the route does the locking and the file I/O.
 */

export type LedgerMode = 'SIM' | 'REAL';

export interface PendingOrder {
  orderId: string;
  kind: 'entry' | 'exit';
  side: 'BUY' | 'SELL';
  qty: number;
  at: number;
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
  securityId?: string;
  status: 'OPEN' | 'CLOSED';
  openedAt: number;
  filledAt: number;
  closedAt?: number;
  /** Largest qty this row ever held — what a CLOSED row reports as its size (qty itself drops to 0). */
  maxQty?: number;
  /** Realized P&L from exits so far (rupees). */
  realized: number;
  exitPrice?: number;
  pendingOrders?: PendingOrder[];
  note?: string;
}

export interface LedgerFile { rev: number; positions: BsPosition[] }

export type LedgerOp =
  | { op: 'open'; position: BsPosition }
  | { op: 'add'; id: string; qty: number; price: number; at: number }
  | { op: 'reduce'; id: string; qty: number; price: number; at: number }
  | { op: 'clamp'; id: string; qty: number; at: number }          // down-only reconcile against the broker
  | { op: 'pending'; id: string; pending: PendingOrder | null; clearOrderId?: string }
  /** An order reached its outcome: book `filledQty` at `avgPrice` (0 = rejected / cancelled / never filled). */
  | { op: 'settle'; id: string; orderId: string; filledQty: number; avgPrice: number; at: number }
  | { op: 'remove'; id: string };                                   // SIM clean-up only

export class LedgerError extends Error {
  status: number;
  constructor(message: string, status = 400) { super(message); this.status = status; }
}

export const contractKey = (p: Pick<BsPosition, 'mode' | 'underlying' | 'expiry' | 'option' | 'strike'>) =>
  `${p.mode}|${p.underlying}|${p.expiry}|${p.option}|${p.strike}`;

/** PnL sign: a short gains when price falls. */
export function legPnl(p: BsPosition, ltp: number | null): number | null {
  const sign = p.side === 'S' ? 1 : -1;
  let open: number | null = 0;
  if (p.qty > 0) {
    if (ltp == null || !(ltp > 0)) open = null;       // no live price = no P&L, never zero
    else open = (p.avgPrice - ltp) * p.qty * sign;
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
      if (p.mode === 'REAL' && !p.securityId) throw new LedgerError('REAL position needs a securityId');
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
      p.realized += (p.avgPrice - op.price) * q * sign;
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
        p.qty = Math.max(0, op.qty);
        if (p.qty === 0) { p.status = 'CLOSED'; p.closedAt = op.at; p.note = 'closed outside this page'; }
      }
      break;
    }
    case 'pending': {
      const p = find(op.id);
      const list = (p.pendingOrders ?? []).filter((o) => o.orderId !== (op.clearOrderId ?? op.pending?.orderId));
      if (op.pending) list.push(op.pending);
      p.pendingOrders = list.length ? list : undefined;
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
          p.avgPrice = p.qty > 0 ? (p.avgPrice * p.qty + op.avgPrice * q) / (p.qty + q) : op.avgPrice;
          p.qty += q;
          p.maxQty = Math.max(p.maxQty ?? 0, p.qty);
          p.filledAt = op.at;
        } else if (p.qty > 0) {
          const eq = Math.min(q, p.qty);
          const sign = p.side === 'S' ? 1 : -1;
          p.realized += (p.avgPrice - op.avgPrice) * eq * sign;
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
    case 'remove': {
      const p = find(op.id);
      if (p.mode !== 'SIM') throw new LedgerError('only SIM rows can be removed', 403);
      return { rev: file.rev + 1, positions: positions.filter((x) => x.id !== op.id) };
    }
  }
  return { rev: file.rev + 1, positions };
}
