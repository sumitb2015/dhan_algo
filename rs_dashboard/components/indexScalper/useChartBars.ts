'use client';

// Candles for one /index-scalper chart pane: the underlying (NIFTY index / CRUDEOILM future) or one option's premium.
// Live candles are built from the WebSocket ticks (spot, or the option's live LTP in `ltpById`); the REST history is only
// the backfill: loaded per contract / interval / range, and again after a gap the ticks cannot have covered (the tab
// was hidden, or the feed went stale and came back: `refreshTick`). Nothing polls it on a timer. Read-only.

import { useEffect, useRef, useState } from 'react';
import { applyTick, mergeHistory, type Bar } from '@/lib/indexScalperIndicators';
import { inMarketSession, inOrderSession } from '@/lib/indexScalperSession';
import type { Underlying } from '@/lib/indexScalperInstrument';
import type { ResolvedSource } from '@/lib/indexScalperChartSource';
import type { IndexScalperFeed } from './useIndexScalperFeed';

export type Interval = '1' | '3' | '5' | '15';

const EMPTY: Bar[] = [];

export interface ChartBars {
  bars: Bar[];
  loading: boolean;
  error: string | null;
  /** Option pane: the bridge has no live price for this contract (outside its strike window, or not ticked yet). */
  noLiveTicks: boolean;
  /** What `bars` are of (underlying | contract | interval): the chart fits its view once per new value. */
  tag: string;
}

export function useChartBars(
  underlying: Underlying,
  resolved: ResolvedSource,
  interval: Interval,
  days: number,
  refreshTick: number,
  feed: IndexScalperFeed,
): ChartBars {
  const isOption = resolved.kind === 'option';
  // The contract whose bars these are. History is tagged with it AND the interval, so a strike / expiry / interval switch
  // never mixes two contracts' or two intervals' bars.
  const contractId = isOption ? resolved.dhanId : (underlying === 'CRUDEOILM' ? feed.future?.dhanId ?? null : 'idx');
  const tag = `${underlying}|${contractId ?? ''}|${interval}`;

  const [history, setHistory] = useState<{ tag: string; bars: Bar[] } | null>(null);
  // Bars are stored with the tag they were built for: right after a switch the state still holds the previous
  // contract's bars for one render, and those must never reach the chart as if they were the new contract's.
  const [state, setState] = useState<{ tag: string; bars: Bar[] }>({ tag: '', bars: [] });
  const setBars = (f: Bar[] | ((prev: Bar[]) => Bar[]), forTag: string) =>
    setState(cur => {
      const prev = cur.tag === forTag ? cur.bars : [];
      const next = typeof f === 'function' ? f(prev) : f;
      return next === cur.bars && cur.tag === forTag ? cur : { tag: forTag, bars: next };
    });
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // An option pane waits for its contract id (the expiry's strike map); crude's underlying pane may load before the
    // future id is known (the route then resolves the near future itself), as before.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (isOption && !contractId) { setLoading(false); return; }
    let dead = false;
    setLoading(true);
    const idParam = isOption
      ? `&kind=option&securityId=${contractId}`
      : (underlying === 'CRUDEOILM' && contractId ? `&securityId=${contractId}` : '');
    const forTag = tag;
    fetch(`/api/index-scalper/candles?underlying=${underlying}&interval=${interval}&days=${days}${idParam}`)
      .then(r => r.json())
      .then((j: { success: boolean; candles?: Bar[]; error?: string }) => {
        if (dead) return;
        if (!j.success || !j.candles) { setError(j.error ?? 'No candles'); return; }
        setError(null);
        setHistory({ tag: forTag, bars: j.candles });
      })
      .catch(e => { if (!dead) setError(String(e?.message ?? e)); })
      .finally(() => { if (!dead) setLoading(false); });
    return () => { dead = true; };
  }, [underlying, interval, days, refreshTick, contractId, isOption, tag]);

  const liveTagRef = useRef<string | null>(null);
  useEffect(() => {
    if (!history || history.tag !== tag) {
      // Switched contract / interval, history not loaded yet: show nothing rather than the old bars, and take no ticks.
      liveTagRef.current = null;
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setBars([], tag);
      return;
    }
    const same = liveTagRef.current === tag;
    liveTagRef.current = tag;
    setBars(prev => (same ? mergeHistory(history.bars, prev, Number(interval), Date.now() / 1000) : history.bars), tag);
  }, [history, tag, interval]);

  // Live price: spot for the underlying; the option's live bridge LTP (never a snapshot or prev close) for an option.
  const livePrice = isOption ? (contractId ? feed.ltpById.get(contractId) ?? null : null) : feed.spot;
  useEffect(() => {
    if (livePrice === null || !(livePrice > 0) || feed.stale || feed.feedAgeSec === null) return;
    // Outside the market session a held-over price must not invent a candle.
    // (an option's premium trades to 15:40, the index stops at 15:30)
    if (!(isOption ? inOrderSession(underlying, Date.now()) : inMarketSession(underlying, Date.now()))) return;
    setBars(prev => (liveTagRef.current === tag ? applyTick(prev, livePrice, Number(interval), Date.now() / 1000, underlying, isOption) : prev), tag);
    // feed.stale / feedAgeSec are read as guards only: a new tick is what moves a bar.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePrice, feed.quotes, tag, interval, underlying]);

  const noLiveTicks = isOption && feed.quotes !== null && livePrice === null;
  const bars = state.tag === tag ? state.bars : EMPTY;
  return { bars, loading, error, noLiveTicks, tag };
}
