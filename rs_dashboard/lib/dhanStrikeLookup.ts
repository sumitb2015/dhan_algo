import path from 'path';
import { PROJECT_ROOT, runPythonJson, dedupe } from '@/lib/pyExec';

const SCALPER_SCRIPT = path.join(PROJECT_ROOT, 'scripts', 'tools', 'scalper_api.py');

export interface StrikeLookup { ceId?: string; peId?: string }
export interface DhanLookupData { lotSize: number; strikes: Record<string, StrikeLookup> }
interface CacheEntry { data: DhanLookupData; ts: number }

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours — strike security ids don't change intraday

/**
 * Dhan's own strike -> securityId map for an underlying/expiry, independent of
 * which broker is actually trading the basket. Options market data always
 * originates from Dhan (CLAUDE.md) and NSE contracts are the same instrument
 * regardless of broker, so this is the correct source for pricing a Kotak or
 * Zerodha basket through Dhan's real SPAN+exposure margin calculator instead
 * of a flat, hedge-blind estimate — mirrors the cross-broker pattern in
 * app/api/margin-allocator/route.ts's resolveDhanSecurityIds, but via the
 * cheaper master-list-backed scalper_api.py lookup (no internal HTTP round
 * trip / cookie forwarding needed).
 */
export async function getDhanStrikeLookup(underlying: string, expiry: string): Promise<DhanLookupData | null> {
  if (!expiry) return null;
  const key = `${underlying}:${expiry}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.data;

  try {
    const parsed = await dedupe(`dhan-strike-lookup:${key}`, () =>
      runPythonJson<{ success: boolean; data?: DhanLookupData; error?: string }>(
        SCALPER_SCRIPT,
        ['lookup', '--underlying', underlying, '--expiry', expiry],
        30_000,
      ),
    );
    if (parsed.success && parsed.data) {
      cache.set(key, { data: parsed.data, ts: Date.now() });
      return parsed.data;
    }
    return null;
  } catch {
    return null;
  }
}
