'use client';

import { useEffect, useMemo, useState } from 'react';
import { optionsChartApi } from '@/lib/optionsChartApi';
import { StrangleChart, type StrangleChartType } from '@/components/StrangleChart';
import { ChartIndicatorPicker } from '@/components/ChartIndicatorPicker';
import { isNseLive } from '@/lib/marketHours';
import { Spinner } from '@/components/Spinner';
import { DEFAULT_INDICATORS, VALID_INTERVALS, type ChartIndicatorRequest, type StrangleChartResponse, type StraddleStrikesResponse } from '@/lib/optionsChartTypes';

const CHART_TYPES: { id: StrangleChartType; label: string }[] = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'line', label: 'Line' },
];
const POLL_INTERVAL_MS = 10_000;
const OFF_HOURS_POLL_INTERVAL_MS = 60_000;

const selectClass = 'px-1.5 py-1 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-200';
const numberClass = 'w-14 px-1.5 py-1 text-xs rounded tabular-nums border border-zinc-700 bg-zinc-900 text-zinc-200';

export function StranglePanel() {
  const [interval_, setInterval_] = useState('1');
  const [expiry, setExpiry] = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [strikesData, setStrikesData] = useState<StraddleStrikesResponse | null>(null);
  const [ceStrike, setCeStrike] = useState<number | null>(null);
  const [peStrike, setPeStrike] = useState<number | null>(null);
  const [ceLots, setCeLots] = useState(1);
  const [peLots, setPeLots] = useState(1);
  const [indicators, setIndicators] = useState<ChartIndicatorRequest[]>(DEFAULT_INDICATORS);
  const [chartType, setChartType] = useState<StrangleChartType>('line');
  const [showSpot, setShowSpot] = useState(false);
  const [marketLive, setMarketLive] = useState(false);
  const [chart, setChart] = useState<StrangleChartResponse | null>(null);
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
  const step = useMemo(() => {
    const values = (strikesData?.strikes ?? []).map((s) => s.strike).sort((a, b) => a - b);
    const diffs = values.slice(1).map((v, i) => v - values[i]).filter((d) => d > 0);
    return diffs.length ? Math.min(...diffs) : 50;
  }, [strikesData]);

  // Derived defaults (2 strikes OTM either side of ATM) rather than synced via setState-in-effect
  // - only used until the user picks a strike explicitly.
  const effectiveCeStrike = ceStrike ?? (atmStrike !== null ? atmStrike + step * 2 : null);
  const effectivePeStrike = peStrike ?? (atmStrike !== null ? atmStrike - step * 2 : null);

  useEffect(() => {
    if (!effectiveExpiry || effectiveCeStrike === null || effectivePeStrike === null) return;
    let cancelled = false;
    function load() {
      setLoading(true);
      optionsChartApi
        .strangle({
          expiry: effectiveExpiry,
          ceStrike: effectiveCeStrike as number,
          peStrike: effectivePeStrike as number,
          ceLots,
          peLots,
          interval: interval_,
          indicators,
          includeSpot: showSpot,
        })
        .then((r) => {
          if (!cancelled) {
            setChart(r);
            setError(null);
          }
        })
        .catch((e) => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load strangle chart.');
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
  }, [effectiveExpiry, effectiveCeStrike, effectivePeStrike, ceLots, peLots, interval_, indicators, marketLive, showSpot]);

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

          <label className="flex items-center gap-1 text-xs text-zinc-400">
            CE
            <select value={effectiveCeStrike ?? ''} onChange={(e) => setCeStrike(Number(e.target.value))} className={`${selectClass} tabular-nums`}>
              {(strikesData?.strikes ?? []).map((s) => (
                <option key={s.strike} value={s.strike}>
                  {s.strike}
                </option>
              ))}
            </select>
            <input type="number" min={1} max={10} value={ceLots} onChange={(e) => setCeLots(Number(e.target.value))} className={numberClass} title="CE lots" />
          </label>

          <label className="flex items-center gap-1 text-xs text-zinc-400">
            PE
            <select value={effectivePeStrike ?? ''} onChange={(e) => setPeStrike(Number(e.target.value))} className={`${selectClass} tabular-nums`}>
              {(strikesData?.strikes ?? []).map((s) => (
                <option key={s.strike} value={s.strike}>
                  {s.strike}
                </option>
              ))}
            </select>
            <input type="number" min={1} max={10} value={peLots} onChange={(e) => setPeLots(Number(e.target.value))} className={numberClass} title="PE lots" />
          </label>

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
          <StrangleChart chart={chart} chartType={chartType} showSpot={showSpot} />
        </div>
      ) : (
        loading &&
        !error && (
          <div className="bg-zinc-800 rounded-lg p-2 flex-1 min-h-0 flex items-center justify-center gap-2 text-zinc-500 text-sm">
            <Spinner size={18} />
            Loading strangle chart…
          </div>
        )
      )}
    </div>
  );
}
