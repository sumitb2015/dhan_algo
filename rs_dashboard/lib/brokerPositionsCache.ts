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
//
// Every caller of a given key receives the SAME object reference, so a
// consumer must treat what it gets back as read-only. Today none of them
// mutate it (dedupePositions/scaleBrokerPnl/shapeKotakPosition/
// buildPositionLegs all build new objects); a consumer that starts editing
// rows in place would silently corrupt what every other route sees.
//
// Scalper's own position reads deliberately do NOT go through this cache —
// they gate real-money decisions (the Close button's exit sizing and
// ProfitLock's SL/target detection) and must stay live on every poll.

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

// Bumped by invalidateBrokerCache(). A fetch captures the epoch for its key
// before awaiting the broker call; if that epoch has moved on by the time the
// fetch resolves, an invalidation happened while it was in flight, and the
// (now possibly pre-order-stale) result must not be written back into the
// cache — otherwise a poll that started just before an order fills could
// still repopulate the cache with the pre-fill snapshot right after the order
// route evicted it, silently undoing the invalidation.
const epoch = new Map<string, number>();

// Per-broker invalidation counters. A route that memoizes a whole assembled
// response stamps its entry with the generation read at the START of the
// request and discards it once that moves, so an order fill invalidates the
// route's outer cache too. Without this, evicting the inner entry
// accomplishes nothing for such a route: it returns its own memoized body
// before ever consulting this module.
//
// Counted per broker rather than globally so a route is only disturbed by
// the brokers it actually reads — margin-allocator covers Dhan and Kotak
// only, and a global counter made every Zerodha order throw away its cache
// and re-run per-group option-chain and margin lookups for data that could
// not have changed.
const generations = new Map<CachedBroker, number>();

/**
 * Opaque stamp for the brokers a caller depends on. Compare stamps with
 * `===`; any difference means at least one of those brokers was invalidated.
 * A string (not a sum) so two brokers' counters cannot add up to a colliding
 * value and hide an invalidation. Order-independent.
 */
export function brokerCacheGeneration(brokers: readonly CachedBroker[]): string {
  return [...brokers]
    .sort()
    .map(broker => `${broker}:${generations.get(broker) ?? 0}`)
    .join('|');
}

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

  const startEpoch = epoch.get(key) ?? 0;
  const run = (async () => {
    const data = await fetcher();
    if ((epoch.get(key) ?? 0) === startEpoch) cache.set(key, { data, ts: Date.now() });
    return data;
  })().finally(() => {
    // Only clear our own entry. invalidateBrokerCache() drops in-flight
    // fetches from the map so post-order callers don't join a pre-order one,
    // which means a newer fetch may already be registered under this key by
    // the time this older one settles.
    if (inflight.get(key) === run) inflight.delete(key);
  });

  inflight.set(key, run);
  return run;
}

export function getCachedPositions<T>(broker: CachedBroker, fetcher: () => Promise<T>): Promise<T> {
  return cached(`${broker}:positions`, fetcher);
}

export function getCachedFunds<T>(broker: CachedBroker, fetcher: () => Promise<T>): Promise<T> {
  return cached(`${broker}:funds`, fetcher);
}

// Called by order-placing/exit/cancel routes once the broker confirms, so the
// next Dashboard/Margin Allocator poll reflects the change rather than a
// pre-order snapshot. An order moves both margin-used and positions together
// (and cancelling a resting order releases blocked margin), so both keys are
// always evicted — no caller wants only one.
//
// Three things have to happen for the eviction to actually be observable:
//   1. drop the cached entry;
//   2. drop any in-flight fetch, so a caller arriving after the fill starts a
//      fresh one instead of joining a fetch that began before it;
//   3. bump the epoch, so that orphaned in-flight fetch cannot write its
//      pre-order result back into the cache when it eventually settles.
// Bumping this broker's generation does the same job for routes that memoize
// a whole assembled response.
export function invalidateBrokerCache(broker: CachedBroker): void {
  for (const kind of ['positions', 'funds'] as const) {
    const key = `${broker}:${kind}`;
    cache.delete(key);
    inflight.delete(key);
    epoch.set(key, (epoch.get(key) ?? 0) + 1);
  }
  generations.set(broker, (generations.get(broker) ?? 0) + 1);
}
