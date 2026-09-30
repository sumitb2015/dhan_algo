'use client';

// Client for the live options WebSocket bridge (app/api/options/live): its
// status, the latest quote snapshot and the tick history, plus start/stop.
//
// Owned by the OptionsCharts shell, because the bridge's state matters on every
// tab (it locks the expiry picker and hides "Download Options"), but only the
// bridge tabs (Premium / Multi-Strike / PC Diff) need the history. So:
//   active   → ?history=1 every `pollIntervalSec` (the header's 2/5/10/30s)
//   inactive → status + quotes only, every 30s
// GET is a JSON file read plus a cached PID check — no Dhan call — so the
// slow status poll off-tab is cheap.

import { useState, useEffect, useRef, useCallback } from 'react';

export interface OptionSide {
  ltp: number;
  oi: number;
  volume: number;
  prev_close?: number;
  change?: number;
  change_pct?: number;
}
export interface StrikeData { strike: number; ce: OptionSide; pe: OptionSide }

export interface HistoryPoint {
  timestamp: string;
  spot: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
}

export interface LiveQuotes {
  updated_at: string | null;
  spot: number;
  spot_change?: number;
  spot_change_pct?: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
  vix?: { ltp: number; prev_close: number; change: number; change_pct: number };
}

export interface BridgeStatus {
  status: 'RUNNING' | 'STOPPED' | 'STARTING' | 'ERROR';
  pid?: number;
  subscribed?: number;
  last_update?: string;
}

const INACTIVE_POLL_MS = 30_000;
// The route only honours a stop if no GET for that bridge lands within its
// STOP_GRACE_MS (7s) — any GET counts as "another viewer still reading" (see the
// multi-viewer stop guard in app/api/options/live/route.ts). So after Stop this
// page must stay silent for longer than that, or its own status poll cancels
// the stop it just asked for. If another page really is reading the bridge, its
// heartbeat keeps it up and the badge honestly stays RUNNING.
const STOP_QUIET_MS = 8_500;

export function useOptionsLiveBridge(
  underlying: string,
  { active, pollIntervalSec }: { active: boolean; pollIntervalSec: number },
) {
  const [status, setStatus]   = useState<BridgeStatus>({ status: 'STOPPED' });
  const [quotes, setQuotes]   = useState<LiveQuotes | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [busy, setBusy]       = useState(false);

  // Monotonic request id: a slow ?history=1 read must not land after a newer
  // status-only read (or after a stop) and resurrect old state.
  const seq = useRef(0);
  const quietUntil = useRef(0);

  const poll = useCallback(async (withHistory: boolean) => {
    if (Date.now() < quietUntil.current) return; // see STOP_QUIET_MS
    const id = ++seq.current;
    try {
      const qs = `checkPid=1&underlying=${underlying}${withHistory ? '&history=1' : ''}`;
      const res = await fetch(`/api/options/live?${qs}`, { cache: 'no-store' });
      const j = (await res.json()) as {
        success: boolean;
        status: BridgeStatus;
        quotes: LiveQuotes;
        history: { history: HistoryPoint[] };
      };
      if (id !== seq.current || !j.success) return;
      setStatus(j.status);
      if (j.quotes?.strikes && Object.keys(j.quotes.strikes).length) setQuotes(j.quotes);
      if (withHistory && j.history?.history?.length) setHistory(j.history.history);
    } catch { /* transient — next tick retries */ }
  }, [underlying]);

  const activeRef = useRef(active);
  useEffect(() => { activeRef.current = active; }, [active]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const ms = active ? pollIntervalSec * 1000 : INACTIVE_POLL_MS;
    // Self-scheduling: the next read is queued only after this one settles.
    const tick = async () => {
      await poll(active);
      if (!cancelled) timer = setTimeout(tick, ms);
    };
    // Deferred a task so no setState lands in the mount pass.
    timer = setTimeout(tick, 0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [poll, active, pollIntervalSec]);

  const start = useCallback(async (expiry: string) => {
    setBusy(true);
    try {
      await fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', underlying, expiry }),
      });
      quietUntil.current = 0;
      setHistory([]);
      setTimeout(() => poll(activeRef.current), 800);
    } finally {
      setBusy(false);
    }
  }, [underlying, poll]);

  const stop = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', underlying }),
      });
      quietUntil.current = Date.now() + STOP_QUIET_MS;
      setTimeout(() => poll(activeRef.current), STOP_QUIET_MS + 200);
    } finally {
      setBusy(false);
    }
  }, [underlying, poll]);

  return { status, quotes, history, busy, isLive: status.status === 'RUNNING', start, stop };
}
