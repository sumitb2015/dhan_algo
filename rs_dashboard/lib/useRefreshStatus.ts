'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export interface GlobalRefreshStatus {
  running: boolean;
  /** Error message from the last finished run, or null. Cleared when a new run starts. */
  error: string | null;
  phase: string;
  current: number;
  total: number;
}

const IDLE_POLL_MS = 15000;
const ACTIVE_POLL_MS = 3000;

/**
 * Lightweight global poll of GET /api/refresh so any component (NavBar) can show
 * a sync spinner / error dot without opening DataRefreshPanel. Polls slowly while
 * idle and speeds up while a refresh is running.
 */
export function useRefreshStatus(): GlobalRefreshStatus {
  const [state, setState] = useState<GlobalRefreshStatus>({
    running: false,
    error: null,
    phase: '',
    current: 0,
    total: 0,
  });
  const runningRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/refresh');
      const json = await res.json();
      const status = json.status;
      const running: boolean = Boolean(json.running);
      setState({
        running,
        error: status?.done && status?.error ? String(status.error) : null,
        phase: status?.phase ?? '',
        current: status?.current ?? 0,
        total: status?.total ?? 0,
      });
      return running;
    } catch {
      return runningRef.current;
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    const schedule = (running: boolean) => {
      if (cancelled) return;
      if (running === runningRef.current && timerRef.current) return;
      runningRef.current = running;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(async () => {
        const nowRunning = await fetchStatus();
        schedule(nowRunning);
      }, running ? ACTIVE_POLL_MS : IDLE_POLL_MS);
    };

    fetchStatus().then((running) => schedule(running));

    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = null;
    };
  }, [fetchStatus]);

  return state;
}
