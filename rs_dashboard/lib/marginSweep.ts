// Background live-margin sweep for the Strangle Matrix grid.
//
// Dhan's multi-leg margin calculator is rate-limited account-wide, and the
// grid can hold up to 75 cells (15 offsets x 5 expiries) per underlying.
// Fetching all of them synchronously inside a request would take well over
// a minute and block the response. Instead this module runs one sweep per
// underlying in the background (independent of any single GET request) and
// caches results by exact contract pair, so:
//   - a request never waits on it — it just reads whatever is cached so far
//   - repeated requests (poll ticks, other tabs) don't start their own sweep
//     (Guard: a status/cache check is not a lock — use an explicit in-progress set)
//   - margin is looked up by security-id pair, not grid position, so it stays
//     valid even if the ATM strike (and therefore strike-at-offset) shifts
//     between polls
//   - actual pacing/backoff lives once, centrally, in fetchNettedMargin() —
//     this sweep does NOT add its own delay between calls. Dhan's rate limit
//     is per account, not per caller, so a second local delay here would
//     only slow this sweep down without protecting anything; it wouldn't
//     stop a concurrent sweep for another underlying, or the ultimate-scanner
//     route, from sharing the same bucket. See ultimateScannerDhan.ts's
//     paceMarginCall for the single account-wide lane every caller funnels
//     through, including this one.
import { fetchNettedMargin, type MarginLeg } from '@/lib/ultimateScannerDhan';

const MARGIN_TTL_MS = 5 * 60_000; // SPAN/exposure margin does not swing on rapid ticks
const IDLE_ABORT_MS = 30_000; // stop feeding an underlying nobody's polling anymore

interface MarginCacheEntry {
  margin: number;
  ts: number;
}

const marginCache = new Map<string, MarginCacheEntry>();
const sweepInProgress = new Set<string>();
const lastSeenTs = new Map<string, number>();

function marginKey(underlying: string, putSecurityId: string, callSecurityId: string): string {
  return `${underlying}:${putSecurityId}:${callSecurityId}`;
}

export function getCachedMargin(
  underlying: string,
  putSecurityId?: string,
  callSecurityId?: string,
): number | null {
  if (!putSecurityId || !callSecurityId) return null;
  const hit = marginCache.get(marginKey(underlying, putSecurityId, callSecurityId));
  if (hit && Date.now() - hit.ts < MARGIN_TTL_MS) return hit.margin;
  return null;
}

export function isSweeping(underlying: string): boolean {
  return sweepInProgress.has(underlying);
}

function pruneStale(): void {
  if (marginCache.size <= 1000) return;
  const now = Date.now();
  for (const [key, entry] of marginCache.entries()) {
    if (now - entry.ts >= MARGIN_TTL_MS) marginCache.delete(key);
  }
}

/**
 * Kick off (or no-op if already running) a background sweep that fetches
 * real netted margin for every candidate not already fresh in the cache.
 * Fire-and-forget — callers should read results via getCachedMargin() on a
 * later request, not await this. Call this on every GET for the underlying
 * (whether or not it starts a new sweep) — it also marks the underlying as
 * "being watched", which keeps an in-flight sweep from aborting early.
 */
export function triggerMarginSweep(
  underlying: string,
  lotSize: number,
  candidates: { putSecurityId: string; callSecurityId: string }[],
): void {
  lastSeenTs.set(underlying, Date.now());

  if (sweepInProgress.has(underlying)) return;

  const seen = new Set<string>();
  const stale = candidates.filter(c => {
    const key = marginKey(underlying, c.putSecurityId, c.callSecurityId);
    if (seen.has(key)) return false;
    seen.add(key);
    const hit = marginCache.get(key);
    return !hit || Date.now() - hit.ts >= MARGIN_TTL_MS;
  });

  if (stale.length === 0) return;

  sweepInProgress.add(underlying);

  void (async () => {
    try {
      for (const c of stale) {
        // Nobody has requested this underlying's matrix in a while (tab
        // closed, user switched underlying) — stop spending shared rate-limit
        // budget on it. A fresh triggerMarginSweep() call will pick up any
        // still-stale cells if it comes back into view later.
        const idleFor = Date.now() - (lastSeenTs.get(underlying) ?? 0);
        if (idleFor > IDLE_ABORT_MS) break;

        const legs: MarginLeg[] = [
          { side: 'SELL', securityId: c.putSecurityId, quantity: lotSize },
          { side: 'SELL', securityId: c.callSecurityId, quantity: lotSize },
        ];
        try {
          const liveMargin = await fetchNettedMargin(underlying, legs);
          if (liveMargin !== null) {
            marginCache.set(marginKey(underlying, c.putSecurityId, c.callSecurityId), {
              margin: liveMargin,
              ts: Date.now(),
            });
          }
        } catch {
          // skip this cell, keep sweeping the rest
        }
      }
    } finally {
      sweepInProgress.delete(underlying);
      pruneStale();
    }
  })();
}

export function sweepStats(
  underlying: string,
  candidates: { putSecurityId?: string; callSecurityId?: string }[],
): { total: number; live: number; sweeping: boolean } {
  const withLegs = candidates.filter(c => c.putSecurityId && c.callSecurityId);
  const live = withLegs.filter(
    c => getCachedMargin(underlying, c.putSecurityId, c.callSecurityId) !== null,
  ).length;
  return { total: withLegs.length, live, sweeping: isSweeping(underlying) };
}
