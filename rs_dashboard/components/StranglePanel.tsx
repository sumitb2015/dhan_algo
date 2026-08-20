'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { isAbortError, optionsChartApi } from '@/lib/optionsChartApi';
import { StrangleChart, type StrangleChartType } from '@/components/StrangleChart';
import { ChartIndicatorPicker } from '@/components/ChartIndicatorPicker';
import { isUnderlyingLive } from '@/lib/marketHours';
import { CHART_UNDERLYINGS, spotLabel, type ChartUnderlying } from '@/lib/underlyings';
import { Spinner } from '@/components/Spinner';
import { DayChangeChip } from '@/components/DayChangeChip';
import { sameStrikeChain } from '@/lib/optionsChartTypes';
import {
  DEFAULT_INDICATORS,
  OFF_HOURS_POLL_INTERVAL_MS,
  POLL_INTERVAL_MS,
  VALID_INTERVALS,
  type ChartIndicatorRequest,
  type StrangleChartResponse,
  type StraddleStrikesResponse,
} from '@/lib/optionsChartTypes';

const CHART_TYPES: { id: StrangleChartType; label: string }[] = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'line', label: 'Line' },
];

export function StranglePanel({
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
  const [chainSpot, setChainSpot] = useState<number | null>(null);
  const [ceStrike, setCeStrike] = useState<number | null>(null);
  const [peStrike, setPeStrike] = useState<number | null>(null);
  const [ceLots, setCeLots] = useState(1);
  const [peLots, setPeLots] = useState(1);
  const [indicators, setIndicators] = useState<ChartIndicatorRequest[]>(DEFAULT_INDICATORS);
  const [chartType, setChartType] = useState<StrangleChartType>('candlestick');
  const [showSpot, setShowSpot] = useState(false);
  const [marketLive, setMarketLive] = useState(false);
  const [chart, setChart] = useState<StrangleChartResponse | null>(null);
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

  useEffect(() => {
    if (!effectiveExpiry) return;
    let cancelled = false;
    function load() {
      optionsChartApi.strikes(underlying, effectiveExpiry).then((r) => {
        if (cancelled) return;
        setChainSpot(r.spot);
        // Only `spot` moves on most refreshes - see sameStrikeChain().
        setStrikesData((prev) => (sameStrikeChain(prev, r) ? prev : r));
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
  const step = useMemo(() => {
    const values = (strikesData?.strikes ?? []).map((s) => s.strike).sort((a, b) => a - b);
    const diffs = values.slice(1).map((v, i) => v - values[i]).filter((d) => d > 0);
    return diffs.length ? Math.min(...diffs) : 50;
  }, [strikesData]);

  // Derived defaults (2 strikes OTM either side of ATM) rather than synced via setState-in-effect
  // - only used until the user picks a strike explicitly.
  const effectiveCeStrike = ceStrike ?? (atmStrike !== null ? atmStrike + step * 2 : null);
  const effectivePeStrike = peStrike ?? (atmStrike !== null ? atmStrike - step * 2 : null);

  // Identity of the contract on screen. `loading` is derived from it rather than toggled in
  // the poll loop, so the status pill only spins until the first response for a NEW selection
  // lands - a background refresh of the same selection never touches it. marketLive is
  // deliberately absent: it changes the poll cadence, not the payload.
  const selectionKey = `${underlying}|${effectiveExpiry}|${effectiveCeStrike}|${effectivePeStrike}|${ceLots}|${peLots}|${interval_}|${showSpot}|${JSON.stringify(indicators)}`;
  const loading = loadedKey !== selectionKey;

  // See StraddlePanel: monotonic request id + abort, so a slow spawn can never land on top of a
  // fresher response.
  const seqRef = useRef(0);
  const inFlightRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!effectiveExpiry || effectiveCeStrike === null || effectivePeStrike === null) return;
    let cancelled = false;
    function load() {
      inFlightRef.current?.abort();
      const controller = new AbortController();
      inFlightRef.current = controller;
      const seq = ++seqRef.current;

      optionsChartApi
        .strangle(
          {
            underlying,
            expiry: effectiveExpiry,
            ceStrike: effectiveCeStrike as number,
            peStrike: effectivePeStrike as number,
            ceLots,
            peLots,
            interval: interval_,
            indicators,
            includeSpot: showSpot,
          },
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
          setError(e instanceof Error ? e.message : 'Failed to load strangle chart.');
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
  }, [underlying, effectiveExpiry, effectiveCeStrike, effectivePeStrike, ceLots, peLots, interval_, indicators, marketLive, showSpot, selectionKey]);

  const todaysCandles = useMemo(() => {
    const all = chart?.candles ?? [];
    if (all.length === 0) return [];
    const lastDate = all[all.length - 1].time.slice(0, 10);
    return all.filter((c) => c.time.slice(0, 10) === lastDate);
  }, [chart]);

  const spotVal = (chart?.spot ?? chainSpot ?? 0).toFixed(2);

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

        {/* Group 2: Strikes */}
        <div className="lc-toolbar-group">
          <span className="lc-group-label">STRIKES</span>
          <div className="lc-group-row">
            <label className="lc-strike-label">
              <span className="lc-strike-tag lc-strike-tag--ce">CE</span>
              <select
                value={effectiveCeStrike ?? ''}
                onChange={(e) => setCeStrike(Number(e.target.value))}
                className="lc-select lc-select--mono"
              >
                {(strikesData?.strikes ?? []).map((s) => (
                  <option key={s.strike} value={s.strike}>
                    {s.strike}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={10}
                value={ceLots}
                onChange={(e) => setCeLots(Number(e.target.value))}
                className="lc-input"
                title="CE lots"
              />
            </label>
            <label className="lc-strike-label">
              <span className="lc-strike-tag lc-strike-tag--pe">PE</span>
              <select
                value={effectivePeStrike ?? ''}
                onChange={(e) => setPeStrike(Number(e.target.value))}
                className="lc-select lc-select--mono"
              >
                {(strikesData?.strikes ?? []).map((s) => (
                  <option key={s.strike} value={s.strike}>
                    {s.strike}
                  </option>
                ))}
              </select>
              <input
                type="number"
                min={1}
                max={10}
                value={peLots}
                onChange={(e) => setPeLots(Number(e.target.value))}
                className="lc-input"
                title="PE lots"
              />
            </label>
          </div>
        </div>

        <div className="lc-toolbar-sep" />

        {/* Group 3: Indicators */}
        <div className="lc-toolbar-group">
          <span className="lc-group-label">INDICATORS</span>
          <div className="lc-group-row">
            <ChartIndicatorPicker indicators={indicators} onChange={setIndicators} />
          </div>
        </div>

        <div className="lc-toolbar-sep" />

        {/* Group 4: View */}
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
          {/* Keyed by selection identity - see StraddlePanel's StraddleChart for why. */}
          <StrangleChart
            key={`${underlying}-${effectiveExpiry}-${effectiveCeStrike}-${effectivePeStrike}-${ceLots}-${peLots}-${interval_}`}
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
            <span>Loading strangle chart…</span>
          </div>
        )
      )}

      <style>{`
        .lc-strike-label {
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .lc-strike-tag {
          font-size: 9px;
          font-weight: 800;
          letter-spacing: 0.06em;
          padding: 2px 5px;
          border-radius: 4px;
        }
        .lc-strike-tag--ce {
          background: rgba(52, 211, 153, 0.12);
          color: #34d399;
          border: 1px solid rgba(52, 211, 153, 0.2);
        }
        .lc-strike-tag--pe {
          background: rgba(248, 113, 113, 0.12);
          color: #f87171;
          border: 1px solid rgba(248, 113, 113, 0.2);
        }
      `}</style>
    </div>
  );
}
