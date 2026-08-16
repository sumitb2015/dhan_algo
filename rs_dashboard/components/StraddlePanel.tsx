'use client';

import { useEffect, useMemo, useState } from 'react';
import { optionsChartApi } from '@/lib/optionsChartApi';
import { StraddleChart, type StraddleChartType } from '@/components/StraddleChart';
import { ChartIndicatorPicker } from '@/components/ChartIndicatorPicker';
import { isUnderlyingLive } from '@/lib/marketHours';
import { CHART_UNDERLYINGS, spotLabel, type ChartUnderlying } from '@/lib/underlyings';
import { Spinner } from '@/components/Spinner';
import { DayChangeChip } from '@/components/DayChangeChip';
import { PanelStyles } from '@/components/PanelStyles';
import {
  DEFAULT_INDICATORS,
  VALID_INTERVALS,
  type ChartIndicatorRequest,
  type StraddleChartResponse,
  type StraddleStrikesResponse,
} from '@/lib/optionsChartTypes';

const CHART_TYPES: { id: StraddleChartType; label: string }[] = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'line', label: 'Line' },
];
const POLL_INTERVAL_MS = 10_000;
const OFF_HOURS_POLL_INTERVAL_MS = 60_000;

export function StraddlePanel({
  underlying,
  onUnderlyingChange,
}: {
  underlying: ChartUnderlying;
  onUnderlyingChange: (u: ChartUnderlying) => void;
}) {
  const [interval_, setInterval_] = useState('1');
  const [expiry, setExpiry] = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [strikesData, setStrikesData] = useState<StraddleStrikesResponse | null>(null);
  const [strike, setStrike] = useState<number | null>(null);
  const [indicators, setIndicators] = useState<ChartIndicatorRequest[]>(DEFAULT_INDICATORS);
  const [chartType, setChartType] = useState<StraddleChartType>('candlestick');
  const [showSpot, setShowSpot] = useState(false);
  const [marketLive, setMarketLive] = useState(false);
  const [chart, setChart] = useState<StraddleChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const update = () => setMarketLive(isUnderlyingLive(underlying, new Date()));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [underlying]);

  useEffect(() => {
    optionsChartApi.expiries(underlying).then((r) => setExpiries(r.expiries)).catch(() => {});
  }, [underlying]);

  // Derived, not synced via setState-in-effect: falls back to the first fetched expiry until
  // the user picks one explicitly.
  const effectiveExpiry = expiry || expiries[0] || '';

  useEffect(() => {
    if (!effectiveExpiry) return;
    let cancelled = false;
    function load() {
      optionsChartApi.strikes(underlying, effectiveExpiry).then((r) => {
        if (!cancelled) setStrikesData(r);
      }).catch(() => {});
    }
    load();
    const id = setInterval(load, 30_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [underlying, effectiveExpiry]);

  const atmStrike = useMemo(
    () => strikesData?.strikes.find((s) => s.is_atm)?.strike ?? null,
    [strikesData],
  );

  // Falls back to ATM whenever the user hasn't picked a strike, or their prior pick fell off
  // the chain after an expiry swap - derived each render instead of synced via an effect.
  const effectiveStrike = useMemo(() => {
    if (
      strike !== null &&
      (!strikesData || strikesData.strikes.some((s) => s.strike === strike))
    )
      return strike;
    return atmStrike;
  }, [strike, strikesData, atmStrike]);

  useEffect(() => {
    if (!effectiveExpiry || effectiveStrike === null) return;
    let cancelled = false;
    function load() {
      setLoading(true);
      optionsChartApi
        .straddle({
          underlying,
          expiry: effectiveExpiry,
          strike: effectiveStrike as number,
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
          if (!cancelled)
            setError(e instanceof Error ? e.message : 'Failed to load straddle chart.');
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
  }, [underlying, effectiveExpiry, effectiveStrike, interval_, indicators, marketLive, showSpot]);

  const todaysCandles = useMemo(() => {
    const all = chart?.candles ?? [];
    if (all.length === 0) return [];
    const lastDate = all[all.length - 1].time.slice(0, 10);
    return all.filter((c) => c.time.slice(0, 10) === lastDate);
  }, [chart]);

  const spotVal = (chart?.spot ?? strikesData?.spot ?? 0).toFixed(2);

  return (
    <div className="lc-panel">
      {/* ── Controls toolbar ────────────────────────────────────────── */}
      <div className="lc-toolbar">
        {/* Group 1: Symbol */}
        <div className="lc-toolbar-group">
          <span className="lc-group-label">SYMBOL</span>
          <div className="lc-group-row">
            <select
              value={underlying}
              onChange={(e) => onUnderlyingChange(e.target.value as ChartUnderlying)}
              className="lc-select lc-select--accent"
            >
              {CHART_UNDERLYINGS.map((u) => (
                <option key={u} value={u}>
                  {u}
                </option>
              ))}
            </select>
            <select
              value={effectiveExpiry}
              onChange={(e) => setExpiry(e.target.value)}
              className="lc-select"
            >
              {expiries.map((e) => (
                <option key={e} value={e}>
                  {e}
                </option>
              ))}
            </select>
            <select
              value={effectiveStrike ?? ''}
              onChange={(e) => setStrike(Number(e.target.value))}
              className="lc-select lc-select--mono"
            >
              {(strikesData?.strikes ?? []).map((s) => (
                <option key={s.strike} value={s.strike}>
                  {s.strike}
                  {s.is_atm ? ' ◉' : ''}
                </option>
              ))}
            </select>
            <select
              value={interval_}
              onChange={(e) => setInterval_(e.target.value)}
              className="lc-select lc-select--narrow"
            >
              {VALID_INTERVALS.map((i) => (
                <option key={i} value={i}>
                  {i}m
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="lc-toolbar-sep" />

        {/* Group 2: Indicators */}
        <div className="lc-toolbar-group">
          <span className="lc-group-label">INDICATORS</span>
          <div className="lc-group-row">
            <ChartIndicatorPicker indicators={indicators} onChange={setIndicators} />
          </div>
        </div>

        <div className="lc-toolbar-sep" />

        {/* Group 3: Chart type */}
        <div className="lc-toolbar-group">
          <span className="lc-group-label">VIEW</span>
          <div className="lc-group-row">
            {CHART_TYPES.map((t) => (
              <button
                key={t.id}
                type="button"
                onClick={() => setChartType(t.id)}
                className={`lc-view-btn${chartType === t.id ? ' lc-view-btn--active' : ''}`}
              >
                {t.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setShowSpot((v) => !v)}
              title={`Overlay ${underlying} ${spotLabel(underlying).toLowerCase()} as a dashed line on its own left-hand axis`}
              className={`lc-view-btn${showSpot ? ' lc-view-btn--active' : ''}`}
            >
              {spotLabel(underlying)}
            </button>
          </div>
        </div>

        {/* Stats pushed right */}
        <div className="lc-toolbar-stats">
          {todaysCandles.length > 0 && <DayChangeChip candles={todaysCandles} />}
          <div className="lc-spot-card">
            <span className="lc-stat-label">SPOT</span>
            <span className="lc-spot-value">{spotVal}</span>
          </div>
          <div className="lc-status-pill">
            {loading ? (
              <Spinner size={10} />
            ) : (
              <span
                className={`lc-status-dot ${marketLive ? 'lc-status-dot--live' : 'lc-status-dot--closed'}`}
              />
            )}
            <span className={marketLive ? 'lc-status-live' : 'lc-status-closed'}>
              {marketLive ? 'LIVE' : 'CLOSED'}
            </span>
          </div>
        </div>
      </div>

      {error && (
        <div className="lc-error">
          <span>⚠</span> {error}
        </div>
      )}

      {chart ? (
        <div className="lc-chart-wrap">
          {/* Keyed by the selection identity (not chartType/showSpot) so CombinedPremiumChart's
              fit-once-per-mount guard re-fits the price scale when you pick a genuinely
              different expiry/strike, while an ordinary 10s poll (same key) keeps the same
              mounted instance and preserves your zoom/pan. */}
          <StraddleChart
            key={`${underlying}-${effectiveExpiry}-${effectiveStrike}-${interval_}`}
            underlying={underlying}
            chart={chart}
            chartType={chartType}
            showSpot={showSpot}
          />
        </div>
      ) : (
        loading &&
        !error && (
          <div className="lc-chart-loading">
            <Spinner size={20} />
            <span>Loading straddle chart…</span>
          </div>
        )
      )}

      <PanelStyles />
    </div>
  );
}
