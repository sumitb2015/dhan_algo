'use client';

/**
 * useFocusToolWS — realtime spot + option-premium quotes for all three Focus
 * Tool underlyings (NIFTY, BANKNIFTY, SENSEX) at once, from the standalone
 * bridge in scripts/tools/focus_tool_ws.py + app/api/focus-tool/live-ws.
 *
 * Deliberately NOT useLiveOptionsWS: that hook (and its bridge) is built
 * one-per-broker, one-underlying-at-a-time — right for AdvancedScalper's
 * single-select dropdown, wrong for Focus Tool's concurrent three-underlying
 * row view. This hook talks to a dedicated bridge that already multiplexes
 * all three underlyings over one WebSocket connection and pushes one combined
 * payload, so there is exactly one channel here — no per-broker fan-out (the
 * bridge is always Dhan-sourced; order routing broker is irrelevant to it).
 *
 * Same two-transport shape as useLiveOptionsWS: a direct WebSocket to the
 * bridge's localhost push server is primary; a 100ms HTTP poll of the API
 * route is the fallback while the WS is down. Renders are rAF-coalesced so a
 * 20-40Hz tick burst across three underlyings never queues more than one
 * render per frame.
 */

import { useEffect, useState } from 'react';

const STATUS_POLL_MS   = 5000;
const FALLBACK_POLL_MS = 100;
const WS_RETRY_BASE_MS = 500;
const WS_RETRY_MAX_MS  = 5000;
const WS_FAILS_TO_POLL = 3;
const STALE_MS         = 10_000;

export type FocusUnderlying = 'NIFTY' | 'BANKNIFTY' | 'SENSEX';

export interface FocusWSLeg {
  ltp: number;
}

export interface FocusWSStrike {
  strike: number;
  ce: FocusWSLeg;
  pe: FocusWSLeg;
}

export interface FocusWSUnderlyingQuotes {
  spot: number;
  atm: number;
  expiry: string;
  fut?: {
    ltp: number;
    change_pct: number | null;
  } | null;
  strikes: Record<string, FocusWSStrike>;
}

export interface FocusWSQuotes {
  type: 'quotes';
  updated_at: string;
  NIFTY?: FocusWSUnderlyingQuotes;
  BANKNIFTY?: FocusWSUnderlyingQuotes;
  SENSEX?: FocusWSUnderlyingQuotes;
}

export interface FocusWSBridgeStatus {
  status: 'STARTING' | 'RUNNING' | 'STOPPED' | 'STALE' | 'ERROR';
  pid?: number;
  expiries?: Record<string, string>;
  subscribed?: number;
  ws_port?: number | null;
}

export interface FocusToolWSResult {
  quotes: FocusWSQuotes | null;
  bridgeStatus: FocusWSBridgeStatus;
  transport: 'ws' | 'poll';
}

interface ChannelState {
  quotes: FocusWSQuotes | null;
  bridgeStatus: FocusWSBridgeStatus;
  transport: 'ws' | 'poll';
}

const EMPTY_STATE: ChannelState = {
  quotes: null,
  bridgeStatus: { status: 'STOPPED' },
  transport: 'poll',
};

function runChannel(onUpdate: (patch: Partial<ChannelState>) => void): () => void {
  let disposed = false;
  let ws: WebSocket | null = null;
  let wsFails = 0;
  let wsRetryMs = WS_RETRY_BASE_MS;
  let wsPort: number | null = null;
  let lastWsMsgAt = 0;
  let wsConnectingAt = 0;

  let rafId: number | null = null;
  const latestRef = { quotes: null as FocusWSQuotes | null };
  const timers: ReturnType<typeof setTimeout>[] = [];
  let statusInterval: ReturnType<typeof setInterval> | null = null;
  let pollInterval: ReturnType<typeof setInterval> | null = null;
  let watchdogInterval: ReturnType<typeof setInterval> | null = null;
  let lastStatusKey = '';

  const acceptQuotes = (q: FocusWSQuotes | null): boolean => {
    if (!q) return false;
    if (q.updated_at) {
      const ageMs = Date.now() - new Date(q.updated_at).getTime();
      if (!(ageMs <= STALE_MS)) return false;   // NaN-safe: fail stale
    }
    return !!(q.NIFTY || q.BANKNIFTY || q.SENSEX);
  };

  const scheduleFlush = () => {
    if (rafId != null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      if (disposed || !latestRef.quotes) return;
      onUpdate({ quotes: latestRef.quotes });
    });
  };

  const httpPoll = () => {
    fetch('/api/focus-tool/live-ws')
      .then(r => r.json())
      .then((j: { success: boolean; status: FocusWSBridgeStatus; quotes: FocusWSQuotes }) => {
        if (disposed || !j.success) return;
        if (acceptQuotes(j.quotes)) {
          latestRef.quotes = j.quotes;
          scheduleFlush();
        }
      })
      .catch(() => {});
  };

  const startFallbackPolling = () => {
    if (pollInterval || disposed) return;
    onUpdate({ transport: 'poll' });
    httpPoll();
    pollInterval = setInterval(httpPoll, FALLBACK_POLL_MS);
  };

  const stopFallbackPolling = () => {
    if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
  };

  const connectWS = () => {
    if (disposed || !wsPort || ws) return;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
    } catch {
      ws = null;
      onWsDown();
      return;
    }
    wsConnectingAt = Date.now();

    ws.onopen = () => {
      if (disposed) return;
      wsFails = 0;
      wsRetryMs = WS_RETRY_BASE_MS;
      lastWsMsgAt = Date.now();
      wsConnectingAt = 0;
      stopFallbackPolling();
      onUpdate({ transport: 'ws' });
    };

    ws.onmessage = (ev) => {
      if (disposed) return;
      lastWsMsgAt = Date.now();
      try {
        const q = JSON.parse(ev.data as string) as FocusWSQuotes;
        if (acceptQuotes(q)) {
          latestRef.quotes = q;
          scheduleFlush();
        }
      } catch { /* malformed frame — ignore */ }
    };

    ws.onclose = () => { ws = null; wsConnectingAt = 0; if (!disposed) onWsDown(); };
    ws.onerror = () => { try { ws?.close(); } catch { /* noop */ } };
  };

  const onWsDown = () => {
    wsFails += 1;
    if (wsFails >= WS_FAILS_TO_POLL) startFallbackPolling();
    const delay = wsRetryMs;
    wsRetryMs = Math.min(wsRetryMs * 2, WS_RETRY_MAX_MS);
    timers.push(setTimeout(connectWS, delay));
  };

  // Liveness watchdog: a half-open socket (bridge killed hard) emits no close
  // event — force-reconnect after STALE_MS of silence.
  watchdogInterval = setInterval(() => {
    if (!ws) return;
    if (ws.readyState === WebSocket.OPEN && lastWsMsgAt > 0
        && Date.now() - lastWsMsgAt > STALE_MS) {
      try { ws.close(); } catch { /* noop */ }
    } else if (ws.readyState === WebSocket.CONNECTING && wsConnectingAt > 0
        && Date.now() - wsConnectingAt > STALE_MS) {
      try { ws.close(); } catch { /* noop */ }
      ws = null;
      wsConnectingAt = 0;
      onWsDown();
    }
  }, STALE_MS / 2);

  const statusPoll = () => {
    fetch('/api/focus-tool/live-ws')
      .then(r => r.json())
      .then((j: { success: boolean; status: FocusWSBridgeStatus }) => {
        if (disposed || !j.success || !j.status) return;
        const s = j.status;
        const key = `${s.status}|${s.pid ?? ''}|${s.subscribed ?? ''}|${s.ws_port ?? ''}`;
        if (key !== lastStatusKey) {
          lastStatusKey = key;
          onUpdate({ bridgeStatus: s });
        }
        if (typeof s.ws_port === 'number' && s.ws_port !== wsPort) {
          wsPort = s.ws_port;
          connectWS();
        }
      })
      .catch(() => {});
  };

  statusPoll();
  statusInterval = setInterval(statusPoll, STATUS_POLL_MS);

  // Poll over HTTP until the WS is discovered + connected, so the page paints
  // immediately on load rather than waiting for the bridge.
  startFallbackPolling();

  return () => {
    disposed = true;
    if (rafId != null) cancelAnimationFrame(rafId);
    if (statusInterval) clearInterval(statusInterval);
    if (watchdogInterval) clearInterval(watchdogInterval);
    stopFallbackPolling();
    timers.forEach(clearTimeout);
    try { ws?.close(); } catch { /* noop */ }
    ws = null;
  };
}

export function useFocusToolWS(): FocusToolWSResult {
  const [state, setState] = useState<ChannelState>(EMPTY_STATE);

  useEffect(() => {
    const cleanup = runChannel(patch => setState(prev => ({ ...prev, ...patch })));
    return cleanup;
  }, []);

  return state;
}
