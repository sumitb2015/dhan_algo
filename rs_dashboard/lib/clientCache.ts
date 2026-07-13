'use client';

// Session-level stale-while-revalidate cache for page mount fetches.
// Module state survives client-side navigations, so returning to a page
// paints instantly with last-seen data while a background fetch refreshes it.

interface Entry {
  data: unknown;
  ts: number;
}

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

/** Synchronously return cached data for a URL, or undefined. Stale entries are returned too. */
export function getCached<T>(url: string): T | undefined {
  return cache.get(url)?.data as T | undefined;
}

/** Store data for a URL — for pages that fetch manually (custom status handling). */
export function setCached(url: string, data: unknown): void {
  cache.set(url, { data, ts: Date.now() });
}

/**
 * Fetch JSON with session caching:
 * - fresh cache hit → resolves immediately without a network request
 * - stale/missing  → fetches (deduping concurrent calls) and caches the result
 * Use together with getCached() to seed state synchronously on mount.
 */
export async function cachedFetch<T>(url: string, ttlMs = 60_000): Promise<T> {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.ts < ttlMs) {
    return hit.data as T;
  }

  const existing = inflight.get(url);
  if (existing) return existing as Promise<T>;

  const p = (async () => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    cache.set(url, { data: json, ts: Date.now() });
    return json as T;
  })().finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}
