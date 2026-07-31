'use client';

/**
 * useLiveOptionsWS — realtime live-options quotes for the scalper pages.
 *
 * Runs one independent "channel" per broker concurrently (status poll -> ws_port
 * discovery -> WebSocket connect w/ backoff -> 100ms HTTP fallback poll ->
 * rAF-coalesced flush), keyed only on `expiry`. Switching the selected broker
 * is a pure local read of the already-warm channel for that broker — no
 * reconnect, no Next.js round trip, no Python process spawn. This is what
 * makes a Dhan <-> Zerodha toggle instant instead of restarting a bridge.
 *
 * Primary transport per channel: direct WebSocket to the Python bridge's
 * localhost push server (ws://127.0.0.1:<port>, port discovered from that
 * broker's bridge status via /api/options/live?broker=<x>). Quotes are pushed
 * the instant a market tick arrives — no polling delay, no file hop, no
 * Next.js in the hot path.
 *
 * Fallback transport per channel: a 100ms HTTP poll of /api/options/live,
 * used when the WS can't connect (bridge older version, port blocked, etc.).
 * WS reconnection keeps retrying in the background and flips back when up.
 *
 * Render pacing: pushes can arrive at 20-40Hz; snapshots are stashed in a ref
 * and flushed to React state via requestAnimationFrame, so we render at most
 * once per frame with the freshest data and never queue stale renders.
 */

import { useEffect, useState } from 'react';
import type { LiveQuotes, BridgeStatus } from '@/components/Scalper';

const STATUS_POLL_MS   = 5000;   // bridge status + ws_port discovery
const FALLBACK_POLL_MS = 100;    // HTTP polling cadence when WS is down
const WS_RETRY_BASE_MS = 500;    // reconnect backoff: 0.5s → 1s → 2s → 5s cap
const WS_RETRY_MAX_MS  = 5000;
const WS_FAILS_TO_POLL = 3;      // consecutive WS failures before HTTP fallback
const STALE_MS         = 10_000; // reject quotes older than this

export type Broker = 'dhan' | 'zerodha' | 'kotak';

/**
 * Which broker's tick bridge feeds each broker's quote display.
 *
 * Kotak has no bridge of its own and does not need one: an option's LTP is set
 * by the exchange, not by the broker you view it through, so Dhan's feed is the
 * same data. Only order routing is genuinely broker-specific. Mapping it here
 * (rather than spawning a second identical NIFTY feed) also avoids burning a
 * duplicate WebSocket subscription.
 */
const QUOTE_CHANNEL: Record<Broker, Exclude<Broker, 'kotak'>> = {
  dhan: 'dhan',
  zerodha: 'zerodha',
  kotak: 'dhan',
};

interface StatusWithPort extends BridgeStatus {
  ws_port?: number | null;
}

export interface LiveOptionsWSResult {
  liveQuotes: LiveQuotes | null;
  bridgeStatus: BridgeStatus;
  lastUpdated: string;
  transport: 'ws' | 'poll';
}

type ChannelState = LiveOptionsWSResult;

const EMPTY_STATE: ChannelState = {
  liveQuotes: null,
  bridgeStatus: { status: 'STOPPED' },
  lastUpdated: '',
  transport: 'poll',
};

/**
 * Runs one broker's full live-quotes lifecycle. Returns a disposer. Two
 * instances run side by side (one per broker) so both feeds stay warm at
 * all times regardless of which one is currently displayed.
 */
function runChannel(
  broker: Broker,
  expiry: string,
  underlying: string,
  onUpdate: (patch: Partial<ChannelState>) => void,
): () => void {
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
    if (q.underlying && q.underlying !== underlying) return false;
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
      onUpdate({
        liveQuotes: latestRef.quotes,
        lastUpdated: new Date().toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', second: '2-digit',
        }),
      });
    });
  };

  // ── HTTP fallback poll ──
  const httpPoll = () => {
    fetch(`/api/options/live?broker=${broker}`)
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
    onUpdate({ transport: 'poll' });
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
      onUpdate({ transport: 'ws' });
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
    fetch(`/api/options/live?checkPid=1&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; status: StatusWithPort }) => {
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
}

export function useLiveOptionsWS(
  expiry: string,
  broker: Broker,
  authenticatedBrokers: Broker[] = ['dhan', 'zerodha'],
  underlying: string = 'NIFTY',
): LiveOptionsWSResult {
  const [channels, setChannels] = useState<Record<string, ChannelState>>({
    dhan: EMPTY_STATE,
    zerodha: EMPTY_STATE,
  });

  // Dedupe through QUOTE_CHANNEL so an authenticated Kotak session does not
  // start a second copy of the Dhan feed it shares.
  const authKey = Array.from(
    new Set(authenticatedBrokers.map(b => QUOTE_CHANNEL[b] ?? 'dhan')),
  ).sort().join(',');

  useEffect(() => {
    if (!expiry) return;

    // Expiry, underlying, (or the set of authenticated brokers) changed: drop
    // quotes from both channels immediately rather than displaying stale data.
    setChannels({ dhan: EMPTY_STATE, zerodha: EMPTY_STATE });

    const brokers = authKey.split(',').filter(Boolean) as Broker[];
    const cleanups = brokers.map(b =>
      runChannel(b, expiry, underlying, (patch) => {
        setChannels(prev => ({ ...prev, [b]: { ...prev[b], ...patch } }));
      })
    );

    return () => { cleanups.forEach(fn => fn()); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [expiry, authKey, underlying]);

  return channels[QUOTE_CHANNEL[broker] ?? 'dhan'] ?? EMPTY_STATE;
}
