'use client';

// Client side of the "spawn a Python download, poll its debug/*_status.json"
// routes (options-refresh/, futures-refresh/): GET returns the status, POST
// starts the script, 409 means it is already running.
//
// Extracted from OptionsCharts and FuturesDashboard, whose copies had drifted
// into two different bugs:
//  - Options re-created its poll callback on every strike/expiry change, and
//    the effect cleanup killed the running poll interval. Changing strike
//    mid-download left "Downloading…" on screen forever.
//  - Neither page polled when it mounted while a download was already running
//    (started from another tab or before a reload), and a 409 from POST was
//    treated as failure instead of "watch the one that is running".

import { useState, useEffect, useRef, useCallback } from 'react';

export interface ScriptRefreshStatus {
  running: boolean;
  done: boolean;
  message: string;
  error: string | null;
}

const POLL_MS = 2000;

/**
 * @param endpoint GET = status, POST = start.
 * @param onDone   Called once when a run this mount watched finishes with
 *                 `done` set — not on mount when an old run is already done.
 */
export function useScriptRefresh(endpoint: string, onDone?: () => void) {
  const [status, setStatus] = useState<ScriptRefreshStatus | null>(null);

  const onDoneRef = useRef(onDone);
  useEffect(() => { onDoneRef.current = onDone; });

  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef(false);
  // True while a run is known to be in progress; the running → finished
  // transition is what fires onDone.
  const watching = useRef(false);
  // Bumped by start(): a status fetched before the POST describes the previous
  // run and must not be read as "the new run already finished".
  const generation = useRef(0);
  const mounted = useRef(false);
  // poll() reschedules itself; going through a ref keeps the callback free of
  // a self-reference (which the React compiler cannot memoize).
  const pollRef = useRef<() => void>(() => {});

  const poll = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    if (timer.current) { clearTimeout(timer.current); timer.current = null; }
    const gen = generation.current;
    try {
      const res = await fetch(endpoint, { cache: 'no-store' });
      const json = (await res.json()) as ScriptRefreshStatus;
      if (!mounted.current || gen !== generation.current) return;
      setStatus(json);
      if (json.running) {
        watching.current = true;
      } else if (watching.current) {
        watching.current = false;
        if (json.done) onDoneRef.current?.();
      }
    } catch { /* transient — keep polling if a run is being watched */ }
    finally {
      inFlight.current = false;
      // Next poll is scheduled only after this one settles, so a slow status
      // read can never stack requests.
      if (mounted.current && watching.current) timer.current = setTimeout(() => pollRef.current(), POLL_MS);
    }
  }, [endpoint]);

  useEffect(() => { pollRef.current = poll; }, [poll]);

  useEffect(() => {
    mounted.current = true;
    // Deferred by a task, as in useLiveTickerPoll: no setState during the
    // mount render pass (react-hooks/set-state-in-effect).
    timer.current = setTimeout(() => pollRef.current(), 0);
    return () => {
      mounted.current = false;
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
  }, [poll]);

  const start = useCallback(async () => {
    try {
      const res = await fetch(endpoint, { method: 'POST' });
      // 409 = already running (another tab, or a double click): watch that run.
      if (!res.ok && res.status !== 409) return;
      if (!mounted.current) return;
      generation.current += 1;
      watching.current = true;
      if (res.ok) setStatus({ running: true, done: false, message: 'Starting…', error: null });
      // A poll already in flight belongs to the old generation; its finally
      // block reschedules because watching is now set.
      if (!inFlight.current) poll();
    } catch { /* ignore */ }
  }, [endpoint, poll]);

  return { status, start };
}
