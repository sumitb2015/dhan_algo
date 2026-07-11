'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, CandlestickChart } from 'lucide-react';
import type { EquityCandlesResponse } from '@/app/api/equity-candles/route';
import type { SymbolsResponse, IndexOption } from '@/app/api/symbols/route';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import LightweightCandlestickChart from './LightweightCandlestickChart';
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

export default function EquityCandlestickChart() {
  const [symbol, setSymbol] = useState<string>('RELIANCE');
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
                    <span className="ml-1.5 text-[9px] font-semibold text-emerald-400/80">INDEX</span>
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
        <div className="w-full h-[calc(100vh-120px)] bg-zinc-950/60 border border-zinc-900 rounded-xl p-2">
          {data && data.candles.length > 0 ? (
            <LightweightCandlestickChart
              candles={data.candles}
              initialBars={PERIOD_DAYS[period]}
              viewToken={viewToken}
            />
          ) : (
            <div className="w-full h-full flex items-center justify-center text-zinc-500 text-sm">
              {loading ? 'Loading candles...' : 'No data available'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
