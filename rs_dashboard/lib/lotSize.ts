// Lot-size resolution for API routes.
//
// The single authority is DhanHelper.get_lot_size(), reached through
// scripts/tools/scalper_api.py. There is deliberately NO hardcoded fallback:
// exchange lot sizes get revised (NIFTY has been 50, then 75, and is 65 today),
// so a literal default is not a safe degradation — it silently mis-sizes orders
// and skews every quantity-scaled calculation for as long as nobody notices.
// Callers get null for an unresolved symbol and must handle "not known".

import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

// The Python resolve costs ~3 s (interpreter start + master-list load), so
// results are cached. Lot sizes only change on an exchange revision.
const TTL = 12 * 60 * 60 * 1000;

interface CacheEntry { lot: number | null; ts: number }
const cache = new Map<string, CacheEntry>();

/**
 * Lot size for an underlying, or null when it cannot be resolved.
 * Throws only if the Python call itself fails, so a caller can tell
 * "no such contract" (null) from "lookup is broken" (throw).
 */
export async function resolveLotSize(symbolRaw: string): Promise<number | null> {
  const symbol = symbolRaw.trim().toUpperCase();
  const hit = cache.get(symbol);
  if (hit && Date.now() - hit.ts < TTL) return hit.lot;

  // dedupe so concurrent first requests for the same symbol share one spawn
  // rather than each paying the interpreter start.
  const parsed = await dedupe(`lotsize:${symbol}`, () =>
    runPythonJson<{ success: boolean; data?: Record<string, number | null>; error?: string }>(
      SCALPER_SCRIPT,
      ['lotsize', '--symbols', symbol],
      30_000,
    ),
  );

  if (!parsed.success || !parsed.data) {
    throw new Error(parsed.error ?? 'lot size lookup failed');
  }
  const lot = parsed.data[symbol] ?? null;
  cache.set(symbol, { lot, ts: Date.now() });
  return lot;
}
