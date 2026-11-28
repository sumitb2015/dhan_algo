'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ContributionResult } from '@/lib/niftyContribution';
import { readPref, savePref } from '@/lib/localPref';
import { istDateIso } from '@/lib/nseHolidays';
import { appendSample, niftyBreadth, validSamples, type BreadthSample } from '@/lib/indexScalperBreadth';

export type ContribFeedState = 'live' | 'starting' | 'stale' | 'stopped';
export interface ContribFeed { state: ContribFeedState; updatedAt: number | null; ageMs: number | null }
export interface ContribResp {
  success: boolean; error?: string; serverTime: number; weightsAsOf: string | null;
  feeds: { stocks: ContribFeed; indices: ContribFeed };
  nifty: { ltp: number; prevClose: number; change: number; changePct: number } | null;
  result: ContributionResult;
}

const POLL_MS = 2000;
const HISTORY_KEY = 'indexScalperBreadth:';

/**
 * Nifty 50 contribution + breadth for the Index Scalper's A/D and Contribution windows: polls the read-only
 * /api/nifty-contribution while either window is open. The first open per page load fires the idempotent start of the
 * two bridges that route reads (daily market stocks, live indices); a bridge is never stopped from here (other pages
 * share them). The intraday A/D line is sampled here, so it keeps growing while only one of the windows is open.
 */
export function useNiftyContribution(enabled: boolean) {
  const [data, setData] = useState<ContribResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<BreadthSample[]>([]);
  const seq = useRef(0);
  const started = useRef(false);
  const restored = useRef(false);

  useEffect(() => {
    if (!enabled || started.current) return;
    started.current = true;
    const start = (url: string) =>
      fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'start' }) }).catch(() => {});
    void start('/api/daily-market');
    void start('/api/live-indices');
  }, [enabled]);

  // Today's A/D line survives a reload (storage may be blocked: the line then starts from memory).
  useEffect(() => {
    if (!enabled || restored.current) return;
    restored.current = true;
    let saved: BreadthSample[] = [];
    try { saved = validSamples(JSON.parse(readPref(HISTORY_KEY + istDateIso(Date.now())) ?? '[]')); } catch { saved = []; }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (saved.length) setHistory(saved);
  }, [enabled]);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    try {
      const r = await fetch('/api/nifty-contribution', { cache: 'no-store' });
      const j = await r.json().catch(() => null) as ContribResp | null;
      if (mine !== seq.current) return;
      if (!r.ok || !j?.success) { setError(j?.error ?? `HTTP ${r.status}`); return; }
      setData(j);
      setError(null);
    } catch (e) {
      if (mine === seq.current) setError(e instanceof Error ? e.message : 'Network error');
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const counter = seq;
    const first = setTimeout(load, 0);
    const t = setInterval(() => { if (!document.hidden) void load(); }, POLL_MS);
    const onVis = () => { if (!document.hidden) void load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearTimeout(first); clearInterval(t); document.removeEventListener('visibilitychange', onVis); counter.current++; };
  }, [enabled, load]);

  // One A/D point per 30 s while the stock feed is live; a stale feed would only repeat the same quotes.
  useEffect(() => {
    if (!data || data.feeds.stocks.state !== 'live' || data.result.rows.length === 0) return;
    const b = niftyBreadth(data.result);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setHistory(h => {
      const next = appendSample(h, { t: data.serverTime, adv: b.advances, dec: b.declines }, istDateIso);
      if (next !== h) savePref(HISTORY_KEY + istDateIso(data.serverTime), JSON.stringify(next));
      return next;
    });
  }, [data]);

  return { data, error, history };
}
