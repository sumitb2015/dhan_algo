'use client';

/**
 * StrategyChartModal: live combined-premium chart of one Multi-Leg Focus strategy,
 * plotted from the basket's current (non-closed) legs. Reuses the Live Charts
 * strategy endpoint (single expiry), so Calendar/Diagonal baskets are excluded by the caller.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FocusModal } from '../FocusTool';
import { StrategyChart, type StrategyChartType } from '@/components/StrategyChart';
import { Spinner } from '@/components/Spinner';
import { isAbortError, optionsChartApi } from '@/lib/optionsChartApi';
import { isUnderlyingLive } from '@/lib/marketHours';
import {
  OFF_HOURS_POLL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  type CustomStrategyChartResponse,
  type StrategyLeg,
} from '@/lib/optionsChartTypes';
import { CHART_UNDERLYINGS } from '@/lib/underlyings';
import { isOptionLeg, type MultiLegLeg } from '@/lib/multiLegFocus';
import { FOCUS_RING } from '../Scalper';

const INTERVALS = ['1', '2', '3', '5'] as const;

/** Chart legs for a basket: every live (not CLOSED/FAILED) leg, same-contract legs merged. */
export function chartLegsFor(legs: MultiLegLeg[], lotSize?: number): StrategyLeg[] {
  const merged = new Map<string, StrategyLeg>();
  // Option legs only: the chart plots option premiums (futures legs are on the payoff chart).
  for (const l of legs.filter(isOptionLeg)) {
    if (l.status === 'CLOSED' || l.status === 'FAILED' || !(l.lots > 0) || !Number.isFinite(l.strike)) continue;
    // A placed leg is sized from what actually filled (ledger qty / lot size), not the ordered
    // lots. Only when the qty divides cleanly; crude quantity semantics differ, so the caller
    // omits lotSize there and the ordered lots are used.
    const filled = l.fill?.qty ?? 0;
    const filledLots = lotSize && lotSize > 0 && filled > 0 ? Math.round(filled / lotSize) : 0;
    const lots = l.status === 'OPEN' && filledLots > 0 && Math.abs(filledLots * (lotSize as number) - filled) < 1e-6 ? filledLots : l.lots;
    const action = l.side === 'B' ? 'BUY' : 'SELL';
    const key = `${l.strike}:${l.option}:${action}`;
    const hit = merged.get(key);
    if (hit) hit.lots += lots;
    else merged.set(key, { option_type: l.option, action, strike: l.strike, lots });
  }
  return [...merged.values()];
}

export function isChartableUnderlying(u: string): boolean {
  return (CHART_UNDERLYINGS as readonly string[]).includes(u);
}

interface Props {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  underlying: string;
  expiry: string;
  legs: MultiLegLeg[];
  /** Contract lot size; omit for MCX/crude so ordered lots are used. */
  lotSize?: number;
}

export default function StrategyChartModal({ isOpen, onClose, title, underlying, expiry, legs, lotSize }: Props) {
  const [interval_, setInterval_] = useState<string>('1');
  const [chartType, setChartType] = useState<StrategyChartType>('line');
  const [showSpot, setShowSpot] = useState(false);
  const [chart, setChart] = useState<CustomStrategyChartResponse | null>(null);
  const [errorState, setErrorState] = useState<{ key: string; msg: string } | null>(null);
  const [loadedKey, setLoadedKey] = useState('');
  const [lastOkAt, setLastOkAt] = useState<number | null>(null);

  const chartLegs = useMemo(() => chartLegsFor(legs, lotSize), [legs, lotSize]);
  const legsKey = useMemo(() => JSON.stringify(chartLegs), [chartLegs]);
  const selectionKey = `${underlying}|${expiry}|${legsKey}|${interval_}|${showSpot}`;
  const loading = loadedKey !== selectionKey;
  // An error belongs to the selection that raised it; a new selection must not inherit it.
  const error = errorState && errorState.key === selectionKey ? errorState.msg : null;
  const seqRef = useRef(0);

  useEffect(() => {
    if (!isOpen || !expiry || chartLegs.length === 0) return;
    let cancelled = false;
    let inFlight: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    function load() {
      inFlight?.abort();
      const controller = new AbortController();
      inFlight = controller;
      const seq = ++seqRef.current;
      optionsChartApi
        .strategy(
          { underlying, expiry, legs: chartLegs, interval: interval_, indicators: [], includeSpot: showSpot },
          controller.signal,
        )
        .then((r) => {
          if (cancelled || seq !== seqRef.current) return;
          setChart(r);
          setErrorState(null);
          setLastOkAt(Date.now());
          setLoadedKey(selectionKey);
        })
        .catch((e) => {
          if (cancelled || isAbortError(e) || seq !== seqRef.current) return;
          setErrorState({ key: selectionKey, msg: e instanceof Error ? e.message : 'Failed to load strategy chart.' });
          setLoadedKey(selectionKey);
        });
    }
    // Cadence is re-evaluated every tick (the session can close while the modal is open), and a
    // hidden tab skips the poll so it doesn't keep spawning Python in the background.
    function schedule() {
      const live = isUnderlyingLive(underlying, new Date());
      timer = setTimeout(() => {
        if (cancelled) return;
        if (!document.hidden) load();
        schedule();
      }, live ? POLL_INTERVAL_MS : OFF_HOURS_POLL_INTERVAL_MS);
    }
    load();
    schedule();
    const onVisible = () => { if (!document.hidden && !cancelled) load(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      inFlight?.abort();
      if (timer) clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // chartLegs is covered by legsKey (selectionKey); keep deps on the stable key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, underlying, expiry, legsKey, interval_, showSpot, selectionKey]);

  const btn = (active: boolean) =>
    `h-7 px-2.5 text-[11px] font-bold rounded-lg border ${FOCUS_RING} ${
      active
        ? 'border-emerald-500/50 bg-emerald-500/15 text-emerald-300'
        : 'border-zinc-700 text-zinc-300 hover:bg-zinc-800'
    }`;

  return (
    <FocusModal isOpen={isOpen} onClose={onClose} title={`${title} — Strategy chart`} variant="center" wide>
      <div className="flex flex-col gap-3 p-1">
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="text-zinc-500">Interval</span>
          {INTERVALS.map((i) => (
            <button key={i} type="button" onClick={() => setInterval_(i)} className={btn(interval_ === i)}>
              {i}m
            </button>
          ))}
          <span className="mx-1 text-zinc-700">|</span>
          {(['line', 'candlestick'] as const).map((t) => (
            <button key={t} type="button" onClick={() => setChartType(t)} className={btn(chartType === t)}>
              {t === 'line' ? 'Line' : 'Candles'}
            </button>
          ))}
          <button type="button" onClick={() => setShowSpot((v) => !v)} className={btn(showSpot)}>
            Spot
          </button>
          <span className="ml-auto text-zinc-500">
            {chartLegs.length} leg{chartLegs.length === 1 ? '' : 's'} · expiry {expiry} · built from current positions
          </span>
        </div>

        {chartLegs.length === 0 ? (
          <div className="py-16 text-center text-xs text-zinc-500">No live legs to plot.</div>
        ) : error && (!chart || String(chart.interval) !== interval_) ? (
          <div className="py-10 text-center text-xs text-red-400">{error}</div>
        ) : !chart || String(chart.interval) !== interval_ ? (
          <div className="py-16 flex justify-center"><Spinner /></div>
        ) : (
          <div className="relative">
            {loading && (
              <div className="absolute right-2 top-2 z-10 flex items-center gap-1 text-[10px] text-zinc-400">
                <Spinner /> updating
              </div>
            )}
            {error && (
              <div className="mb-2 rounded-md border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] text-red-300">
                Refresh failed — chart may be stale
                {lastOkAt ? ` (last update ${new Date(lastOkAt).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST)` : ''}: {error}
              </div>
            )}
            <div className="h-[calc(100vh-18rem)] min-h-[320px]">
            <StrategyChart
              key={`${underlying}-${expiry}-${chartLegs.map((l) => `${l.action}${l.option_type}${l.strike}`).join(',')}-${interval_}`}
              chart={chart}
              chartType={chartType}
              showSpot={showSpot}
              underlying={underlying}
            />
            </div>
            {chart.coverage_note && <p className="mt-2 text-[10px] text-zinc-500">{chart.coverage_note}</p>}
          </div>
        )}
      </div>
    </FocusModal>
  );
}
