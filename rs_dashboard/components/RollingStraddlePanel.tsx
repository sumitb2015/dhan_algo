'use client';

import { useEffect, useRef, useState } from 'react';
import { isAbortError, optionsChartApi } from '@/lib/optionsChartApi';
import { RollingStraddleChart, type RollingStraddleChartType } from '@/components/RollingStraddleChart';
import { ChartIndicatorPicker } from '@/components/ChartIndicatorPicker';
import { isUnderlyingLive } from '@/lib/marketHours';
import { CHART_UNDERLYINGS, spotLabel, type ChartUnderlying } from '@/lib/underlyings';
import { Spinner } from '@/components/Spinner';
import {
  DEFAULT_INDICATORS,
  OFF_HOURS_POLL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  VALID_INTERVALS,
  type ChartIndicatorRequest,
  type RollingStraddleChartResponse,
} from '@/lib/optionsChartTypes';

const CHART_TYPES: { id: RollingStraddleChartType; label: string }[] = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'line', label: 'Line' },
];

export function RollingStraddlePanel({
  underlying,
  onUnderlyingChange,
}: {
  underlying: ChartUnderlying;
  onUnderlyingChange: (u: ChartUnderlying) => void;
}) {
  const [interval_, setInterval_] = useState('1');
  const [expiry, setExpiry] = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [indicators, setIndicators] = useState<ChartIndicatorRequest[]>(DEFAULT_INDICATORS);
  const [chartType, setChartType] = useState<RollingStraddleChartType>('candlestick');
  const [showSpot, setShowSpot] = useState(true);
  const [marketLive, setMarketLive] = useState(false);
  const [chart, setChart] = useState<RollingStraddleChartResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadedKey, setLoadedKey] = useState('');

  useEffect(() => {
    const update = () => setMarketLive(isUnderlyingLive(underlying, new Date()));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, [underlying]);

  useEffect(() => {
    optionsChartApi.expiries(underlying).then((r) => setExpiries(r.expiries)).catch(() => {});
  }, [underlying]);

  const effectiveExpiry = expiry || expiries[0] || '';

  // Identity of the contract on screen. `loading` is derived from it rather than toggled in
  // the poll loop, so the status pill only spins until the first response for a NEW selection
  // lands - a background refresh of the same selection never touches it. marketLive is
  // deliberately absent: it changes the poll cadence, not the payload.
  const selectionKey = `${underlying}|${effectiveExpiry}|${interval_}|${JSON.stringify(indicators)}`;
  const loading = loadedKey !== selectionKey;

  // See StraddlePanel: monotonic request id + abort, so a slow spawn can never land on top of a
  // fresher response.
  const seqRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!effectiveExpiry) return;
    let cancelled = false;
    function load() {
      inFlightRef.current?.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;
      const seq = ++seqRef.current;

      optionsChartApi
        .rollingStraddle(
          { underlying, expiry: effectiveExpiry, interval: interval_, indicators },
          controller.signal,
        )
        .then((r) => {
          if (cancelled || seq !== seqRef.current) return;
          setChart(r);
          setError(null);
          setLoadedKey(selectionKey);
        })
        .catch((e) => {
          if (cancelled || isAbortError(e) || seq !== seqRef.current) return;
          setError(e instanceof Error ? e.message : 'Failed to load rolling straddle chart.');
          // Resolved (badly) - stop the pill spinning; the error block explains what happened.
          setLoadedKey(selectionKey);
        });
    }
    load();
    const id = setInterval(load, marketLive ? POLL_INTERVAL_MS : OFF_HOURS_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      inFlightRef.current?.abort();
      clearInterval(id);
    };
  }, [underlying, effectiveExpiry, interval_, indicators, marketLive, selectionKey]);

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

        {/* Status pushed right */}
        <div className="lc-toolbar-stats">
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
          {/* Keyed by selection identity - see StraddlePanel's StraddleChart for why. */}
          <RollingStraddleChart
            key={`${underlying}-${effectiveExpiry}-${interval_}`}
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
            <span>Loading rolling straddle chart…</span>
          </div>
        )
      )}
    </div>
  );
}
