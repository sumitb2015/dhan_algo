import path from 'path';
import { kotakGetShared, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition } from '@/lib/kotakShape';
import { readJsonFile } from '@/lib/lockedJsonFile';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { istToday } from '@/lib/istTime';
import { guardProductOf } from '@/lib/softGuards';
import type { ServerGuardState } from '@/lib/kotakGuardEngine';
import { orderAddsExposure, lockGateDecision, type LockBookRow } from '@/lib/kotakLockRules';

export { orderAddsExposure };

// The order half of the Kotak day lock. When the server-side P&L loss limit has fired (lib/kotakGuardEngine.ts sets
// `lock` in debug/kotak_server_guards.json) every dashboard Kotak order goes through lib/kotakPlaceOrder.ts, which asks this
// file whether the order would ADD exposure. A reducing order is always allowed (an exit must never be blocked).
//
// This file reads the state file itself instead of importing lib/kotakGuardServer.ts: that module imports placeKotakOrder, so
// importing it back would be a cycle.

const STATE_FILE = path.join(PROJECT_ROOT, 'debug', 'kotak_server_guards.json');

export const KOTAK_LOCK_MSG = 'Day loss limit hit - Kotak is locked until tomorrow: new positions are refused and squared off. Exits still work.';

/** The active lock for today, or null. A lock from an earlier IST day is never honoured (the day roll clears it). */
export function readActiveKotakLock(): { at: number; reason: string; products: string[] } | null {
  const s = readJsonFile<Partial<ServerGuardState>>(STATE_FILE);
  if (!s || s.date !== istToday() || !s.lock) return null;
  return s.lock;
}

// The last book read that worked, so one rate-limited (429) or failed read does not open the gate: Kotak's limit is the
// exact condition a burst of locked-day orders creates. Per server process; a stale snapshot is not used.
const SNAPSHOT_MAX_AGE_MS = 120_000;
let lastBook: { at: number; rows: LockBookRow[] } | null = null;

async function readBookRows(): Promise<LockBookRow[] | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      // Shared read: concurrent orders and the guard's own poll reuse one request instead of each adding to the rate limit.
      const rows = kotakRows(await kotakGetShared(KOTAK_PATHS.positions)).map(shapeKotakPosition)
        .map(p => ({ symbol: p.tradingSymbol, product: guardProductOf(p.productType) as string, net: p.netQty }));
      lastBook = { at: Date.now(), rows };
      return rows;
    } catch { if (attempt === 0) await new Promise(r => setTimeout(r, 400)); }
  }
  return lastBook && Date.now() - lastBook.at <= SNAPSHOT_MAX_AGE_MS ? lastBook.rows : null;
}

/**
 * Null = let the order through. A message = refuse it (nothing is sent). A failed read retries once, then falls back to the last
 * good book (at most 2 min old); with neither the order passes, because a lock must never trap an exit.
 */
export async function kotakLockRefusal(payload: Record<string, string>): Promise<string | null> {
  const lock = readActiveKotakLock();
  if (!lock) return null;
  const order = { symbol: String(payload.ts), product: guardProductOf(payload.pc) as string, side: (payload.tt === 'B' ? 'B' : 'S') as 'B' | 'S', qty: Math.round(Number(payload.qt)) };
  const book = lockGateNeedsBook(lock, order) ? await readBookRows() : null;
  return lockGateDecision(lock, order, book) === 'refuse' ? KOTAK_LOCK_MSG : null;
}

/** The book is only worth a request for an order in a covered product. */
function lockGateNeedsBook(lock: { products: string[] }, order: { product: string }): boolean {
  return !order.product || lock.products.includes(order.product);
}
