'use client';

import { useState, useEffect, useRef, useCallback } from 'react';

export interface DailyMarketQuote {
  symbol: string;
  company: string;
  industry: string;
  ltp: number;
  change: number;
  change_pct: number;
  prev_close: number;
  open: number;
  high: number;
  low: number;
  vwap: number;
  volume: number;
  turnover_cr: number;
  high_52w: number;
  low_52w: number;
}

export interface DailyMarketWSState {
  quotes: Record<string, DailyMarketQuote>;
  flashMap: Record<string, 'up' | 'down'>;
  wsStatus: 'connected' | 'connecting' | 'stopped' | 'error';
  transport: 'ws' | 'poll';
  lastTickTime: Date | null;
  wsPort: number;
  bridgeStatus: 'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR';
  indexConstituents: {
    nifty50: string[];
    banknifty: string[];
    nifty500: string[];
  };
  isLoading: boolean;
  startBridge: () => Promise<void>;
  stopBridge: () => Promise<void>;
}

const FLUSH_MIN_MS = 120;
const STATUS_POLL_MS = 3000;
const WS_RETRY_BASE_MS = 600;
const WS_RETRY_MAX_MS = 5000;

export function useDailyMarketWS(): DailyMarketWSState {
  const [quotes, setQuotes] = useState<Record<string, DailyMarketQuote>>({});
  const [flashMap, setFlashMap] = useState<Record<string, 'up' | 'down'>>({});
  const [wsStatus, setWsStatus] = useState<'connected' | 'connecting' | 'stopped' | 'error'>('connecting');
  const [transport, setTransport] = useState<'ws' | 'poll'>('poll');
  const [lastTickTime, setLastTickTime] = useState<Date | null>(null);
  const [wsPort, setWsPort] = useState<number>(8975);
  const [bridgeStatus, setBridgeStatus] = useState<'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR'>('STARTING');
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [indexConstituents, setIndexConstituents] = useState<{
    nifty50: string[];
    banknifty: string[];
    nifty500: string[];
  }>({
    nifty50: [],
    banknifty: [],
    nifty500: [],
  });

  const quotesRef = useRef<Record<string, DailyMarketQuote>>({});
  const prevLtpRef = useRef<Record<string, number>>({});
  const wsRef = useRef<WebSocket | null>(null);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingQuotesRef = useRef<Record<string, DailyMarketQuote> | null>(null);
  const retryTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const flashClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryDelayRef = useRef<number>(WS_RETRY_BASE_MS);
  const isDisposedRef = useRef<boolean>(false);
  const portRef = useRef<number>(8975);
  const userStoppedRef = useRef<boolean>(false);
  const autoStartedRef = useRef<boolean>(false);

  // ── Flush Batched Updates to React State ───────────────────────────────────
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) return;
    flushTimerRef.current = setTimeout(() => {
      flushTimerRef.current = null;
      if (isDisposedRef.current || !pendingQuotesRef.current) return;

      const incoming = pendingQuotesRef.current;
      pendingQuotesRef.current = null;

      // Compute flash map for changed LTPs
      const newFlash: Record<string, 'up' | 'down'> = {};
      for (const [sym, q] of Object.entries(incoming)) {
        const prev = prevLtpRef.current[sym];
        if (prev !== undefined && q.ltp !== prev && q.ltp > 0 && prev > 0) {
          newFlash[sym] = q.ltp > prev ? 'up' : 'down';
        }
        prevLtpRef.current[sym] = q.ltp;
      }

      const merged = { ...quotesRef.current, ...incoming };
      quotesRef.current = merged;
      setQuotes(merged);
      setLastTickTime(new Date());

      // Flash only what changed in THIS flush; one shared timer so an older timeout
      // can't wipe a newer flash early.
      setFlashMap(newFlash);
      if (flashClearRef.current) clearTimeout(flashClearRef.current);
      if (Object.keys(newFlash).length > 0) {
        flashClearRef.current = setTimeout(() => {
          if (!isDisposedRef.current) setFlashMap({});
        }, 500);
      }
    }, FLUSH_MIN_MS);
  }, []);

  // ── HTTP Initial Seed & Poll ───────────────────────────────────────────────
  const fetchStatusAndQuotes = useCallback(async () => {
    try {
      const res = await fetch('/api/daily-market');
      if (!res.ok) return;
      const json = await res.json();
      if (!json.success) return;

      if (json.indexConstituents) {
        setIndexConstituents(json.indexConstituents);
      }

      const port = json.ws_port || 8975;
      portRef.current = port;
      setWsPort(port);

      const bStatus = json.status?.status || 'STOPPED';
      setBridgeStatus(bStatus);

      // Seed quotes if available. While the WebSocket is live its frames are fresher than the
      // 1s-old file snapshot, so only seed from the file when no WS is open (else values flicker back).
      const wsOpen = wsRef.current?.readyState === WebSocket.OPEN;
      const incomingQuotes = json.quotes?.quotes as Record<string, DailyMarketQuote> | undefined;
      if (!wsOpen && incomingQuotes && Object.keys(incomingQuotes).length > 0) {
        quotesRef.current = { ...quotesRef.current, ...incomingQuotes };
        setQuotes(quotesRef.current);
        setIsLoading(false);
      } else if (!wsOpen && json.baseline?.baseline) {
        // Fallback seed from baseline cache if live quotes haven't arrived yet
        const base = json.baseline.baseline as Record<string, any>;
        const seeded: Record<string, DailyMarketQuote> = {};
        for (const [sym, b] of Object.entries(base)) {
          const ltp = b.seed_close || b.prev_close || 0;
          const prev = b.prev_close || 0;
          const chg = prev > 0 && ltp > 0 ? ltp - prev : 0;
          const chgPct = prev > 0 && ltp > 0 ? (chg / prev) * 100 : 0;
          seeded[sym] = {
            symbol: sym,
            company: b.company || sym,
            industry: b.industry || 'General',
            ltp: ltp,
            change: Math.round(chg * 100) / 100,
            change_pct: Math.round(chgPct * 100) / 100,
            prev_close: prev,
            open: b.seed_open || ltp,
            high: b.seed_high || ltp,
            low: b.seed_low || ltp,
            vwap: ltp,
            volume: b.seed_volume || 0,
            turnover_cr: 0,
            high_52w: b.high_52w || 0,
            low_52w: b.low_52w || 0,
          };
        }
        if (Object.keys(quotesRef.current).length === 0) {
          quotesRef.current = seeded;
          setQuotes(seeded);
          setIsLoading(false);
        }
      }

      // Auto-start once per page load, and never after the user pressed Stop
      // (otherwise the next 3s poll immediately undoes the Stop).
      if (bStatus === 'STOPPED' && !userStoppedRef.current && !autoStartedRef.current) {
        autoStartedRef.current = true;
        fetch('/api/daily-market', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'start' }),
        }).catch(() => {});
      }
    } catch {
      // transient network error
    }
  }, []);

  // ── Connect Localhost WebSocket ────────────────────────────────────────────
  const connectWebSocket = useCallback((port: number) => {
    if (isDisposedRef.current || wsRef.current) return;

    try {
      setWsStatus('connecting');
      const ws = new WebSocket(`ws://127.0.0.1:${port}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (isDisposedRef.current) return;
        setWsStatus('connected');
        setTransport('ws');
        retryDelayRef.current = WS_RETRY_BASE_MS;
      };

      ws.onmessage = (event) => {
        if (isDisposedRef.current) return;
        try {
          const parsed = JSON.parse(event.data as string);
          if (parsed.type === 'quotes' && parsed.quotes) {
            pendingQuotesRef.current = {
              ...(pendingQuotesRef.current || {}),
              ...parsed.quotes,
            };
            scheduleFlush();
            setIsLoading(false);
          }
        } catch {
          // ignore malformed frame
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (isDisposedRef.current) return;
        setWsStatus('error');
        setTransport('poll');

        // Reconnect backoff
        const delay = retryDelayRef.current;
        retryDelayRef.current = Math.min(delay * 1.5, WS_RETRY_MAX_MS);
        retryTimeoutRef.current = setTimeout(() => {
          connectWebSocket(portRef.current);
        }, delay);
      };

      ws.onerror = () => {
        try { ws.close(); } catch { /* ignore */ }
      };
    } catch {
      setWsStatus('error');
      setTransport('poll');
    }
  }, [scheduleFlush]);

  // Close the socket WITHOUT letting its onclose reschedule a reconnect or null a newer wsRef.
  const detachWebSocket = useCallback(() => {
    const ws = wsRef.current;
    wsRef.current = null;
    if (!ws) return;
    ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
    try { ws.close(); } catch { /* ignore */ }
  }, []);

  // ── Actions ────────────────────────────────────────────────────────────────
  const startBridge = useCallback(async () => {
    userStoppedRef.current = false;
    try {
      const res = await fetch('/api/daily-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start' }),
      });
      const data = await res.json();
      if (data.ws_port) {
        portRef.current = data.ws_port;
        setWsPort(data.ws_port);
        detachWebSocket();
        if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
        setTimeout(() => connectWebSocket(data.ws_port), 1000);
      }
      setBridgeStatus('RUNNING');
    } catch { /* ignore */ }
  }, [connectWebSocket, detachWebSocket]);

  const stopBridge = useCallback(async () => {
    userStoppedRef.current = true;
    try {
      await fetch('/api/daily-market', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      setBridgeStatus('STOPPED');
      setWsStatus('stopped');
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      detachWebSocket();
    } catch { /* ignore */ }
  }, [detachWebSocket]);

  // ── Main Effect ────────────────────────────────────────────────────────────
  useEffect(() => {
    isDisposedRef.current = false;

    fetchStatusAndQuotes().then(() => {
      connectWebSocket(wsPort);
    });

    // Fallback polling for bridge status & file sync
    pollIntervalRef.current = setInterval(() => {
      fetchStatusAndQuotes();
    }, STATUS_POLL_MS);

    return () => {
      isDisposedRef.current = true;
      detachWebSocket();
      if (flashClearRef.current) clearTimeout(flashClearRef.current);
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
      if (retryTimeoutRef.current) clearTimeout(retryTimeoutRef.current);
      if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    };
  }, [fetchStatusAndQuotes, connectWebSocket, detachWebSocket, wsPort]);

  return {
    quotes,
    flashMap,
    wsStatus,
    transport,
    lastTickTime,
    wsPort,
    bridgeStatus,
    indexConstituents,
    isLoading,
    startBridge,
    stopBridge,
  };
}
