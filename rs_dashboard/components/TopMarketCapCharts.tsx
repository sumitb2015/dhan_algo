'use client';

// Two 8-chart grids on one page, switched by a Stocks/Indices submenu:
//  - Stocks: the heaviest NIFTY constituents by index weight (the standard
//    proxy for market cap here — see NIFTY_TOP10_BY_WEIGHT in lib/nifty50.ts,
//    the same list Advanced Scalper's Top-10 panel uses), sliced to 8.
//  - Indices: the 8 headline sectoral/benchmark indices, same set and order as
//    Advanced Scalper's Top Markets panel (app/api/scalper/top-indices/route.ts)
//    minus India VIX and Crude Oil, which have no daily index-level chart here.
// Both tabs render via the existing /api/equity-candles feed and
// LightweightCandlestickChart — no new data plumbing.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { RefreshCw, LayoutGrid } from 'lucide-react';
import type { EquityCandlesResponse } from '@/app/api/equity-candles/route';
import { NIFTY_TOP10_BY_WEIGHT } from '@/lib/nifty50';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import LightweightCandlestickChart from './LightweightCandlestickChart';

interface Tile {
  symbol: string;
  name: string;
  /** Shown next to the rank badge — index weight % for stocks, omitted for indices. */
  sub?: string;
}

const TOP8_STOCKS: Tile[] = NIFTY_TOP10_BY_WEIGHT.slice(0, 8).map((s) => ({
  symbol: s.symbol,
  name: s.name,
  sub: `${s.weight.toFixed(2)}% wt`,
}));

// Keys/labels match KNOWN_INDICES in lib/dataLoader.ts, which is what
// /api/equity-candles resolves an index symbol against.
const TOP8_INDICES: Tile[] = [
  { symbol: 'NIFTY50', name: 'Nifty 50' },
  { symbol: 'BANKNIFTY', name: 'Bank Nifty' },
  { symbol: 'FINNIFTY', name: 'Fin Nifty' },
  { symbol: 'NIFTYIT', name: 'Nifty IT' },
  { symbol: 'NIFTY_AUTO', name: 'Nifty Auto' },
  { symbol: 'NIFTY_PHARMA', name: 'Nifty Pharma' },
  { symbol: 'NIFTY_METAL', name: 'Nifty Metal' },
  { symbol: 'NIFTY_REALTY', name: 'Nifty Realty' },
];

type Tab = 'stocks' | 'indices';
const TABS: { key: Tab; label: string; tiles: Tile[] }[] = [
  { key: 'stocks', label: 'Stocks', tiles: TOP8_STOCKS },
  { key: 'indices', label: 'Indices', tiles: TOP8_INDICES },
];

const PERIODS = ['1M', '3M', '6M', '1Y', '2Y', 'ALL'] as const;
type Period = typeof PERIODS[number];

// Approximate trading-day lookback per period button — same convention as
// EquityCandlestickChart. The API always returns full history; this only sets
// the initial zoom so users can still pan/zoom back further per tile.
const PERIOD_DAYS: Record<Period, number | null> = {
  '1M': 22,
  '3M': 66,
  '6M': 132,
  '1Y': 252,
  '2Y': 504,
  ALL: null,
};

const ALL_TILES = [...TOP8_STOCKS, ...TOP8_INDICES];

export default function TopMarketCapCharts() {
  const [tab, setTab] = useState<Tab>('stocks');
  const [period, setPeriod] = useState<Period>('6M');
  // Bumped on period-button click to snap all tiles back to that window,
  // without disturbing a user's in-progress pan/zoom on any single tile.
  const [viewToken, setViewToken] = useState(0);
  const [data, setData] = useState<Record<string, EquityCandlesResponse>>({});
  const [loading, setLoading] = useState(false);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  // Both tabs' symbols are fetched together up front — 16 local CSV reads,
  // cached server-side by dataLoader, so there is no cost to having the other
  // tab's data ready before the user switches to it.
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const results = await Promise.all(
        ALL_TILES.map(async ({ symbol }) => {
          try {
            const res = await fetch(`/api/equity-candles?symbol=${encodeURIComponent(symbol)}`);
            const json: EquityCandlesResponse = await res.json();
            return [symbol, json] as const;
          } catch (err) {
            return [
              symbol,
              { success: false, symbol, candles: [], dataDate: null, error: String(err) } as EquityCandlesResponse,
            ] as const;
          }
        })
      );
      setData(Object.fromEntries(results));
      setLastFetched(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  const handlePeriodClick = useCallback((p: Period) => {
    setPeriod(p);
    setViewToken((t) => t + 1);
  }, []);

  const tiles = useMemo(() => TABS.find((t) => t.key === tab)!.tiles, [tab]);
  const dataDate = Object.values(data).find((d) => d.dataDate)?.dataDate ?? null;

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-white">
      {/* Header */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-md bg-gradient-to-tr from-emerald-600 to-teal-500 flex items-center justify-center shrink-0">
            <LayoutGrid className="h-3.5 w-3.5 text-white" />
          </div>
          <span className="text-[14px] font-bold tracking-tight text-white">Top 8 Charts</span>
        </div>

        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />

        <NavBar />

        {/* Stocks / Indices submenu */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              className={cn(
                'px-2.5 py-1 font-semibold rounded transition-all cursor-pointer',
                tab === t.key
                  ? 'bg-emerald-500/15 text-emerald-300'
                  : 'text-zinc-300 hover:text-white'
              )}
            >
              {t.label}
            </button>
          ))}
        </div>

        {/* Period selector */}
        <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg text-[11px] gap-0.5 ml-auto">
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

        {dataDate && (
          <span className="text-[10px] font-semibold bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-zinc-300 hidden md:inline tabular-nums">
            DATA: {dataDate}
          </span>
        )}

        {lastFetched && (
          <span className="text-[10px] text-zinc-400 hidden md:inline tabular-nums">
            {lastFetched.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}

        <button
          onClick={fetchAll}
          disabled={loading}
          className="h-7 w-7 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-300 hover:text-white hover:bg-zinc-800 transition-all disabled:opacity-40 cursor-pointer"
        >
          <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </header>

      {/* Body: 8-tile grid — 1 col on mobile, 2 on tablet, 4 on desktop (2 rows) */}
      <div className="flex-1 min-h-0 p-4">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {tiles.map((s, i) => {
            const resp = data[s.symbol];
            return (
              <div
                key={s.symbol}
                className="flex flex-col h-[320px] bg-zinc-950/60 border border-zinc-900 rounded-xl p-2"
              >
                <div className="flex items-center justify-between px-1 pb-1 shrink-0">
                  <span className="text-xs font-bold text-white">{s.name}</span>
                  <span className="text-[10px] text-zinc-500 font-mono tabular-nums">
                    #{i + 1}{s.sub ? ` · ${s.sub}` : ''}
                  </span>
                </div>
                <div className="flex-1 min-h-0">
                  {resp && resp.success && resp.candles.length > 0 ? (
                    <LightweightCandlestickChart
                      candles={resp.candles}
                      initialBars={PERIOD_DAYS[period]}
                      viewToken={viewToken}
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-zinc-500 text-[11px]">
                      {loading ? 'Loading…' : resp?.error ?? 'No data'}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
