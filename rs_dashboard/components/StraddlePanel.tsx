'use client';

import { useEffect, useMemo, useState } from 'react';
import { optionsChartApi } from '@/lib/optionsChartApi';
import { StraddleChart, type StraddleChartType } from '@/components/StraddleChart';
import { ChartIndicatorPicker } from '@/components/ChartIndicatorPicker';
import { isNseLive } from '@/lib/marketHours';
import { Spinner } from '@/components/Spinner';
import { DayChangeChip } from '@/components/DayChangeChip';
import { DEFAULT_INDICATORS, VALID_INTERVALS, type ChartIndicatorRequest, type StraddleChartResponse, type StraddleStrikesResponse } from '@/lib/optionsChartTypes';

const CHART_TYPES: { id: StraddleChartType; label: string }[] = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'line', label: 'Line' },
];
const POLL_INTERVAL_MS = 10_000;
const OFF_HOURS_POLL_INTERVAL_MS = 60_000;

const selectClass = 'px-1.5 py-1 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-200';

export function StraddlePanel() {
  const [interval_, setInterval_] = useState('1');
  const [expiry, setExpiry] = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [strikesData, setStrikesData] = useState<StraddleStrikesResponse | null>(null);
  const [strike, setStrike] = useState<number | null>(null);
  const [indicators, setIndicators] = useState<ChartIndicatorRequest[]>(DEFAULT_INDICATORS);
  const [chartType, setChartType] = useState<StraddleChartType>('line');
  const [showSpot, setShowSpot] = useState(false);
  const [marketLive, setMarketLive] = useState(false);
  const [chart, setChart] = useState<StraddleChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const update = () => setMarketLive(isNseLive(new Date()));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    optionsChartApi.expiries().then((r) => setExpiries(r.expiries)).catch(() => {});
  }, []);

  // Derived, not synced via setState-in-effect: falls back to the first fetched expiry until
  // the user picks one explicitly.
  const effectiveExpiry = expiry || expiries[0] || '';

  useEffect(() => {
    if (!effectiveExpiry) return;
    let cancelled = false;
    function load() {
      optionsChartApi.strikes('NIFTY', effectiveExpiry).then((r) => {
        if (!cancelled) setStrikesData(r);
      }).catch(() => {});
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [effectiveExpiry]);

  const atmStrike = useMemo(() => strikesData?.strikes.find((s) => s.is_atm)?.strike ?? null, [strikesData]);

  // Falls back to ATM whenever the user hasn't picked a strike, or their prior pick fell off
  // the chain after an expiry swap - derived each render instead of synced via an effect.
  const effectiveStrike = useMemo(() => {
    if (strike !== null && (!strikesData || strikesData.strikes.some((s) => s.strike === strike))) return strike;
    return atmStrike;
  }, [strike, strikesData, atmStrike]);

  useEffect(() => {
    if (!effectiveExpiry || effectiveStrike === null) return;
    let cancelled = false;
    function load() {
      setLoading(true);
      optionsChartApi
        .straddle({ expiry: effectiveExpiry, strike: effectiveStrike as number, interval: interval_, indicators, includeSpot: showSpot })
        .then((r) => {
          if (!cancelled) {
            setChart(r);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load straddle chart.');
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }
    load();
    const id = setInterval(load, marketLive ? POLL_INTERVAL_MS : OFF_HOURS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [effectiveExpiry, effectiveStrike, interval_, indicators, marketLive, showSpot]);

  const todaysCandles = useMemo(() => {
    const all = chart?.candles ?? [];
    if (all.length === 0) return [];
    const lastDate = all[all.length - 1].time.slice(0, 10);
    return all.filter((c) => c.time.slice(0, 10) === lastDate);
  }, [chart]);

  return (
    <div className="flex flex-col gap-2 h-full min-h-0">
      <div className="bg-zinc-800 rounded-lg flex-shrink-0">
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 p-2">
          <select value={effectiveExpiry} onChange={(e) => setExpiry(e.target.value)} className={selectClass}>
            {expiries.map((e) => (
              <option key={e} value={e}>
                {e}
              </option>
            ))}
          </select>

          <select value={effectiveStrike ?? ''} onChange={(e) => setStrike(Number(e.target.value))} className={`${selectClass} tabular-nums`}>
            {(strikesData?.strikes ?? []).map((s) => (
              <option key={s.strike} value={s.strike}>
                {s.strike}
                {s.is_atm ? ' (ATM)' : ''}
              </option>
            ))}
          </select>

          <select value={interval_} onChange={(e) => setInterval_(e.target.value)} className={selectClass}>
            {VALID_INTERVALS.map((i) => (
              <option key={i} value={i}>
                {i}m
              </option>
            ))}
          </select>

          <ChartIndicatorPicker indicators={indicators} onChange={setIndicators} />

          <div className="flex gap-1">
            {CHART_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setChartType(t.id)}
                className={`px-2.5 py-1 text-xs font-semibold rounded ${chartType === t.id ? 'bg-sky-600 text-white' : 'border border-zinc-700 bg-zinc-900 text-zinc-300'}`}
              >
                {t.label}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={() => setShowSpot((v) => !v)}
            title="Overlay NIFTY spot as a dashed line on its own left-hand axis"
            className={`px-2.5 py-1 text-xs font-semibold rounded ${showSpot ? 'bg-sky-600 text-white' : 'border border-zinc-700 bg-zinc-900 text-zinc-300'}`}
          >
            Spot
          </button>

          <div className="flex items-center gap-3 ml-auto text-xs text-zinc-400">
            {todaysCandles.length > 0 && <DayChangeChip candles={todaysCandles} />}
            <span className="tabular-nums">Spot {(chart?.spot ?? strikesData?.spot ?? 0).toFixed(2)}</span>
            {loading && <Spinner size={12} />}
            <span className="inline-flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${marketLive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
              {marketLive ? 'live' : 'closed'}
            </span>
          </div>
        </div>
      </div>

      {error && <div className="bg-zinc-800 rounded-lg p-3 text-sm text-red-400 flex-shrink-0">{error}</div>}

      {chart ? (
        <div className="bg-zinc-800 rounded-lg p-2 flex-1 min-h-0 flex flex-col">
          {/* Keyed by the selection identity (not chartType/showSpot) so CombinedPremiumChart's
              fit-once-per-mount guard re-fits the price scale when you pick a genuinely
              different expiry/strike, while an ordinary 10s poll (same key) keeps the same
              mounted instance and preserves your zoom/pan. */}
          <StraddleChart key={`${effectiveExpiry}-${effectiveStrike}-${interval_}`} chart={chart} chartType={chartType} showSpot={showSpot} />
        </div>
      ) : (
        loading &&
        !error && (
          <div className="bg-zinc-800 rounded-lg p-2 flex-1 min-h-0 flex items-center justify-center gap-2 text-zinc-500 text-sm">
            <Spinner size={18} />
            Loading straddle chart…
          </div>
        )
      )}
    </div>
  );
}
