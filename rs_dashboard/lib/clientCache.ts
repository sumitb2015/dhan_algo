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

// Most API routes in this dashboard respond with a `{ success: boolean, ... }`
// envelope even on HTTP 200 (e.g. a Python-script failure surfaced as JSON
// rather than a non-2xx status). Without this check, a single transient
// failure gets memoized and re-served as-is for the full TTL. Responses with
// no `success` field are assumed valid, preserving prior behavior for callers
// that don't use the envelope.
function defaultIsValid(data: unknown): boolean {
  if (data && typeof data === 'object' && 'success' in data) {
    return (data as { success: unknown }).success !== false;
  }
  return true;
}

/**
 * Fetch JSON with session caching:
 * - fresh cache hit → resolves immediately without a network request
 * - stale/missing  → fetches (deduping concurrent calls) and caches the result
 * Use together with getCached() to seed state synchronously on mount.
 *
 * `isValid` decides whether a response is cache-worthy (default: not an
 * explicit `{ success: false }`). Pass a custom check when "successful but
 * empty" should also be treated as not-yet-cacheable, e.g. an empty list from
 * a transient upstream hiccup.
 */
export async function cachedFetch<T>(
  url: string,
  ttlMs = 60_000,
  isValid: (data: T) => boolean = defaultIsValid,
): Promise<T> {
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
    if (isValid(json)) cache.set(url, { data: json, ts: Date.now() });
    return json as T;
  })().finally(() => inflight.delete(url));

  inflight.set(url, p);
  return p;
}
