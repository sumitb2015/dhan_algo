// Shared server-side cache for broker positions/funds fetches. Wraps only the
// raw network call — dedupePositions(), shapeKotakPosition(), summarize(),
// classifyBroker() etc. still run per-caller exactly as before. This is what
// lets app/api/dashboard/portfolio and app/api/margin-allocator (and, later,
// other routes) share one Dhan/Zerodha/Kotak fetch instead of each hitting the
// broker independently on its own timer.
//
// No mutex/thread-safety needed: this dashboard runs as a single Node process
// (next dev / next start — no PM2/cluster/Docker replicas), and Node's
// single-threaded event loop means the only real hazard is two concurrent
// `await`s racing for the same data. The in-flight map below (same shape as
// lib/pyExec.ts's dedupe(), copied locally since this has nothing to do with
// spawning Python) collapses those into one shared promise.

type CachedBroker = 'dhan' | 'zerodha' | 'kotak';

// Every current caller fetches a broker's funds and positions together (one
// Promise.allSettled pair) and expects both to describe the same instant.
// Positions and funds share this one TTL so a cache refresh always covers
// both at once — giving them different TTLs would let a request pair
// freshly-fetched positions with a funds figure up to the longer TTL out of
// date (or vice versa), which previously could not happen.
const TTL_MS = 2_000;

interface Entry<T> {
  data: T;
  ts: number;
}

const cache = new Map<string, Entry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();

// dhanGet/kiteGet/kotakGet all throw on a broker-reported failure (verified:
// dhanGet on !res.ok, kiteGet on status==='error', kotakGet via
// raiseIfError()) rather than resolving with a success:false envelope, so a
// failed fetch never reaches `cache.set` below — it rejects out of `fetcher()`
// first, and the caller sees that rejection directly.
async function cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
  const hit = cache.get(key) as Entry<T> | undefined;
  if (hit && Date.now() - hit.ts < TTL_MS) return hit.data;

  const existing = inflight.get(key);
  if (existing) return existing as Promise<T>;

  const run = (async () => {
    // Re-check: another caller may have populated the cache while this one
    // was waiting to be scheduled (between the check above and this line).
    const fresh = cache.get(key) as Entry<T> | undefined;
    if (fresh && Date.now() - fresh.ts < TTL_MS) return fresh.data;

    const data = await fetcher();
    cache.set(key, { data, ts: Date.now() });
    return data;
  })().finally(() => inflight.delete(key));

  inflight.set(key, run);
  return run;
}

export function getCachedPositions<T>(broker: CachedBroker, fetcher: () => Promise<T>): Promise<T> {
  return cached(`${broker}:positions`, fetcher);
}

export function getCachedFunds<T>(broker: CachedBroker, fetcher: () => Promise<T>): Promise<T> {
  return cached(`${broker}:funds`, fetcher);
}
