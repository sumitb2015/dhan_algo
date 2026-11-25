'use client';

import { useEffect, useRef, useState } from 'react';
import type { RawQuote } from '@/lib/indexScalperMarketWatch';

export interface WatchBlock { updated_at: string | null; quotes: Record<string, RawQuote> }
export interface MarketWatchData { indices: WatchBlock | null; stocks: WatchBlock | null }

const FLASH_MS = 600;

/**
 * Live quotes for the market-watch windows over one EventSource (SSE) per page, open only while a window is.
 * The source of both blocks is the shared Dhan WebSocket hub (see the stream route); opening a window fires the
 * idempotent bridge start once per page load and never stops a bridge (other pages share them).
 */
export function useMarketWatch(wantIndices: boolean, wantStocks: boolean) {
  const [data, setData] = useState<MarketWatchData>({ indices: null, stocks: null });
  const [flash, setFlash] = useState<Record<string, 'up' | 'down'>>({});
  const [now, setNow] = useState(() => Date.now());
  const last = useRef<Record<string, number>>({});
  const started = useRef<{ indices: boolean; stocks: boolean }>({ indices: false, stocks: false });

  // Start the bridges (idempotent routes) the first time each window opens.
  useEffect(() => {
    const start = (url: string) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }).catch(() => {});
    if (wantIndices && !started.current.indices) { started.current.indices = true; void start('/api/live-indices'); }
    if (wantStocks && !started.current.stocks) { started.current.stocks = true; void start('/api/live-equity'); }
  }, [wantIndices, wantStocks]);

  useEffect(() => {
    if (!wantIndices && !wantStocks) return;
    const want = [wantIndices && 'indices', wantStocks && 'stocks'].filter(Boolean).join(',');
    const es = new EventSource(`/api/index-scalper/market-watch/stream?want=${want}`);
    let flashTimer: ReturnType<typeof setTimeout> | undefined;
    es.onmessage = ev => {
      let msg: Partial<MarketWatchData>;
      try { msg = JSON.parse(ev.data); } catch { return; }
      const dirs: Record<string, 'up' | 'down'> = {};
      for (const [prefix, block] of [['i:', msg.indices], ['s:', msg.stocks]] as const) {
        for (const [k, q] of Object.entries(block?.quotes ?? {})) {
          const ltp = q?.ltp;
          if (typeof ltp !== 'number' || !(ltp > 0)) continue;
          const prev = last.current[prefix + k];
          if (prev !== undefined && ltp !== prev) dirs[prefix + k] = ltp > prev ? 'up' : 'down';
          last.current[prefix + k] = ltp;
        }
      }
      setData(d => ({ indices: msg.indices ?? d.indices, stocks: msg.stocks ?? d.stocks }));
      if (Object.keys(dirs).length) {
        setFlash(dirs);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => setFlash({}), FLASH_MS);
      }
    };
    return () => { es.close(); clearTimeout(flashTimer); };
  }, [wantIndices, wantStocks]);

  // Age clock: a frozen feed must turn STALE on screen even though no frame arrives.
  useEffect(() => {
    if (!wantIndices && !wantStocks) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [wantIndices, wantStocks]);

  return { data, flash, now };
}
