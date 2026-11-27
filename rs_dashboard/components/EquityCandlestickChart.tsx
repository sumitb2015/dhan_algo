'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, CandlestickChart, Activity, Scaling } from 'lucide-react';
import type { EquityCandlesResponse } from '@/app/api/equity-candles/route';
import type { SymbolsResponse, IndexOption } from '@/app/api/symbols/route';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import EquityIndicatorChart from './candlestick/EquityIndicatorChart';
import IndicatorPicker from './indexScalper/IndicatorPicker';
import { newIndicator, type IndicatorInstance, type IndicatorKind } from '@/lib/indexScalperIndicators';
import {
  EQUITY_INDICATOR_KINDS, TIMEFRAMES, barsForPeriod, parseSavedIndicators, resample, toBars, week52, type Timeframe,
} from '@/lib/equityChart';
import { readPref, readPrefOf, savePref } from '@/lib/localPref';

const IND_KEY = 'candlestick.indicators.v1';
const TF_KEY = 'candlestick.timeframe.v1';
const LOG_KEY = 'candlestick.log.v1';
const W52_KEY = 'candlestick.w52.v1';
const VOLUME_NOTE = 'Green / red bars by candle direction along the bottom of the price pane, with a moving average of the volume. Stocks only: the index files carry no volume.';
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from './ui/combobox';

const PERIODS = ['1M', '3M', '6M', '1Y', '2Y', 'ALL'] as const;
type Period = typeof PERIODS[number];

// Approximate trading-day lookback per period button. The API always returns
// the full available history — these only set the *initial* zoom window so
// users can still freely pan/zoom back into older data that's already loaded.
const PERIOD_DAYS: Record<Period, number | null> = {
  '1M': 22,
  '3M': 66,
  '6M': 132,
  '1Y': 252,
  '2Y': 504,
  ALL: null,
};

export default function EquityCandlestickChart({ initialSymbol }: { initialSymbol?: string }) {
  const [symbol, setSymbol] = useState<string>(initialSymbol || 'RELIANCE');
  const [period, setPeriod] = useState<Period>('1Y');
  // Bumped whenever the user explicitly picks a period, so the chart snaps
  // back to that window; left untouched while the user is freely panning/
  // zooming so their view is preserved across re-renders.
  const [viewToken, setViewToken] = useState(0);
  const [data, setData] = useState<EquityCandlesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);
  const [symbols, setSymbols] = useState<string[]>([]);
  const [indices, setIndices] = useState<IndexOption[]>([]);
  // Saved settings are read after mount (localStorage does not exist during the server render).
  const [timeframe, setTimeframe] = useState<Timeframe>('D');
  const [indicators, setIndicators] = useState<IndicatorInstance[]>(() => parseSavedIndicators(null));
  const [logScale, setLogScale] = useState(false);
  const [show52w, setShow52w] = useState(true);
  const [prefsLoaded, setPrefsLoaded] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);

  useEffect(() => {
    /* eslint-disable react-hooks/set-state-in-effect */
    setTimeframe(readPrefOf(TF_KEY, ['D', 'W', 'M'] as const, 'D'));
    setIndicators(parseSavedIndicators(readPref(IND_KEY)));
    setLogScale(readPref(LOG_KEY) === '1');
    setShow52w(readPref(W52_KEY) !== '0');
    setPrefsLoaded(true);
    /* eslint-enable react-hooks/set-state-in-effect */
  }, []);
  useEffect(() => { if (prefsLoaded) savePref(IND_KEY, JSON.stringify(indicators)); }, [indicators, prefsLoaded]);

  const addIndicator = useCallback((k: IndicatorKind) => {
    const id = `${k}-${Date.now().toString(36)}`;
    // Volume is one per chart: picking it again just shows it.
    setIndicators(list => (k === 'volume' && list.some(i => i.kind === 'volume')
      ? list.map(i => (i.kind === 'volume' ? { ...i, visible: true } : i))
      : [...list, newIndicator(k, id)]));
    if (k !== 'volume') setEditId(id);
  }, []);
  const patchIndicator = useCallback((id: string, patch: Partial<IndicatorInstance>) => {
    setIndicators(list => list.map(i => (i.id === id ? { ...i, ...patch } : i)));
  }, []);
  const removeIndicator = useCallback((id: string) => setIndicators(list => list.filter(i => i.id !== id)), []);
  const toggleIndicator = useCallback((id: string) => setIndicators(list => list.map(i => (i.id === id ? { ...i, visible: !i.visible } : i))), []);
  const editIndicator = useCallback((id: string) => { setEditId(id); setPickerOpen(true); }, []);

  useEffect(() => {
    fetch('/api/symbols')
      .then((res) => res.json())
      .then((json: SymbolsResponse) => {
        if (json.success) {
          setSymbols(json.symbols);
          setIndices(json.indices);
        }
      })
      .catch(() => {});
  }, []);

  // Indices are searched/selected by their display label (e.g. "Nifty 50")
  // while stocks are searched/selected by ticker — both share one combobox.
  const indexLabelToKey = useMemo(() => new Map(indices.map((i) => [i.label, i.key])), [indices]);
  const indexKeyToLabel = useMemo(() => new Map(indices.map((i) => [i.key, i.label])), [indices]);
  const comboItems = useMemo(() => [...indices.map((i) => i.label), ...symbols], [indices, symbols]);
  const displayValue = indexKeyToLabel.get(symbol) ?? symbol;

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/equity-candles?symbol=${encodeURIComponent(symbol)}`);
      const json: EquityCandlesResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to load candles');
      setData(json);
      setLastFetched(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleSymbolChange = useCallback((s: string) => {
    setSymbol(s);
    setViewToken((t) => t + 1);
  }, []);

  const bars = useMemo(() => (data ? toBars(resample(data.candles, timeframe)) : []), [data, timeframe]);
  const w52 = useMemo(() => (data ? week52(data.candles) : null), [data]);
  const last = data && data.candles.length > 0 ? data.candles[data.candles.length - 1] : null;
  const prev = data && data.candles.length > 1 ? data.candles[data.candles.length - 2] : null;
  const dayChg = last && prev ? ((last.close - prev.close) / prev.close) * 100 : null;
  // Where the last close sits in its 52-week range: 0 % at the low, 100 % at the high.
  const rangePos = last && w52 && w52.high > w52.low ? ((last.close - w52.low) / (w52.high - w52.low)) * 100 : null;

  const handleTimeframe = useCallback((tf: Timeframe) => {
    setTimeframe(tf);
    savePref(TF_KEY, tf);
    setViewToken((t) => t + 1);
  }, []);

  const handlePeriodClick = useCallback((p: Period) => {
    setPeriod(p);
    setViewToken((t) => t + 1);
  }, []);

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-white">
      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center shrink-0">
            <CandlestickChart className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Candlestick Charts</span>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        <NavBar />

        {/* Symbol / index search */}
        <Combobox
          items={comboItems}
          value={displayValue}
          onValueChange={(v) => v && handleSymbolChange(indexLabelToKey.get(v) ?? v)}
        >
          <ComboboxInput placeholder="Search stock or index…" className="w-56 ml-auto" />
          <ComboboxContent>
            <ComboboxEmpty>No matching symbol</ComboboxEmpty>
            <ComboboxList>
              {(item: string) => (
                <ComboboxItem key={item} value={item}>
                  {item}
                  {indexLabelToKey.has(item) && (
                    <span className="ml-1.5 text-[9px] font-semibold text-emerald-400">INDEX</span>
                  )}
                </ComboboxItem>
              )}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>

        {/* Period selector */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          {PERIODS.map((p) => (
            <button
              key={p}
              onClick={() => handlePeriodClick(p)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all cursor-pointer',
                period === p
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'text-zinc-300 hover:text-white'
              )}
            >
              {p}
            </button>
          ))}
        </div>

        {/* Timeframe */}
        <div role="group" aria-label="Timeframe" className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          {TIMEFRAMES.map((t) => (
            <button
              key={t.key}
              type="button"
              title={t.hint}
              aria-pressed={timeframe === t.key}
              onClick={() => handleTimeframe(t.key)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                timeframe === t.key ? 'bg-sky-500/15 text-sky-300' : 'text-zinc-300 hover:text-white'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={() => { setEditId(null); setPickerOpen(true); }}
          className="h-7 px-2.5 flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 text-[11px] font-semibold text-zinc-200 hover:text-white hover:bg-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
        >
          <Activity className="h-3.5 w-3.5" /> Indicators
        </button>

        <button
          type="button"
          aria-pressed={logScale}
          title="Logarithmic price scale"
          onClick={() => setLogScale((v) => { savePref(LOG_KEY, v ? '0' : '1'); return !v; })}
          className={cn(
            'h-7 px-2 rounded-lg border text-[11px] font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
            logScale ? 'border-sky-500/40 bg-sky-500/15 text-sky-300' : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white'
          )}
        >
          LOG
        </button>

        <button
          type="button"
          aria-pressed={show52w}
          title="52-week high / low lines"
          onClick={() => setShow52w((v) => { savePref(W52_KEY, v ? '0' : '1'); return !v; })}
          className={cn(
            'h-7 px-2 rounded-lg border text-[11px] font-bold cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
            show52w ? 'border-amber-500/40 bg-amber-500/15 text-amber-300' : 'border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white'
          )}
        >
          52W
        </button>

        <button
          type="button"
          aria-label="Reset scale"
          title="Reset scale: auto-fit the price axis and re-frame the chosen period"
          onClick={() => setViewToken((t) => t + 1)}
          className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60"
        >
          <Scaling className="h-3.5 w-3.5" />
        </button>

        {data?.dataDate && (
          <span className="text-[10px] font-semibold bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-zinc-300 hidden md:inline tabular-nums">
            DATA: {data.dataDate}
          </span>
        )}

        {lastFetched && (
          <span className="text-[10px] text-zinc-400 hidden md:inline tabular-nums">
            {lastFetched.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}

        <button
          onClick={fetchData}
          disabled={loading}
          aria-label="Reload candles"
          className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-all disabled:opacity-40 cursor-pointer"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </header>

      {/* Body */}
      <div className="flex-1 min-h-0 p-4">
        {error && (
          <div className="text-sm text-red-400 bg-red-950/30 border border-red-900/50 rounded-lg p-3 mb-3">
            {error}
          </div>
        )}
        {last && (
          <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-2 px-1 text-xs tabular-nums" data-testid="equity-stats">
            <span className="text-sm font-bold text-white">{displayValue}</span>
            <span className="text-zinc-100 font-semibold">{last.close.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            {dayChg !== null && (
              <span className={cn('font-semibold', dayChg >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {dayChg >= 0 ? '+' : ''}{dayChg.toFixed(2)}% <span className="text-zinc-500 font-normal">1D</span>
              </span>
            )}
            {w52 && (
              <span className="flex items-center gap-2 text-zinc-400">
                52W
                <span className="text-zinc-200">{w52.low.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                {rangePos !== null && (
                  <span className="relative w-24 h-1.5 rounded-full bg-zinc-800" title={`${rangePos.toFixed(0)}% of the 52-week range`}>
                    <span className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-amber-400" style={{ left: `${Math.min(100, Math.max(0, rangePos))}%` }} />
                  </span>
                )}
                <span className="text-zinc-200">{w52.high.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
                <span className="text-zinc-500">({((last.close / w52.high - 1) * 100).toFixed(1)}% from high)</span>
              </span>
            )}
          </div>
        )}
        <div className="w-full h-[calc(100vh-150px)] bg-zinc-950/60 border border-zinc-900 rounded-xl p-2">
          {data && data.candles.length > 0 ? (
            <EquityIndicatorChart
              bars={bars}
              indicators={indicators}
              initialBars={barsForPeriod(PERIOD_DAYS[period], timeframe)}
              viewToken={viewToken}
              logScale={logScale}
              week52={show52w ? w52 : null}
              onToggle={toggleIndicator}
              onEdit={editIndicator}
              onRemove={removeIndicator}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-500 text-sm">
              {loading ? 'Loading candles...' : 'No data available'}
            </div>
          )}
        </div>
      </div>

      <IndicatorPicker
        open={pickerOpen}
        indicators={indicators}
        editId={editId}
        kinds={EQUITY_INDICATOR_KINDS}
        volumeNote={VOLUME_NOTE}
        onAdd={addIndicator}
        onChange={patchIndicator}
        onRemove={removeIndicator}
        onEdit={setEditId}
        onClose={() => { setPickerOpen(false); setEditId(null); }}
      />
    </div>
  );
}
