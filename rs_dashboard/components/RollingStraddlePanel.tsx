'use client';

import { useEffect, useState } from 'react';
import { optionsChartApi } from '@/lib/optionsChartApi';
import { RollingStraddleChart, type RollingStraddleChartType } from '@/components/RollingStraddleChart';
import { ChartIndicatorPicker } from '@/components/ChartIndicatorPicker';
import { isNseLive } from '@/lib/marketHours';
import { Spinner } from '@/components/Spinner';
import { DEFAULT_INDICATORS, VALID_INTERVALS, type ChartIndicatorRequest, type RollingStraddleChartResponse } from '@/lib/optionsChartTypes';

const CHART_TYPES: { id: RollingStraddleChartType; label: string }[] = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'line', label: 'Line' },
];
const POLL_INTERVAL_MS = 10_000;
const OFF_HOURS_POLL_INTERVAL_MS = 60_000;

const selectClass = 'px-1.5 py-1 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-200';

export function RollingStraddlePanel() {
  const [interval_, setInterval_] = useState('1');
  const [expiry, setExpiry] = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [indicators, setIndicators] = useState<ChartIndicatorRequest[]>(DEFAULT_INDICATORS);
  const [chartType, setChartType] = useState<RollingStraddleChartType>('line');
  const [showSpot, setShowSpot] = useState(true);
  const [marketLive, setMarketLive] = useState(false);
  const [chart, setChart] = useState<RollingStraddleChartResponse | null>(null);
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

  const effectiveExpiry = expiry || expiries[0] || '';

  useEffect(() => {
    if (!effectiveExpiry) return;
    let cancelled = false;
    function load() {
      setLoading(true);
      optionsChartApi
        .rollingStraddle({ expiry: effectiveExpiry, interval: interval_, indicators })
        .then((r) => {
          if (!cancelled) {
            setChart(r);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load rolling straddle chart.');
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
  }, [effectiveExpiry, interval_, indicators, marketLive]);

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

          <span className="ml-auto inline-flex items-center gap-2 text-xs text-zinc-400">
            {loading && <Spinner size={12} />}
            <span className="inline-flex items-center gap-1.5">
              <span className={`inline-block w-1.5 h-1.5 rounded-full ${marketLive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
              {marketLive ? 'live' : 'closed'}
            </span>
          </span>
        </div>
      </div>

      {error && <div className="bg-zinc-800 rounded-lg p-3 text-sm text-red-400 flex-shrink-0">{error}</div>}

      {chart ? (
        <div className="bg-zinc-800 rounded-lg p-2 flex-1 min-h-0 flex flex-col">
          <RollingStraddleChart chart={chart} chartType={chartType} showSpot={showSpot} />
        </div>
      ) : (
        loading &&
        !error && (
          <div className="bg-zinc-800 rounded-lg p-2 flex-1 min-h-0 flex items-center justify-center gap-2 text-zinc-500 text-sm">
            <Spinner size={18} />
            Loading rolling straddle chart…
          </div>
        )
      )}
    </div>
  );
}
