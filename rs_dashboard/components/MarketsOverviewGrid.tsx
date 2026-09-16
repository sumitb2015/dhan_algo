'use client';

// Full-page tile dashboard for the headline NSE indices plus MCX crude oil /
// crude oil mini futures — click a tile to open its detail view (live stats
// + today's intraday chart) at /markets/[key].
//
// Data comes from /api/scalper/top-indices (live LTP + % change vs yesterday's
// close). That route already solves the hard parts — Dhan-only sourcing, the
// 15:30 close-flip trap, pre-market "yesterday vs day before" fallback — so
// this page just renders it; see dhan-prevclose-pct-change skill for why.

import React, { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { TrendingUp, TrendingDown, Minus, Fuel, LineChart } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import NavBar from './NavBar';
import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { fmtPrice } from './LiveTickerPanel';
import { startLiveIndicesBridge } from '@/lib/startLiveIndicesBridge';
import { geistDisplay } from '@/lib/fonts';

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

export default function MarketsOverviewGrid() {
  // The 9 NSE-index rows come from this bridge's hub file (see route comments
  // on scalper/top-indices' fromHub) — without starting it, only the two
  // MCX rows (which go over a separate REST path) ever populate.
  useEffect(() => { startLiveIndicesBridge(); }, []);

  const { data, flash, now } = useLiveTickerPoll<IndicesResponse>('/api/scalper/top-indices', pickLtps);

  const tickMs = data?.updated_at ? new Date(data.updated_at).getTime() : NaN;
  const stale = isStale(tickMs, now);
  const ageMs = ageOf(tickMs, now);

  const rows = useMemo(() => {
    const order = data?.order ?? [];
    const quotes = data?.quotes ?? {};
    return order.map(o => ({ ...o, quote: quotes[o.key] ?? null }));
  }, [data]);

  const missing = data ? data.order.length - data.count : 0;
  const empty = !!data && data.count === 0;
  const liveState: 'loading' | 'stale' | 'error' | 'warn' | 'live' =
    !data ? 'loading' : stale ? 'stale' : empty ? 'error' : missing > 0 ? 'warn' : 'live';
  const liveLabel =
    !data ? 'loading…'
      : stale ? `STALE ${ageLabel(ageMs)}`
      : empty ? 'no data'
      : missing > 0 ? `${missing} missing`
      : new Date(data.updated_at).toLocaleTimeString('en-IN', { hour12: false });

  return (
    <div className="relative isolate flex flex-col min-h-screen bg-zinc-950 text-white overflow-hidden">
      {/* Ambient glass backdrop — fixed, blurred colour blobs that sit behind
          every translucent surface so the blur/border-brightness glass effect
          below actually has something soft to refract. Pure decoration:
          pointer-events-none, z-0, and low enough opacity to stay legible and
          theme-neutral in white mode too. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className="absolute -top-32 -left-24 w-[36rem] h-[36rem] rounded-full bg-sky-500/25 blur-[100px]" />
        <div className="absolute top-1/4 -right-24 w-[32rem] h-[32rem] rounded-full bg-emerald-500/20 blur-[100px]" />
        <div className="absolute bottom-0 left-1/3 w-[30rem] h-[30rem] rounded-full bg-violet-500/20 blur-[100px]" />
      </div>

      <div className="relative sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800/60 bg-zinc-950/60 backdrop-blur-xl">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg
                          bg-sky-500/10 border border-sky-500/25 shrink-0 backdrop-blur-sm">
            <LineChart className="h-4 w-4 text-sky-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-sky-400 uppercase tracking-[0.18em] mb-0.5">
              Markets
            </p>
            <h1 className={cn(geistDisplay.className, 'text-base font-bold text-white tracking-tight leading-none')}>
              Markets Overview
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Nifty, Bank Nifty &amp; sector indices, India VIX, and MCX crude oil — live vs yesterday&apos;s close
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5" title={data?.errors?.length ? data.errors.join(' | ') : undefined}>
            <span className={cn('w-2 h-2 rounded-full',
              liveState === 'live' ? 'bg-emerald-400 animate-pulse'
                : liveState === 'loading' ? 'bg-yellow-400 animate-pulse'
                : liveState === 'warn' ? 'bg-amber-400'
                : 'bg-rose-400')} />
            <span className={cn('text-[10px] font-mono tabular-nums',
              liveState === 'stale' || liveState === 'error' ? 'text-rose-400 font-bold'
                : liveState === 'warn' ? 'text-amber-400 font-bold' : 'text-zinc-500')}>
              {liveLabel}
            </span>
          </div>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="relative z-10 flex-1 px-6 py-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
          {rows.map(r => {
            const f = flash[r.key];
            const pct = r.quote?.change_pct ?? null;
            const up = pct !== null && pct > 0;
            const down = pct !== null && pct < 0;
            const isMcx = MCX_KEYS.has(r.key);
            const Icon = isMcx ? Fuel : LineChart;
            const DirIcon = pct === null ? Minus : up ? TrendingUp : down ? TrendingDown : Minus;
            const toneClass = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-zinc-400';
            const glowClass = up ? 'group-hover:shadow-emerald-500/10' : down ? 'group-hover:shadow-red-500/10' : 'group-hover:shadow-white/5';

            return (
              <Link key={r.key} href={`/markets/${r.key}`} className="block group">
                <Card className={cn(
                  'relative bg-zinc-900/40 border-white/10 rounded-2xl px-4 py-3.5 h-full',
                  'backdrop-blur-xl shadow-lg shadow-black/20 transition-all duration-300',
                  'before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-2xl',
                  'before:bg-gradient-to-r before:from-transparent before:via-white/25 before:to-transparent',
                  'group-hover:border-white/20 group-hover:bg-zinc-900/60 group-hover:-translate-y-0.5',
                  'group-hover:shadow-xl', glowClass,
                )}>
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">
                      <Icon className={cn('h-3 w-3', isMcx ? 'text-amber-400' : 'text-sky-400')} />
                      {isMcx ? 'MCX' : 'Index'}
                    </span>
                    <DirIcon className={cn('h-3.5 w-3.5', toneClass)} />
                  </div>

                  <div className={cn(geistDisplay.className, 'text-sm font-semibold text-zinc-200 mb-1.5 truncate')}>
                    {r.label}
                  </div>

                  <div className="flex items-end justify-between gap-2">
                    <span className={cn('font-mono text-lg font-bold leading-none tabular-nums transition-colors',
                      f === 'up' ? 'text-emerald-300' : f === 'down' ? 'text-red-300' : 'text-zinc-100')}>
                      {r.quote && r.quote.ltp > 0 ? fmtPrice(r.quote.ltp) : '—'}
                    </span>
                    <span className={cn('inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-bold tabular-nums font-mono border',
                      pct === null ? 'bg-zinc-800 border-zinc-700 text-zinc-500'
                        : up ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                        : down ? 'bg-red-500/10 border-red-500/30 text-red-400'
                        : 'bg-zinc-800 border-zinc-700 text-zinc-500')}>
                      {pct === null ? '—' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}
                    </span>
                  </div>
                </Card>
              </Link>
            );
          })}

          {!data && Array.from({ length: 10 }).map((_, i) => (
            <div key={i} className="rounded-2xl border border-white/10 bg-zinc-900/30 backdrop-blur-xl h-[104px] animate-pulse" />
          ))}
        </div>
      </div>
    </div>
  );
}
