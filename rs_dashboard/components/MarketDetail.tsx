'use client';

// Detail view for one Markets Overview tile: left half is the live price +
// stats, right half is today's intraday chart. Reuses the same live-quote
// source as the tile grid (/api/scalper/top-indices) plus a dedicated
// intraday-candle route (/api/indices-overview/chart) for the chart half.

import React, { useEffect, useState, useCallback } from 'react';
import Link from 'next/link';
import { ArrowLeft, TrendingUp, TrendingDown, Minus, Fuel, LineChart, Loader2, AlertCircle } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import NavBar from './NavBar';
import FuturesCandleChart from './FuturesCandleChart';
import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { fmtPrice } from './LiveTickerPanel';
import type { CandleData } from '@/app/api/nifty-oi-profile/route';

interface IndexQuote {
  ltp: number;
  prev_close: number;
  change_pct: number | null;
  source: string;
}

interface IndicesResponse {
  success: boolean;
  updated_at: string;
  order: { key: string; label: string }[];
  quotes: Record<string, IndexQuote>;
  count: number;
  errors: string[];
}

function pickLtps(d: IndicesResponse): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, q] of Object.entries(d?.quotes ?? {})) {
    if (typeof q?.ltp === 'number') out[k] = q.ltp;
  }
  return out;
}

const MCX_KEYS = new Set(['CRUDEOIL', 'CRUDEOILM']);
const CHART_POLL_MS = 20_000;

export default function MarketDetail({ marketKey }: { marketKey: string }) {
  const { data, flash, now } = useLiveTickerPoll<IndicesResponse>('/api/scalper/top-indices', pickLtps);

  const tickMs = data?.updated_at ? new Date(data.updated_at).getTime() : NaN;
  const stale = isStale(tickMs, now);
  const ageMs = ageOf(tickMs, now);

  const row = data?.order.find(o => o.key === marketKey) ?? null;
  const quote = data?.quotes?.[marketKey] ?? null;
  const f = flash[marketKey];

  const [candles, setCandles] = useState<CandleData[] | null>(null);
  const [chartError, setChartError] = useState<string | null>(null);
  const [chartLoading, setChartLoading] = useState(true);

  const loadChart = useCallback(async () => {
    try {
      const res = await fetch(`/api/indices-overview/chart?key=${encodeURIComponent(marketKey)}&days=1`, { cache: 'no-store' });
      const json = await res.json();
      if (json.success) {
        setCandles(json.candles ?? []);
        setChartError(null);
      } else {
        setChartError(json.error ?? 'failed to load chart');
      }
    } catch (e) {
      setChartError(String(e));
    } finally {
      setChartLoading(false);
    }
  }, [marketKey]);

  useEffect(() => {
    // Deferred by a task so the first setState doesn't cascade a render during
    // mount — same pattern as useLiveTickerPoll's own poll loop.
    const first = setTimeout(loadChart, 0);
    const id = setInterval(loadChart, CHART_POLL_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [loadChart]);

  const pct = quote?.change_pct ?? null;
  const up = pct !== null && pct > 0;
  const down = pct !== null && pct < 0;
  const isMcx = MCX_KEYS.has(marketKey);
  const Icon = isMcx ? Fuel : LineChart;
  const DirIcon = pct === null ? Minus : up ? TrendingUp : down ? TrendingDown : Minus;
  const toneClass = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-zinc-400';

  const dayHigh = candles && candles.length > 0 ? Math.max(...candles.map(c => c.high)) : null;
  const dayLow = candles && candles.length > 0 ? Math.min(...candles.map(c => c.low)) : null;

  const notFound = data && !row;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/markets" className="flex items-center justify-center w-8 h-8 rounded-lg
                          bg-zinc-900 border border-zinc-800 shrink-0 hover:border-zinc-700 hover:bg-zinc-800 transition-colors">
            <ArrowLeft className="h-4 w-4 text-zinc-400" />
          </Link>
          <div className="flex items-center justify-center w-8 h-8 rounded-lg
                          bg-sky-500/10 border border-sky-500/25 shrink-0">
            <Icon className={cn('h-4 w-4', isMcx ? 'text-amber-400' : 'text-sky-400')} />
          </div>
          <div className="min-w-0">
            <p className="text-[9px] font-bold text-sky-400 uppercase tracking-[0.18em] mb-0.5">
              {isMcx ? 'MCX' : 'Index'}
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none truncate">
              {row?.label ?? marketKey}
            </h1>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" title={data?.errors?.length ? data.errors.join(' | ') : undefined}>
            <span className={cn('w-2 h-2 rounded-full',
              !data ? 'bg-yellow-400 animate-pulse'
                : stale ? 'bg-rose-400'
                : 'bg-emerald-400 animate-pulse')} />
            <span className={cn('text-[10px] font-mono tabular-nums',
              stale ? 'text-rose-400 font-bold' : 'text-zinc-500')}>
              {!data ? 'loading…' : stale ? `STALE ${ageLabel(ageMs)}` : new Date(data.updated_at).toLocaleTimeString('en-IN', { hour12: false })}
            </span>
          </div>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {notFound ? (
        <div className="flex-1 flex items-center justify-center text-sm text-zinc-500">
          Unknown market &ldquo;{marketKey}&rdquo;. <Link href="/markets" className="ml-1 underline hover:text-zinc-300">Back to Markets Overview</Link>
        </div>
      ) : (
        <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4 px-6 py-5 md:h-[calc(100vh-73px)]">
          {/* Left half: live stats */}
          <Card className="bg-zinc-900/60 border-zinc-800/80 rounded-2xl p-6 flex flex-col justify-center gap-6 md:h-full">
            <div>
              <div className={cn('font-mono text-5xl font-bold tabular-nums leading-none transition-colors',
                f === 'up' ? 'text-emerald-300' : f === 'down' ? 'text-red-300' : 'text-zinc-100')}>
                {quote && quote.ltp > 0 ? fmtPrice(quote.ltp) : '—'}
              </div>
              <div className="flex items-center gap-2 mt-3">
                <DirIcon className={cn('h-4 w-4', toneClass)} />
                <span className={cn('inline-flex items-center px-2 py-0.5 rounded text-sm font-bold tabular-nums font-mono border',
                  pct === null ? 'bg-zinc-800 border-zinc-700 text-zinc-500'
                    : up ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : down ? 'bg-red-500/10 border-red-500/30 text-red-400'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-500')}>
                  {pct === null ? 'N/A' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}
                </span>
                <span className="text-[11px] text-zinc-500">vs yesterday&apos;s close</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <StatTile label="Prev Close" value={quote && quote.prev_close > 0 ? fmtPrice(quote.prev_close) : '—'} />
              <StatTile label="Change" value={
                quote && quote.prev_close > 0 && quote.ltp > 0
                  ? `${quote.ltp - quote.prev_close >= 0 ? '+' : ''}${fmtPrice(quote.ltp - quote.prev_close)}`
                  : '—'
              } tone={toneClass} />
              <StatTile label="Day High" value={dayHigh !== null ? fmtPrice(dayHigh) : '—'} tone="text-emerald-400" />
              <StatTile label="Day Low" value={dayLow !== null ? fmtPrice(dayLow) : '—'} tone="text-red-400" />
            </div>
          </Card>

          {/* Right half: today's chart */}
          <Card className="bg-zinc-900/60 border-zinc-800/80 rounded-2xl p-4 flex flex-col md:h-full min-h-[420px]">
            <div className="flex items-center justify-between mb-2 shrink-0">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">Today&apos;s Chart</span>
              {chartLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-zinc-500" />}
            </div>
            <div className="flex-1 min-h-0">
              {chartError && !candles ? (
                <div className="h-full flex items-center justify-center gap-2 text-xs text-rose-400">
                  <AlertCircle className="h-4 w-4" /> {chartError}
                  <button onClick={loadChart} className="ml-2 underline hover:text-rose-300">Retry</button>
                </div>
              ) : chartLoading && !candles ? (
                <div className="h-full flex items-center justify-center gap-2 text-xs text-zinc-500">
                  <Loader2 className="h-4 w-4 animate-spin" /> Loading candles…
                </div>
              ) : candles && candles.length > 0 ? (
                <FuturesCandleChart candles={candles} symbolName={row?.label ?? marketKey} />
              ) : (
                <div className="h-full flex items-center justify-center text-xs text-zinc-500">
                  No intraday candles yet today.
                </div>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3.5 py-3">
      <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">{label}</span>
      <span className={cn('font-mono text-lg font-bold leading-none tabular-nums', tone ?? 'text-zinc-100')}>{value}</span>
    </div>
  );
}
