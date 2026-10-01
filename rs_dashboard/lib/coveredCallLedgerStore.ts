// Server-only store for the NIFTYBEES Covered Call desk's call ledger
// (debug/nifty_covered_call_ledger.json): booked trades + orders still being
// filled. Shared by the state and order routes so they serialise on ONE write
// lock — a reservation made by the order route and a sweep from another tab
// can never interleave a read-modify-write (dhan-polling-guards).
//
// The pre-2026-10-01 futures + call desk wrote debug/nifty_covered_call_trades.json
// (lots, FUTURE rows). It is left untouched; this desk uses its own file in units.

import path from 'path';
import fs from 'fs';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { dhanGet } from '@/lib/dhanToken';
import {
  reconstructCallLedger, fillIncrement, TERMINAL_ORDER_STATUSES,
  type CallTrade, type PendingOrder,
} from '@/lib/coveredCallEngine';

const STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'nifty_covered_call_ledger.json');
/** A reservation whose order never got an id (the placement call died). */
const ORPHAN_RESERVATION_MS = 60_000;

export interface LedgerState {
  trades: CallTrade[];
  pending: PendingOrder[];
}

export function readLedger(): LedgerState {
  try {
    if (!fs.existsSync(STATE_FILE)) return { trades: [], pending: [] };
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as Partial<LedgerState>;
    return {
      trades: Array.isArray(parsed.trades) ? parsed.trades : [],
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
    };
  } catch {
    return { trades: [], pending: [] };
  }
}

function writeLedger(state: LedgerState): void {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

let writeQueue: Promise<unknown> = Promise.resolve();
/** Read-modify-write under the desk's single lock. `fn` must be synchronous —
 *  never hold the lock across a broker call. `write: false` skips the write. */
export function mutateLedger<T>(fn: (state: LedgerState) => { result: T; write: boolean }): Promise<T> {
  const run = () => {
    const state = readLedger();
    const { result, write } = fn(state);
    if (write) writeLedger(state);
    return result;
  };
  const result = writeQueue.then(run, run);
  writeQueue = result.then(() => undefined, () => undefined);
  return result;
}

export const newId = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

type Row = Record<string, unknown>;

export interface OrderStatus { status: string; filled: number; avg: number; reason: string }

export async function fetchOrderStatus(orderId: string): Promise<OrderStatus | null> {
  const raw = await dhanGet(`/orders/${orderId}`, 4_000);
  const o = (Array.isArray(raw) ? raw[0] : raw) as Row | undefined;
  if (!o) return null;
  return {
    status: String(o.orderStatus ?? '').toUpperCase(),
    filled: Number(o.filledQty) || 0,
    avg: Number(o.averageTradedPrice) || 0,
    reason: String(o.omsErrorDescription ?? ''),
  };
}

/**
 * Book whatever part of a pending order's fill is not in the ledger yet, at
 * that order's own average price, and drop the reservation once the order is
 * terminal and fully booked. Idempotent: two tabs sweeping the same order
 * book each unit once, because the increment is computed from the fresh file
 * under the lock. Returns the rows it booked.
 */
export function bookOrderStatus(pendingId: string, st: OrderStatus): Promise<CallTrade[]> {
  return mutateLedger((state) => {
    const idx = state.pending.findIndex((p) => p.id === pendingId);
    if (idx < 0) return { result: [], write: false };
    const p = state.pending[idx];
    const booked: CallTrade[] = [];
    const inc = fillIncrement(p.bookedUnits, p.bookedValue, Math.min(st.filled, p.units), st.avg);
    if (inc) {
      const base = {
        id: newId('cc'), ts: Date.now(), strike: p.strike, expiry: p.expiry, units: inc.units, price: inc.price,
        securityId: p.securityId, tradingSymbol: p.tradingSymbol, orderId: p.orderId ?? undefined, note: p.note,
        priceSource: 'fill' as const,
      };
      if (p.side === 'SELL') {
        booked.push({ ...base, action: 'SELL_OPEN' });
      } else {
        const leg = reconstructCallLedger(state.trades).open.find((o) => o.id === p.openLegId);
        // The leg was closed by something else meanwhile (SYNC): still record
        // the fill so the units are accounted for, but against its last entry.
        const entry = leg?.entryPrice ?? state.trades.find((t) => t.id === p.openLegId)?.price ?? inc.price;
        booked.push({ ...base, action: 'BUY_CLOSE', openLegId: p.openLegId, realizedPnl: (entry - inc.price) * inc.units });
      }
      state.trades.push(...booked);
      p.bookedUnits += inc.units;
      p.bookedValue += inc.price * inc.units;
    }
    const filled = Math.min(st.filled, p.units);
    // Terminal + every filled unit booked → done. A TRADED order Dhan hasn't
    // priced yet (avg 0) stays pending and is retried on the next sweep.
    if (TERMINAL_ORDER_STATUSES.includes(st.status) && p.bookedUnits >= filled) state.pending.splice(idx, 1);
    return { result: booked, write: booked.length > 0 || !state.pending.includes(p) };
  });
}

/** Re-read every pending order and book late fills. Safe to call from any tab. */
export async function sweepPending(): Promise<void> {
  const { pending } = readLedger();
  const now = Date.now();
  const orphans = pending.filter((p) => !p.orderId && now - p.createdAt > ORPHAN_RESERVATION_MS).map((p) => p.id);
  if (orphans.length) {
    await mutateLedger((s) => {
      s.pending = s.pending.filter((p) => !orphans.includes(p.id));
      return { result: null, write: true };
    });
  }
  for (const p of pending) {
    if (!p.orderId) continue;
    try {
      const st = await fetchOrderStatus(p.orderId);
      if (st) await bookOrderStatus(p.id, st);
    } catch { /* transient — next sweep retries */ }
  }
}

/** Live (uncached) NIFTY CE shorts by security id, with the contract details. */
export async function liveBrokerCallShorts(): Promise<Map<string, { units: number; strike: number; expiry: string; tradingSymbol: string }>> {
  const rows = (await dhanGet('/positions')) as Row[];
  if (!Array.isArray(rows)) throw new Error('Unexpected /positions payload');
  const out = new Map<string, { units: number; strike: number; expiry: string; tradingSymbol: string }>();
  for (const r of rows) {
    const sym = String(r.tradingSymbol ?? '');
    if (String(r.exchangeSegment) !== 'NSE_FNO' || !sym.startsWith('NIFTY-') || String(r.drvOptionType) !== 'CALL') continue;
    const net = Number(r.netQty) || 0;
    if (net >= 0) continue;
    const sid = String(r.securityId);
    const prev = out.get(sid);
    out.set(sid, {
      units: (prev?.units ?? 0) - net,
      strike: Number(r.drvStrikePrice) || 0,
      expiry: String(r.drvExpiryDate ?? '').slice(0, 10),
      tradingSymbol: sym,
    });
  }
  return out;
}
