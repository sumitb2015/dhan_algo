'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { optionsChartApi } from '@/lib/optionsChartApi';
import { StrategyChart, type StrategyChartType } from '@/components/StrategyChart';
import { ChartIndicatorPicker } from '@/components/ChartIndicatorPicker';
import { isUnderlyingLive } from '@/lib/marketHours';
import { CHART_UNDERLYINGS, spotLabel, type ChartUnderlying } from '@/lib/underlyings';
import { Spinner } from '@/components/Spinner';
import { DayChangeChip } from '@/components/DayChangeChip';
import { PanelStyles } from '@/components/PanelStyles';
import {
  STRATEGY_CATEGORIES,
  STRATEGY_PRESETS,
  resolvePresetLegs,
  type StrategyCategory,
} from '@/lib/strategyPresets';
import {
  DEFAULT_INDICATORS,
  VALID_INTERVALS,
  type ChartIndicatorRequest,
  type CustomStrategyChartResponse,
  type StraddleStrikesResponse,
  type StrategyLeg,
} from '@/lib/optionsChartTypes';

const CHART_TYPES: { id: StrategyChartType; label: string }[] = [
  { id: 'candlestick', label: 'Candles' },
  { id: 'line', label: 'Line' },
];
const MIN_LOTS = 1;
const MAX_LOTS = 10;
const MAX_LEGS = 6;
const POLL_INTERVAL_MS = 10_000;
const OFF_HOURS_POLL_INTERVAL_MS = 60_000;

function clampLots(value: number): number {
  if (Number.isNaN(value)) return 1;
  return Math.min(MAX_LOTS, Math.max(MIN_LOTS, Math.round(value)));
}

function nearestStrike(strike: number, available: number[]): number {
  return available.reduce(
    (best, s) => (Math.abs(s - strike) < Math.abs(best - strike) ? s : best),
    available[0],
  );
}

export function StrategyPanel({
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
  const [category, setCategory] = useState<StrategyCategory>('neutral');
  const [presetId, setPresetId] = useState('straddle');
  const [legs, setLegs] = useState<StrategyLeg[]>([]);
  const [indicators, setIndicators] = useState<ChartIndicatorRequest[]>(DEFAULT_INDICATORS);
  const [chartType, setChartType] = useState<StrategyChartType>('candlestick');
  const [showSpot, setShowSpot] = useState(false);
  const [marketLive, setMarketLive] = useState(false);
  const [chart, setChart] = useState<CustomStrategyChartResponse | null>(null);
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

  const sortedStrikes = useMemo(
    () => (strikesData ? [...strikesData.strikes].sort((a, b) => a.strike - b.strike) : []),
    [strikesData],
  );
  const sortedStrikePrices = useMemo(() => sortedStrikes.map((s) => s.strike), [sortedStrikes]);
  const atmIndex = useMemo(() => sortedStrikes.findIndex((s) => s.is_atm), [sortedStrikes]);

  // Deferred via setTimeout(0) rather than called synchronously in the effect body - same
  // trick lib/useLiveTickerPoll.ts uses, so the first setState doesn't cascade a render during
  // the commit that made the strike chain available.
  const initializedRef = useRef(false);
  useEffect(() => {
    if (initializedRef.current || sortedStrikePrices.length === 0 || atmIndex < 0) return;
    const preset = STRATEGY_PRESETS.find((p) => p.id === presetId);
    if (!preset) return;
    const id = setTimeout(() => {
      setLegs(resolvePresetLegs(preset, sortedStrikePrices, atmIndex));
      initializedRef.current = true;
    }, 0);
    return () => clearTimeout(id);
  }, [sortedStrikePrices, atmIndex, presetId]);

  useEffect(() => {
    if (!initializedRef.current || sortedStrikePrices.length === 0) return;
    const id = setTimeout(() => {
      setLegs((prev) => {
        let changed = false;
        const next = prev.map((leg) => {
          if (sortedStrikePrices.includes(leg.strike)) return leg;
          changed = true;
          return { ...leg, strike: nearestStrike(leg.strike, sortedStrikePrices) };
        });
        return changed ? next : prev;
      });
    }, 0);
    return () => clearTimeout(id);
  }, [sortedStrikePrices]);

  function applyPreset(id: string) {
    setPresetId(id);
    const preset = STRATEGY_PRESETS.find((p) => p.id === id);
    if (!preset || sortedStrikePrices.length === 0 || atmIndex < 0) return;
    setLegs(resolvePresetLegs(preset, sortedStrikePrices, atmIndex));
  }

  function handleCategoryChange(next: StrategyCategory) {
    setCategory(next);
    const firstPreset = STRATEGY_PRESETS.find((p) => p.category === next);
    if (firstPreset) applyPreset(firstPreset.id);
  }

  function updateLeg(index: number, patch: Partial<StrategyLeg>) {
    setLegs((prev) => prev.map((leg, i) => (i === index ? { ...leg, ...patch } : leg)));
  }

  function removeLeg(index: number) {
    setLegs((prev) => (prev.length <= 1 ? prev : prev.filter((_, i) => i !== index)));
  }

  function addLeg() {
    const defaultStrike = sortedStrikePrices[atmIndex] ?? sortedStrikePrices[0];
    if (defaultStrike === undefined) return;
    setLegs((prev) =>
      prev.length >= MAX_LEGS
        ? prev
        : [...prev, { option_type: 'CE', action: 'BUY', strike: defaultStrike, lots: 1 }],
    );
  }

  useEffect(() => {
    if (!effectiveExpiry || legs.length === 0 || !legs.every((l) => Number.isFinite(l.strike)))
      return;
    let cancelled = false;
    function load() {
      setLoading(true);
      optionsChartApi
        .strategy({
          underlying,
          expiry: effectiveExpiry,
          legs,
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
            setError(e instanceof Error ? e.message : 'Failed to load strategy chart.');
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
  }, [underlying, effectiveExpiry, legs, interval_, indicators, marketLive, showSpot]);

  const todaysCandles = useMemo(() => {
    const all = chart?.candles ?? [];
    if (all.length === 0) return [];
    const lastDate = all[all.length - 1].time.slice(0, 10);
    return all.filter((c) => c.time.slice(0, 10) === lastDate);
  }, [chart]);

  const categoryPresets = STRATEGY_PRESETS.filter((p) => p.category === category);
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

        {/* Group 2: Strategy preset */}
        <div className="lc-toolbar-group">
          <span className="lc-group-label">STRATEGY</span>
          <div className="lc-group-row">
            <select
              value={category}
              onChange={(e) => handleCategoryChange(e.target.value as StrategyCategory)}
              className="lc-select"
            >
              {STRATEGY_CATEGORIES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
            <select
              value={presetId}
              onChange={(e) => applyPreset(e.target.value)}
              className="lc-select"
            >
              {categoryPresets.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
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
          {todaysCandles.length > 0 && (
            <DayChangeChip candles={todaysCandles} sellerConvention={chart?.net_credit ?? true} />
          )}
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

      {/* ── Legs row ─────────────────────────────────────────────────── */}
      <div className="lc-legs-row">
        <span className="lc-legs-label">Legs</span>
        {legs.map((leg, i) => (
          <div key={i} className="lc-group-row">
            <select
              value={leg.action}
              onChange={(e) => updateLeg(i, { action: e.target.value as StrategyLeg['action'] })}
              className="lc-select"
            >
              <option value="BUY">BUY</option>
              <option value="SELL">SELL</option>
            </select>
            <select
              value={leg.option_type}
              onChange={(e) =>
                updateLeg(i, { option_type: e.target.value as StrategyLeg['option_type'] })
              }
              className="lc-select"
            >
              <option value="CE">CE</option>
              <option value="PE">PE</option>
            </select>
            <select
              value={leg.strike}
              onChange={(e) => updateLeg(i, { strike: Number(e.target.value) })}
              className="lc-select lc-select--mono"
            >
              {sortedStrikes.map((s) => (
                <option key={s.strike} value={s.strike}>
                  {s.strike}
                  {s.is_atm ? ' ◉' : ''}
                </option>
              ))}
            </select>
            <input
              type="number"
              min={MIN_LOTS}
              max={MAX_LOTS}
              value={leg.lots}
              onChange={(e) => updateLeg(i, { lots: clampLots(Number(e.target.value)) })}
              className="lc-input"
              title="Lots"
            />
            <button
              type="button"
              onClick={() => removeLeg(i)}
              disabled={legs.length <= 1}
              className="lc-remove-btn"
              title="Remove leg"
            >
              ×
            </button>
          </div>
        ))}
        <button
          type="button"
          onClick={addLeg}
          disabled={legs.length >= MAX_LEGS}
          className="lc-add-leg-btn"
        >
          + Add leg
        </button>
      </div>

      {error && (
        <div className="lc-error">
          <span>⚠</span> {error}
        </div>
      )}

      {chart ? (
        <div className="lc-chart-wrap">
          {/* Keyed by selection identity - see StraddlePanel's StraddleChart for why. Without
              this, switching presets (e.g. Straddle -> Iron Condor -> Butterfly) reused the
              same mounted chart instance, so CombinedPremiumChart's fit-once-per-mount guard
              never re-fit the price scale to the new combo's very different value range - the
              chart looked "stuck" showing the previous strategy's scale. */}
          <StrategyChart
            key={`${underlying}-${effectiveExpiry}-${JSON.stringify(legs)}-${interval_}`}
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
            <span>Loading strategy chart…</span>
          </div>
        )
      )}
      <PanelStyles />
    </div>
  );
}
