'use client';

import { useEffect, useRef, useState, type MutableRefObject } from 'react';

/**
 * Elects ONE browser tab per `name` to run a page's automatic trading
 * (schedulers, stop/target watchers, auto re-entries, reconciliation). Focus
 * Tool and Multi-Leg Focus execute in the open tab, so two open tabs were two
 * execution engines: both could fire the same scheduled entry or stop
 * (2026-10-01 audit).
 *
 * Uses the Web Locks API: the first tab holds the lock for as long as it is
 * open; every other tab waits in the queue as a follower and takes over on
 * its own when the leader closes. Locks are per browser profile and origin —
 * a second browser or machine is NOT covered. Without Web Locks (very old
 * browser) every tab leads, which is the old behaviour.
 *
 * `isLeader` is null until known (no banner flash while the lock is taken),
 * then true / false. Gate automatic work on `isLeader === true` in effects,
 * or on `leaderRef.current` in interval callbacks and other closures that
 * must read the current value rather than their render's.
 */
export function useTabLeader(name: string): { isLeader: boolean | null; leaderRef: MutableRefObject<boolean> } {
  const [isLeader, setIsLeader] = useState<boolean | null>(null);
  const leaderRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    const lead = () => {
      if (disposed) return;
      leaderRef.current = true;
      setIsLeader(true);
    };
    const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
    if (!locks?.request) {
      void Promise.resolve().then(lead);
      return () => { disposed = true; leaderRef.current = false; };
    }
    const lockName = `dhan-engine:${name}`;
    const abort = new AbortController();
    let release: (() => void) | null = null;
    // A grant that arrives after this effect was cleaned up (React Strict Mode
    // mounts, unmounts and remounts every effect in dev; Fast Refresh re-runs
    // them) must hand the lock straight back — holding it forever left the
    // live mount waiting behind a dead one, so a single tab never led.
    const hold = () => (disposed
      ? Promise.resolve()
      : new Promise<void>(resolve => { release = resolve; lead(); }));
    locks
      // No `signal` here: the Web Locks spec rejects signal + ifAvailable
      // (NotSupportedError). A grant after cleanup is handed back by hold().
      .request(lockName, { ifAvailable: true }, lock => {
        if (lock) return hold();
        if (disposed) return undefined;
        setIsLeader(false);
        // Queue behind the leader; take over when its tab closes.
        locks.request(lockName, { signal: abort.signal }, hold).catch(() => { /* aborted on unmount */ });
        return undefined;
      })
      .catch(() => { /* no lock manager */ });
    return () => {
      disposed = true;
      abort.abort();
      release?.();
      leaderRef.current = false;
    };
  }, [name]);

  return { isLeader, leaderRef };
}
