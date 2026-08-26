// Thin cached wrapper around scalperRoute(broker,'lookup') — the same
// strike -> order-identifier map components/Scalper.tsx keeps in its own
// `strikeMap` state. Cached per (broker, underlying, expiry) so re-opening a
// picker for an already-seen expiry, or adding to two legs of the same
// expiry, doesn't refire the network call. Broker is part of the cache key,
// so switching brokers never serves a stale broker's ids/symbols.

import { scalperRoute, type Broker } from '@/hooks/useBrokerSelector';

export interface StrikeLookupEntry {
  ceId?: string;
  peId?: string;
  ceSymbol?: string;
  peSymbol?: string;
}

export interface StrikeLookupResult {
  lotSize: number;
  strikes: Record<string, StrikeLookupEntry>;
}

const cache = new Map<string, Promise<StrikeLookupResult | null>>();

export function fetchStrikeMap(broker: Broker, underlying: string, expiry: string): Promise<StrikeLookupResult | null> {
  const key = `${broker}|${underlying}|${expiry}`;
  const cached = cache.get(key);
  if (cached) return cached;

  const p = (async (): Promise<StrikeLookupResult | null> => {
    try {
      const res = await fetch(`${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${expiry}`);
      const j = await res.json() as { success: boolean; data?: StrikeLookupResult };
      if (j.success && j.data) return j.data;
    } catch {
      // fall through to cache eviction below
    }
    cache.delete(key); // don't cache a failure — let the next call retry
    return null;
  })();

  cache.set(key, p);
  return p;
}
