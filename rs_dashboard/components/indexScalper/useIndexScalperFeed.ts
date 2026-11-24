'use client';

// Live data for /index-scalper (Dhan only): the shared options tick bridge (spot + per-strike LTP / OI / buildup), the
// expiry list, lot size and strike -> security id map. Nothing here places an order.

import { useEffect, useMemo, useRef, useState } from 'react';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import type { LiveQuotes } from '@/components/Scalper';

export interface StrikeIds { ceId?: string; peId?: string }

const UNDERLYING = 'NIFTY';
const STALE_FEED_MS = 10_000;

const newId = () => `isx_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

export interface IndexScalperFeed {
  expiries: string[];
  expiry: string;
  setExpiry: (e: string) => void;
  quotes: LiveQuotes | null;
  spot: number | null;
  /** Seconds since the last tick; null when no tick has arrived. */
  feedAgeSec: number | null;
  stale: boolean;
  lotSize: number | null;
  strikeIds: Map<number, StrikeIds>;
  /** security id -> last premium, for every strike the bridge tracks. */
  ltpById: Map<string, number>;
}

export function useIndexScalperFeed(): IndexScalperFeed {
  const [viewerId] = useState(newId);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [lotSize, setLotSize] = useState<number | null>(null);
  const [strikeIdsRaw, setStrikeIdsRaw] = useState<Record<string, StrikeIds>>({});
  const [lookupFor, setLookupFor] = useState('');
  const [nowMs, setNowMs] = useState(0);

  useEffect(() => {
    let dead = false;
    fetch(`/api/options/expiries?underlying=${UNDERLYING}&broker=dhan`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (dead || !j.success || !Array.isArray(j.data) || j.data.length === 0) return;
        setExpiries(j.data);
        setExpiry(prev => (prev && j.data!.includes(prev) ? prev : j.data![0]));
      })
      .catch(() => {});
    return () => { dead = true; };
  }, []);

  // Start the shared tick bridge for this expiry; stop it only on unmount (the route ignores the stop if another page
  // is still heartbeating the same bridge).
  const startedRef = useRef(false);
  useEffect(() => {
    if (!expiry) return;
    startedRef.current = true;
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'start', underlying: UNDERLYING, expiry, numStrikes: 35, broker: 'dhan', viewer: viewerId }),
    }).catch(() => {});
  }, [expiry, viewerId]);
  useEffect(() => () => {
    if (!startedRef.current) return;
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'stop', brokers: ['dhan'], underlying: UNDERLYING, viewer: viewerId }),
      keepalive: true,
    }).catch(() => {});
  }, [viewerId]);

  const { liveQuotes: raw } = useLiveOptionsWS(expiry, 'dhan', ['dhan'], UNDERLYING);
  const quotes = useMemo(() => {
    if (!raw) return null;
    if (raw.underlying && raw.underlying.toUpperCase() !== UNDERLYING) return null;
    if (raw.expiry && expiry && raw.expiry !== expiry) return null;
    return raw;
  }, [raw, expiry]);

  useEffect(() => {
    if (!expiry) return;
    let dead = false;
    const key = expiry;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLotSize(null);
    // The strike -> id map is per expiry: drop the old one so a pick made before the new lookup lands has no id
    // (refused) instead of the previous expiry's id.
    setStrikeIdsRaw({});
    fetch(`/api/scalper/lookup?underlying=${UNDERLYING}&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIds> } }) => {
        if (dead || !j.success || !j.data) return;
        setStrikeIdsRaw(j.data.strikes ?? {});
        if (typeof j.data.lotSize === 'number' && j.data.lotSize > 0) setLotSize(j.data.lotSize);
        setLookupFor(key);
      })
      .catch(() => {});
    return () => { dead = true; };
  }, [expiry]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setNowMs(Date.now());
    const t = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const strikeIds = useMemo(() => {
    const m = new Map<number, StrikeIds>();
    if (lookupFor !== expiry) return m;
    for (const [k, v] of Object.entries(strikeIdsRaw)) m.set(Number(k), v);
    return m;
  }, [strikeIdsRaw, lookupFor, expiry]);

  const ltpById = useMemo(() => {
    const m = new Map<string, number>();
    if (!quotes) return m;
    for (const sd of Object.values(quotes.strikes ?? {})) {
      const ids = strikeIds.get(Number(sd.strike));
      if (!ids) continue;
      if (ids.ceId && sd.ce?.ltp > 0) m.set(String(ids.ceId), sd.ce.ltp);
      if (ids.peId && sd.pe?.ltp > 0) m.set(String(ids.peId), sd.pe.ltp);
    }
    return m;
  }, [quotes, strikeIds]);

  const lastTick = quotes?.updated_at ? Date.parse(quotes.updated_at) : 0;
  const feedAgeSec = lastTick > 0 && nowMs > 0 ? Math.max(0, (nowMs - lastTick) / 1000) : null;
  const spot = quotes && quotes.spot > 0 ? quotes.spot : null;

  return {
    expiries, expiry, setExpiry, quotes, spot, feedAgeSec,
    stale: feedAgeSec !== null && feedAgeSec > STALE_FEED_MS / 1000,
    // The lookup that produced this lot size must be for the expiry on screen; until then an order is refused.
    lotSize: lookupFor === expiry ? lotSize : null,
    strikeIds, ltpById,
  };
}
