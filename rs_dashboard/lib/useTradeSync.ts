'use client';

import { useState, useCallback, useRef, useEffect } from 'react';

/**
 * Starts an incremental trade-history sync (POST /api/portfolio-trades {action:'sync'} — refetches
 * only days after the last stored trade date, ~seconds) and polls until it finishes, then calls
 * onSynced so the caller can reload its data. Pass a useCallback-stable onSynced.
 */
export function useTradeSync(onSynced: () => void) {
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => stopPolling, [stopPolling]);

  const startSync = useCallback(async () => {
    if (timerRef.current) return; // already polling
    setSyncError(null);
    setSyncing(true);
    try {
      const res = await fetch('/api/portfolio-trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'sync' }),
      });
      const resp = await res.json();
      if (!res.ok || (!resp.started && !resp.alreadyRunning)) {
        setSyncError(resp.error ?? 'Failed to start sync');
        setSyncing(false);
        return;
      }
      timerRef.current = setInterval(async () => {
        try {
          const r = await fetch('/api/portfolio-trades');
          const d = await r.json();
          if (!d.syncRunning) {
            stopPolling();
            setSyncing(false);
            onSynced();
          }
        } catch {
          /* transient poll failure — keep polling */
        }
      }, 2000);
    } catch {
      setSyncError('Network error');
      setSyncing(false);
    }
  }, [onSynced, stopPolling]);

  return { syncing, syncError, startSync };
}
