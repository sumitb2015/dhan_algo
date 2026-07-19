'use client';

/**
 * useLiveOptionsWS — realtime live-options quotes for the scalper pages.
 *
 * Primary transport: direct WebSocket to the Python bridge's localhost push
 * server (ws://127.0.0.1:<port>, port discovered from the bridge status via
 * /api/options/live). Quotes are pushed the instant a market tick arrives —
 * no polling delay, no file hop, no Next.js in the hot path.
 *
 * Fallback transport: the original 100ms HTTP poll of /api/options/live,
 * used when the WS can't connect (bridge older version, port blocked, etc.).
 * WS reconnection keeps retrying in the background and flips back when up.
 *
 * Render pacing: pushes can arrive at 20-40Hz; snapshots are stashed in a ref
 * and flushed to React state via requestAnimationFrame, so we render at most
 * once per frame with the freshest data and never queue stale renders.
 */

import { useState, useEffect, useRef } from 'react';
import type { LiveQuotes, BridgeStatus } from '@/components/Scalper';

const STATUS_POLL_MS   = 5000;   // bridge status + ws_port discovery
const FALLBACK_POLL_MS = 100;    // HTTP polling cadence when WS is down
const WS_RETRY_BASE_MS = 500;    // reconnect backoff: 0.5s → 1s → 2s → 5s cap
const WS_RETRY_MAX_MS  = 5000;
const WS_FAILS_TO_POLL = 3;      // consecutive WS failures before HTTP fallback
const STALE_MS         = 10_000; // reject quotes older than this

interface StatusWithPort extends BridgeStatus {
  ws_port?: number | null;
}

export interface LiveOptionsWSResult {
  liveQuotes: LiveQuotes | null;
  bridgeStatus: BridgeStatus;
  lastUpdated: string;
  transport: 'ws' | 'poll';
}

export function useLiveOptionsWS(expiry: string, broker: string): LiveOptionsWSResult {
  const [liveQuotes, setLiveQuotes]     = useState<LiveQuotes | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ status: 'STOPPED' });
  const [lastUpdated, setLastUpdated]   = useState('');
  const [transport, setTransport]       = useState<'ws' | 'poll'>('poll');

  useEffect(() => {
    if (!expiry) return;

    // Expiry or broker changed: drop quotes from the previous state
    // immediately rather than displaying them until fresh data arrives.
    setLiveQuotes(null);
    setLastUpdated('');

    let disposed = false;
    let ws: WebSocket | null = null;
    let wsFails = 0;
    let wsRetryMs = WS_RETRY_BASE_MS;
    let wsPort: number | null = null;
    let lastWsMsgAt = 0;

    let rafId: number | null = null;
    const latestRef = { quotes: null as LiveQuotes | null };
    const timers: ReturnType<typeof setTimeout>[] = [];
    let statusInterval: ReturnType<typeof setInterval> | null = null;
    let pollInterval: ReturnType<typeof setInterval> | null = null;
    let watchdogInterval: ReturnType<typeof setInterval> | null = null;
    let lastStatusKey = '';

    // ── Shared guards (same semantics as the original poll loop) ──
    const acceptQuotes = (q: LiveQuotes | null): boolean => {
      if (!q) return false;
      if (q.expiry && q.expiry !== expiry) return false;
      if (q.updated_at) {
        const ageMs = Date.now() - new Date(q.updated_at).getTime();
        if (!(ageMs <= STALE_MS)) return false;   // NaN-safe: fail stale
      }
      return !!(q.strikes && Object.keys(q.strikes).length > 0);
    };

    // ── rAF-coalesced flush: at most one render per frame ──
    const scheduleFlush = () => {
      if (rafId != null) return;
      rafId = requestAnimationFrame(() => {
        rafId = null;
        if (disposed || !latestRef.quotes) return;
        setLiveQuotes(latestRef.quotes);
        setLastUpdated(new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        }));
      });
    };

    // ── HTTP fallback poll (verbatim port of the original loop body) ──
    const httpPoll = () => {
      fetch('/api/options/live')
        .then(r => r.json())
        .then((j: { success: boolean; status: StatusWithPort; quotes: LiveQuotes }) => {
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
      setTransport('poll');
      httpPoll();
      pollInterval = setInterval(httpPoll, FALLBACK_POLL_MS);
    };

    const stopFallbackPolling = () => {
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
    };

    // ── WebSocket transport ──
    const connectWS = () => {
      if (disposed || !wsPort || ws) return;
      try {
        ws = new WebSocket(`ws://127.0.0.1:${wsPort}`);
      } catch {
        ws = null;
        onWsDown();
        return;
      }

      ws.onopen = () => {
        if (disposed) return;
        wsFails = 0;
        wsRetryMs = WS_RETRY_BASE_MS;
        lastWsMsgAt = Date.now();
        stopFallbackPolling();
        setTransport('ws');
      };

      ws.onmessage = (ev) => {
        if (disposed) return;
        lastWsMsgAt = Date.now();
        try {
          const q = JSON.parse(ev.data as string) as LiveQuotes;
          if (acceptQuotes(q)) {
            latestRef.quotes = q;
            scheduleFlush();
          }
        } catch { /* malformed frame — ignore */ }
      };

      ws.onclose = () => { ws = null; if (!disposed) onWsDown(); };
      ws.onerror = () => { try { ws?.close(); } catch { /* noop */ } };
    };

    const onWsDown = () => {
      wsFails += 1;
      if (wsFails >= WS_FAILS_TO_POLL) startFallbackPolling();
      const delay = wsRetryMs;
      wsRetryMs = Math.min(wsRetryMs * 2, WS_RETRY_MAX_MS);
      timers.push(setTimeout(connectWS, delay));
    };

    // Liveness watchdog: a half-open socket (e.g. bridge killed hard) emits
    // no close event — force-reconnect after 10s of silence.
    watchdogInterval = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN && lastWsMsgAt > 0
          && Date.now() - lastWsMsgAt > STALE_MS) {
        try { ws.close(); } catch { /* noop */ }
      }
    }, STALE_MS / 2);

    // ── Status poll: bridge status chip + ws_port discovery (5s) ──
    const statusPoll = () => {
      fetch('/api/options/live?checkPid=1')
        .then(r => r.json())
        .then((j: { success: boolean; status: StatusWithPort }) => {
          if (disposed || !j.success || !j.status) return;
          const s = j.status;
          const key = `${s.status}|${s.pid ?? ''}|${s.subscribed ?? ''}|${s.ws_port ?? ''}`;
          if (key !== lastStatusKey) {
            lastStatusKey = key;
            setBridgeStatus(s);
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

    // Poll over HTTP until the WS is discovered + connected, so the panel
    // paints immediately on page load rather than waiting for the bridge.
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
  }, [expiry, broker]);

  return { liveQuotes, bridgeStatus, lastUpdated, transport };
}
