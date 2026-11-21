import path from 'path';
import { kotakGet, kotakRows, KOTAK_PATHS } from '@/lib/kotakToken';
import { shapeKotakPosition } from '@/lib/kotakShape';
import { readJsonFile } from '@/lib/lockedJsonFile';
import { PROJECT_ROOT } from '@/lib/pyExec';
import { istToday } from '@/lib/istTime';
import { guardProductOf } from '@/lib/softGuards';
import type { ServerGuardState } from '@/lib/kotakGuardEngine';
import { orderAddsExposure } from '@/lib/kotakLockRules';

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

/**
 * Null = let the order through. A message = refuse it (nothing is sent). Fails OPEN when the book cannot be read: a lock
 * must never trap an exit, and the guard's 2.5 s flatten-on-sight still catches whatever slips through.
 */
export async function kotakLockRefusal(payload: Record<string, string>): Promise<string | null> {
  const lock = readActiveKotakLock();
  if (!lock) return null;
  const product = guardProductOf(payload.pc);
  if (product && !lock.products.includes(product)) return null;   // a product the loss limit does not cover
  const side = payload.tt === 'B' ? 'B' : 'S';
  const qty = Math.round(Number(payload.qt));
  let net = 0;
  try {
    const rows = kotakRows(await kotakGet(KOTAK_PATHS.positions)).map(shapeKotakPosition);
    net = rows
      .filter(p => p.tradingSymbol === String(payload.ts) && guardProductOf(p.productType) === product)
      .reduce((n, p) => n + p.netQty, 0);
  } catch { return null; }
  return orderAddsExposure(side, qty, net) ? KOTAK_LOCK_MSG : null;
}
