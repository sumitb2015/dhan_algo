'use client';

// Detail view for one Markets Overview tile: a full-page live price display.
// Reuses the same live-quote source as the tile grid (/api/scalper/top-indices)
// — no chart/candle fetch here, deliberately: that meant a per-symbol Python
// spawn hitting Dhan's rate-limited intraday-candle endpoint just to view one
// price, which isn't worth the API budget for what this page is for. Day
// High/Day Low still show up here because they ride the same quote packet
// LTP already comes from — no extra request either.

import React, { useEffect } from 'react';
import Link from 'next/link';
import { ArrowLeft, TrendingUp, TrendingDown, Minus, Fuel, LineChart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import NavBar from './NavBar';
import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { fmtPrice } from './LiveTickerPanel';
import { startLiveIndicesBridge } from '@/lib/startLiveIndicesBridge';

interface IndexQuote {
  ltp: number;
  prev_close: number;
  change_pct: number | null;
  source: string;
  day_high: number | null;
  day_low: number | null;
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

export default function MarketDetail({ marketKey }: { marketKey: string }) {
  // Same bridge the tile grid starts — a direct link into /markets/[key]
  // (bookmark, refresh) never mounts the grid, so this row would otherwise
  // stay hub-less and blank until some other open tab happened to start it.
  useEffect(() => { startLiveIndicesBridge(); }, []);

  const { data, flash, now } = useLiveTickerPoll<IndicesResponse>('/api/scalper/top-indices', pickLtps);

  const tickMs = data?.updated_at ? new Date(data.updated_at).getTime() : NaN;
  const stale = isStale(tickMs, now);
  const ageMs = ageOf(tickMs, now);

  const row = data?.order.find(o => o.key === marketKey) ?? null;
  const quote = data?.quotes?.[marketKey] ?? null;
  const f = flash[marketKey];

  const pct = quote?.change_pct ?? null;
  const up = pct !== null && pct > 0;
  const down = pct !== null && pct < 0;
  const isMcx = MCX_KEYS.has(marketKey);
  const Icon = isMcx ? Fuel : LineChart;
  const DirIcon = pct === null ? Minus : up ? TrendingUp : down ? TrendingDown : Minus;
  const toneClass = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-zinc-400';

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
        <div className="flex-1 px-6 py-5 md:h-[calc(100vh-73px)]">
          <Card className="bg-zinc-900/60 border-zinc-800/80 rounded-2xl flex flex-col items-center justify-center gap-8 p-10 h-full">
            <div className="flex flex-col items-center text-center">
              <div className={cn('font-mono font-bold tabular-nums leading-none transition-colors text-8xl md:text-9xl',
                f === 'up' ? 'text-emerald-300' : f === 'down' ? 'text-red-300' : 'text-zinc-100')}>
                {quote && quote.ltp > 0 ? fmtPrice(quote.ltp) : '—'}
              </div>
              <div className="flex items-center gap-3 mt-6">
                <DirIcon className={cn('h-9 w-9', toneClass)} />
                <span className={cn('inline-flex items-center rounded-lg font-bold tabular-nums font-mono border px-4 py-1.5 text-3xl',
                  pct === null ? 'bg-zinc-800 border-zinc-700 text-zinc-500'
                    : up ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : down ? 'bg-red-500/10 border-red-500/30 text-red-400'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-500')}>
                  {pct === null ? 'N/A' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}
                </span>
                <span className="text-zinc-500 text-lg">vs yesterday&apos;s close</span>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 w-full max-w-5xl">
              <StatTile label="Prev Close" value={quote && quote.prev_close > 0 ? fmtPrice(quote.prev_close) : '—'} />
              <StatTile label="Change" value={
                quote && quote.prev_close > 0 && quote.ltp > 0
                  ? `${quote.ltp - quote.prev_close >= 0 ? '+' : ''}${fmtPrice(quote.ltp - quote.prev_close)}`
                  : '—'
              } tone={toneClass} />
              <StatTile label="Day High" value={quote?.day_high ? fmtPrice(quote.day_high) : '—'} tone="text-emerald-400" />
              <StatTile label="Day Low" value={quote?.day_low ? fmtPrice(quote.day_low) : '—'} tone="text-red-400" />
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 px-6 py-5">
      <span className="font-bold uppercase tracking-[0.15em] text-zinc-500 text-sm">{label}</span>
      <span className={cn('font-mono font-bold leading-none tabular-nums text-4xl', tone ?? 'text-zinc-100')}>{value}</span>
    </div>
  );
}
