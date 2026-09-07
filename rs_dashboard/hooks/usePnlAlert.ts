'use client';
import { useState, useEffect, useRef, useCallback } from 'react';

const POLL_MS = 20000; // own cadence — decoupled from upstream routes' own caches

export interface PnlAlertPayload {
  totalPnl: number;
  openPositions: number;
  nifty: { ltp: number; changePct: number | null } | null;
  delta: number;
}

export function usePnlAlert(enabled: boolean) {
  const [pending, setPending] = useState<PnlAlertPayload | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const res = await fetch('/api/pnl-alert');
      const json = await res.json();
      if (json?.success && json.alert) {
        setPending({
          totalPnl: json.totalPnl,
          openPositions: json.openPositions,
          nifty: json.nifty,
          delta: json.delta,
        });
      }
    } catch {
      // transient failure — keep any already-pending alert on screen
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    poll();
    timerRef.current = setInterval(poll, POLL_MS);
    return () => { if (timerRef.current) clearInterval(timerRef.current); };
  }, [enabled, poll]);

  return { pending, dismiss: useCallback(() => setPending(null), []) };
}
