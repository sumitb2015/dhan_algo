'use client';

// Shared polling engine for the Advanced Scalper's small live ticker panels
// (TopWeightStocks, TopIndices).
//
// Extracted rather than duplicated because the staleness rule below is subtle
// and safety-relevant: it exists specifically to stop a dead feed from
// presenting old prices as current on an order-entry screen. Two copies of that
// logic means the next person fixes one and misses the other.

import { useState, useEffect, useRef, useCallback } from 'react';

/** Poll cadence. Scheduled AFTER the previous response settles — see below. */
export const POLL_MS = 3000;
/** How long a per-symbol up/down flash stays lit. */
export const FLASH_MS = 600;
/**
 * A feed whose newest tick is older than this is not quiet, it is broken.
 *
 * Freshness is judged from the payload's own timestamp rather than any status
 * field, because status fields lie in both directions — e.g. the equity bridge
 * route only PID-checks when status === 'RUNNING'
 * (app/api/live-equity/route.ts:30), so a bridge that died during startup keeps
 * reporting 'STARTING' indefinitely, and a hung-but-alive process keeps
 * reporting 'RUNNING'. Either way the numbers would look authoritative while
 * being stale.
 */
export const STALE_MS = 15000;

/** True when a payload timestamp (ms) is too old to be treated as current. */
export function isStale(tickMs: number, now: number): boolean {
  return !Number.isFinite(tickMs) || now - tickMs > STALE_MS;
}

/** Age in ms of a payload timestamp, or Infinity when there isn't one yet. */
export function ageOf(tickMs: number, now: number): number {
  return Number.isFinite(tickMs) ? now - tickMs : Infinity;
}

/** Compact age label for a staleness badge: "8s", "3m", "2h". */
export function ageLabel(ms: number): string {
  if (!Number.isFinite(ms)) return '';
  const s = Math.floor(ms / 1000);
  if (s < 90) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 90 ? `${m}m` : `${Math.floor(m / 60)}h`;
}

export interface LiveTickerState<T> {
  /** Latest successfully parsed payload, or null before the first response. */
  data: T | null;
  /** Per-symbol tick direction for the brief flash, keyed by getLtps' keys. */
  flash: Record<string, 'up' | 'down'>;
  /** Clock that re-renders on the poll cadence, so age advances on its own. */
  now: number;
}

/**
 * Polls `url` and reports the payload plus per-symbol tick direction.
 *
 * `getLtps` maps a payload to `{id: ltp}` for change detection. It is held in a
 * ref so callers may pass an inline arrow safely: if it were a dependency of the
 * poll loop, an unstable identity would tear down and restart the loop on every
 * render, firing a request per render instead of one per POLL_MS. That failure
 * mode looks like it works while quietly hammering the endpoint, so the hook
 * defends against it rather than documenting a rule callers must remember.
 *
 * Polling is tied to the component's lifetime: mounting starts it, unmounting
 * stops it. The Advanced Scalper only mounts these panels while their toggle is
 * on, so a hidden panel issues no requests at all.
 *
 * Staleness is intentionally NOT computed here — the payload shape differs per
 * caller, so each component pulls its own timestamp and passes it to isStale().
 */
export function useLiveTickerPoll<T>(
  url: string,
  getLtps: (data: T) => Record<string, number>,
): LiveTickerState<T> {
  const [data, setData] = useState<T | null>(null);
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const [now, setNow] = useState(() => Date.now());

  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevLtpRef = useRef<Record<string, number>>({});

  // Written in an effect, never during render, so this stays compatible with
  // concurrent rendering (and with react-hooks' no-refs-during-render rule).
  const getLtpsRef = useRef(getLtps);
  useEffect(() => { getLtpsRef.current = getLtps; }, [getLtps]);

  const poll = useCallback(async () => {
    try {
      const res = await fetch(url);
      const raw = await res.json();
      // The auth middleware answers unauthenticated API calls with
      // {success:false} and a 401 (middleware.ts), so an expired session leaves
      // the last good data on screen and lets it age into STALE — which is the
      // honest outcome — rather than blanking the panel.
      if ((raw as { success?: boolean })?.success === false) return;

      const payload = raw as T;
      setData(payload);

      // Change detection lives here, inside the async callback, rather than in
      // render or an effect body — this is the one place setState is
      // unambiguously correct, and it needs the previous tick to compare against.
      const ltps = getLtpsRef.current(payload) ?? {};
      const next: Record<string, 'up' | 'down'> = {};
      for (const [id, ltp] of Object.entries(ltps)) {
        if (typeof ltp !== 'number' || !(ltp > 0)) continue;
        const prev = prevLtpRef.current[id];
        if (prev !== undefined && ltp !== prev) next[id] = ltp > prev ? 'up' : 'down';
        prevLtpRef.current[id] = ltp;
      }
      if (Object.keys(next).length > 0) {
        setFlash(next);
        if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
        flashTimerRef.current = setTimeout(() => setFlash({}), FLASH_MS);
      }
    } catch {
      /* transient — the next tick retries; staleness will surface a real outage */
    }
    // Deps are `url` only: getLtps comes from a ref, so an unstable caller
    // callback cannot restart the poll loop.
  }, [url]);

  useEffect(() => {
    let cancelled = false;

    // Self-scheduling timeout, not setInterval: the next request is only queued
    // once the previous one has settled, so a slow response can never stack
    // overlapping in-flight fetches.
    const tick = async () => {
      await poll();
      if (cancelled) return;
      pollRef.current = setTimeout(tick, POLL_MS);
    };
    // Deferred by a task so the first setState doesn't cascade a render during
    // mount (also what keeps react-hooks/set-state-in-effect satisfied).
    pollRef.current = setTimeout(tick, 0);

    return () => {
      cancelled = true;
      if (pollRef.current) clearTimeout(pollRef.current);
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
    };
  }, [poll]);

  // Independent clock so a feed that stops mid-session ages into STALE on its
  // own. A dead feed sends no responses, so age can't be driven by poll results.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), POLL_MS);
    return () => clearInterval(t);
  }, []);

  return { data, flash, now };
}
