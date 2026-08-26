'use client';

import React, { useEffect, useRef, useState } from 'react';
import NavBar from './NavBar';
import SymbolPicker, { type SymbolSelection } from './SymbolPicker';
import LevelChart, { type OverlayVisibility, type LevelsMode } from './LevelChart';
import LevelScoreCard from './LevelScoreCard';
import type { LevelCandle, LevelBucket, LevelChartIndicators, PrevDayLevels, LevelConfluenceAnalysis } from '@/app/api/level-chart/route';

const OVERLAY_TOGGLES: { key: keyof OverlayVisibility; label: string }[] = [
  { key: 'vwap', label: 'VWAP' },
  { key: 'supertrend', label: 'ST' },
  { key: 'ema', label: 'EMA' },
  { key: 'pdc', label: 'PDC' },
];

const INTERVALS: { minutes: number; label: string }[] = [
  { minutes: 1, label: '1m' },
  { minutes: 5, label: '5m' },
  { minutes: 15, label: '15m' },
  { minutes: 30, label: '30m' },
  { minutes: 60, label: '1h' },
];

const LEVELS_MODES: { key: LevelsMode; label: string }[] = [
  { key: 'actual', label: 'Actual' },
  { key: 'forecast', label: 'Forecast' },
];

const POLL_OPTIONS: { ms: number; label: string }[] = [
  { ms: 5_000, label: '5s' },
  { ms: 15_000, label: '15s' },
  { ms: 30_000, label: '30s' },
  { ms: 60_000, label: '60s' },
];
const DEFAULT_POLL_MS = 5_000;

interface IndicatorSettings { emaFast: number; emaSlow: number; stLength: number; stMultiplier: number }
const DEFAULT_INDICATOR_SETTINGS: IndicatorSettings = { emaFast: 20, emaSlow: 50, stLength: 10, stMultiplier: 3 };
const EMA_PERIOD_BOUNDS: [number, number] = [2, 200];
const ST_LENGTH_BOUNDS: [number, number] = [2, 50];
const ST_MULTIPLIER_BOUNDS: [number, number] = [0.5, 10];

function clamp(value: number, [lo, hi]: [number, number]): number {
  if (Number.isNaN(value)) return lo;
  return Math.min(hi, Math.max(lo, value));
}

function IndicatorSettingsPopover({ settings, onChange }: { settings: IndicatorSettings; onChange: (next: IndicatorSettings) => void }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(settings);
  const boxRef = useRef<HTMLDivElement>(null);

  useEffect(() => setDraft(settings), [settings]);

  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  const commit = () => {
    onChange({
      emaFast: clamp(draft.emaFast, EMA_PERIOD_BOUNDS),
      emaSlow: clamp(draft.emaSlow, EMA_PERIOD_BOUNDS),
      stLength: clamp(draft.stLength, ST_LENGTH_BOUNDS),
      stMultiplier: clamp(draft.stMultiplier, ST_MULTIPLIER_BOUNDS),
    });
  };

  const field = (label: string, key: keyof IndicatorSettings, step = 1) => (
    <label className="flex items-center justify-between gap-2 text-xs">
      <span className="text-zinc-400">{label}</span>
      <input
        type="number"
        step={step}
        value={draft[key]}
        onChange={(e) => setDraft((d) => ({ ...d, [key]: Number(e.target.value) }))}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') { commit(); (e.target as HTMLInputElement).blur(); } }}
        className="w-16 bg-zinc-950 border border-zinc-700 rounded px-1.5 py-1 text-right font-mono tabular-nums text-zinc-100 focus:outline-none focus:border-sky-500"
      />
    </label>
  );

  return (
    <div className="relative" ref={boxRef}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title="Indicator settings"
        className={`w-7 h-7 flex items-center justify-center rounded-lg border text-xs ${
          open ? 'border-sky-500 text-sky-300 bg-sky-500/10' : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200'
        }`}
      >
        ⚙
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1.5 z-20 w-48 rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl flex flex-col gap-2">
          <p className="text-[9px] font-bold uppercase tracking-widest text-zinc-500">Indicator Settings</p>
          {field('EMA Fast', 'emaFast')}
          {field('EMA Slow', 'emaSlow')}
          {field('ST Length', 'stLength')}
          {field('ST Multiplier', 'stMultiplier', 0.5)}
        </div>
      )}
    </div>
  );
}

interface ApiResponse {
  success: boolean;
  dataDate?: string;
  candles?: LevelCandle[];
  levelBuckets?: LevelBucket[];
  indicators?: LevelChartIndicators;
  prevDayLevels?: PrevDayLevels | null;
  confluence?: LevelConfluenceAnalysis;
  error?: string;
}

function todayIso(): string {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
}

export default function LevelChartPage() {
  const [selection, setSelection] = useState<SymbolSelection>({ symbolType: 'index', symbol: 'NIFTY' });
  const [chartInterval, setChartInterval] = useState(5);
  const [levelInterval, setLevelInterval] = useState(15);
  const [candles, setCandles] = useState<LevelCandle[]>([]);
  const [levelBuckets, setLevelBuckets] = useState<LevelBucket[]>([]);
  const [indicators, setIndicators] = useState<LevelChartIndicators | undefined>(undefined);
  const [prevDayLevels, setPrevDayLevels] = useState<PrevDayLevels | null>(null);
  const [confluence, setConfluence] = useState<LevelConfluenceAnalysis | null>(null);
  const [dataDate, setDataDate] = useState<string | undefined>(undefined);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [visibleOverlays, setVisibleOverlays] = useState<OverlayVisibility>({ vwap: true, supertrend: true, ema: true, pdc: true });
  const [levelsMode, setLevelsMode] = useState<LevelsMode>('actual');
  const [pollMs, setPollMs] = useState(DEFAULT_POLL_MS);
  const [indicatorSettings, setIndicatorSettings] = useState<IndicatorSettings>(DEFAULT_INDICATOR_SETTINGS);

  // The chart body fills exactly what's left below the (variable-height, can wrap to 2 lines
  // on a narrow window) header + error banner — measured rather than guessed, since a fixed
  // `calc(100vh - Npx)` would either clip or leave a gap the moment the header wraps.
  const topRef = useRef<HTMLDivElement>(null);
  const [topHeight, setTopHeight] = useState(76);
  useEffect(() => {
    const el = topRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => setTopHeight(entry.contentRect.height));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // level-interval must be >= chart-interval — bump it up automatically instead of allowing an
  // invalid combination through to the API.
  useEffect(() => {
    if (levelInterval < chartInterval) setLevelInterval(chartInterval);
  }, [chartInterval, levelInterval]);

  const selectionKey = `${selection.symbolType}:${selection.symbol}:${chartInterval}:${levelInterval}:` +
    `${indicatorSettings.emaFast}:${indicatorSettings.emaSlow}:${indicatorSettings.stLength}:${indicatorSettings.stMultiplier}`;
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const load = () => {
      const params = new URLSearchParams({
        symbolType: selection.symbolType,
        symbol: selection.symbol,
        chartInterval: String(chartInterval),
        levelInterval: String(levelInterval),
        emaFast: String(indicatorSettings.emaFast),
        emaSlow: String(indicatorSettings.emaSlow),
        stLength: String(indicatorSettings.stLength),
        stMultiplier: String(indicatorSettings.stMultiplier),
      });
      fetch(`/api/level-chart?${params}`)
        .then((r) => r.json())
        .then((j: ApiResponse) => {
          if (cancelled) return;
          if (!j.success) {
            setError(j.error ?? 'Failed to load chart data');
            return;
          }
          setError('');
          setCandles(j.candles ?? []);
          setLevelBuckets(j.levelBuckets ?? []);
          setIndicators(j.indicators);
          setPrevDayLevels(j.prevDayLevels ?? null);
          setConfluence(j.confluence ?? null);
          setDataDate(j.dataDate);
        })
        .catch((e) => { if (!cancelled) setError(String(e)); })
        .finally(() => { if (!cancelled) setLoading(false); });
    };

    load();
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(load, pollMs);

    return () => {
      cancelled = true;
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectionKey, pollMs]);

  return (
    <div className="flex flex-col h-screen bg-zinc-950 text-white overflow-hidden">
      <div ref={topRef} className="sticky top-0 z-10">
      <div className="flex items-center gap-3 flex-wrap px-6 py-2.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-2 shrink-0">
          <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-indigo-500/10 border border-indigo-500/25 shrink-0">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" className="text-indigo-400">
              <path d="M4 20V4M4 20h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M8 14h6M8 9h9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
            </svg>
          </div>
          <h1 className="text-sm font-bold text-white tracking-tight leading-none whitespace-nowrap">Level Chart</h1>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        <NavBar />
      </div>
      <div className="flex items-center gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
          <span className="rounded-md bg-zinc-900 border border-zinc-800 px-2 py-1 font-mono text-[10px] font-bold text-zinc-400 tabular-nums">
            DATA: {dataDate ?? todayIso()}
          </span>

          <SymbolPicker value={selection} onChange={setSelection} />

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Chart</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {INTERVALS.map((iv) => (
                <button
                  key={iv.minutes}
                  type="button"
                  onClick={() => setChartInterval(iv.minutes)}
                  className={`px-2 py-1.5 text-xs font-mono font-semibold ${
                    chartInterval === iv.minutes ? 'bg-indigo-500/20 text-indigo-300' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {iv.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Levels</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {INTERVALS.filter((iv) => iv.minutes >= chartInterval).map((iv) => (
                <button
                  key={iv.minutes}
                  type="button"
                  onClick={() => setLevelInterval(iv.minutes)}
                  className={`px-2 py-1.5 text-xs font-mono font-semibold ${
                    levelInterval === iv.minutes ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {iv.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Levels Mode</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {LEVELS_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setLevelsMode(m.key)}
                  title={m.key === 'forecast' ? "Project the previous bucket's High/50%/Low forward onto the current period" : "Each bucket shows its own High/50%/Low"}
                  className={`px-2 py-1.5 text-xs font-mono font-semibold ${
                    levelsMode === m.key ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Overlays</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {OVERLAY_TOGGLES.map((o) => (
                <button
                  key={o.key}
                  type="button"
                  onClick={() => setVisibleOverlays((prev) => ({ ...prev, [o.key]: !prev[o.key] }))}
                  className={`px-2 py-1.5 text-xs font-mono font-semibold ${
                    visibleOverlays[o.key] ? 'bg-sky-500/20 text-sky-300' : 'bg-zinc-900 text-zinc-500 hover:text-zinc-300'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-widest">Refresh</span>
            <div className="flex rounded-lg border border-zinc-700 overflow-hidden">
              {POLL_OPTIONS.map((o) => (
                <button
                  key={o.ms}
                  type="button"
                  onClick={() => setPollMs(o.ms)}
                  className={`px-2 py-1.5 text-xs font-mono font-semibold ${
                    pollMs === o.ms ? 'bg-indigo-500/20 text-indigo-300' : 'bg-zinc-900 text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {o.label}
                </button>
              ))}
            </div>
          </div>

          <IndicatorSettingsPopover settings={indicatorSettings} onChange={setIndicatorSettings} />
          </div>
        </div>
      </div>

      <LevelScoreCard confluence={confluence} symbol={selection.symbol} />

      {error && (
        <div className="mx-6 mt-3 px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}
      </div>

      {/* Explicit measured height, not flex-1/min-h: lightweight-charts' autoSize reads the
          container's clientHeight, and a percentage-height (h-full) descendant can't resolve
          against an ancestor sized only by min-height — it collapses to ~0px. Full-bleed (no
          side padding) so the chart uses the whole viewport width. */}
      <div className="w-full p-1.5" style={{ height: `calc(100vh - ${topHeight}px)` }}>
        <div className="w-full h-full bg-zinc-900/60 border border-zinc-800 rounded-xl overflow-hidden">
          {candles.length > 0 ? (
            <LevelChart
              key={`${selection.symbolType}-${selection.symbol}-${chartInterval}`}
              candles={candles}
              levelBuckets={levelBuckets}
              indicators={indicators}
              prevDayLevels={prevDayLevels}
              visible={visibleOverlays}
              indicatorLabels={indicatorSettings}
              levelsMode={levelsMode}
              label={`${selection.symbol} · ${chartInterval}m / ${levelInterval}m levels`}
            />
          ) : (
            <div className="flex items-center justify-center h-full text-zinc-500 text-sm">
              {loading ? 'Loading…' : 'No data available yet.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
