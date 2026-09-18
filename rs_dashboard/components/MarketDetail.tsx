'use client';

// Detail view for one Markets Overview tile: a full-page live price display.
// Reuses the same live-quote source as the tile grid (/api/scalper/top-indices)
// — no chart/candle fetch here, deliberately: that meant a per-symbol Python
// spawn hitting Dhan's rate-limited intraday-candle endpoint just to view one
// price, which isn't worth the API budget for what this page is for. Day
// High/Day Low still show up here because they ride the same quote packet
// LTP already comes from — no extra request either.

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import Link from 'next/link';
import { ArrowLeft, TrendingUp, TrendingDown, Minus, Fuel, LineChart, PictureInPicture2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import NavBar from './NavBar';
import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { fmtPrice } from './LiveTickerPanel';
import { startLiveIndicesBridge } from '@/lib/startLiveIndicesBridge';
import { geistDisplay } from '@/lib/fonts';

// Chrome/Edge-only API, not yet in lib.dom.d.ts.
declare global {
  interface Window {
    documentPictureInPicture?: {
      requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
      window: Window | null;
    };
  }
}

// Copies every stylesheet from the main document into the PiP window's head so
// Tailwind utility classes used in <PipContent> render correctly there — the
// PiP window is a genuinely separate document with no CSS of its own.
function copyStylesInto(pip: Window) {
  Array.from(document.styleSheets).forEach((styleSheet) => {
    try {
      const rules = Array.from(styleSheet.cssRules).map((r) => r.cssText).join('\n');
      const style = pip.document.createElement('style');
      style.textContent = rules;
      pip.document.head.appendChild(style);
    } catch {
      // Cross-origin stylesheet — cssRules is inaccessible, so re-link instead.
      if (styleSheet.href) {
        const link = pip.document.createElement('link');
        link.rel = 'stylesheet';
        link.href = styleSheet.href;
        pip.document.head.appendChild(link);
      }
    }
  });
}

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

  const [pipSupported, setPipSupported] = useState<boolean | null>(null);
  const [pipWindow, setPipWindow] = useState<Window | null>(null);
  const pipWindowRef = useRef<Window | null>(null);

  useEffect(() => { setPipSupported(typeof window !== 'undefined' && 'documentPictureInPicture' in window); }, []);

  useEffect(() => {
    // Close the floating window on unmount (route away) rather than leaving it
    // orphaned with a portal target that no longer receives updates.
    return () => { pipWindowRef.current?.close(); };
  }, []);

  async function openPip() {
    if (!window.documentPictureInPicture) return;
    const pip = await window.documentPictureInPicture.requestWindow({ width: 220, height: 100 });
    copyStylesInto(pip);
    pip.document.body.style.margin = '0';
    pip.document.body.style.background = '#09090b';
    pip.addEventListener('pagehide', () => {
      pipWindowRef.current = null;
      setPipWindow(null);
    });
    pipWindowRef.current = pip;
    setPipWindow(pip);
  }

  function closePip() {
    pipWindowRef.current?.close();
    pipWindowRef.current = null;
    setPipWindow(null);
  }

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
    <div className="relative isolate flex flex-col min-h-screen bg-zinc-950 text-white overflow-hidden">
      {/* Same ambient glass backdrop as the Markets Overview grid — see the
          comment there. Kept in sync deliberately so navigating tile → detail
          doesn't jump between two different visual languages. */}
      <div aria-hidden className="pointer-events-none fixed inset-0 z-0">
        <div className={cn('absolute -top-32 -left-24 w-[36rem] h-[36rem] rounded-full blur-[100px]',
          up ? 'bg-emerald-500/25' : down ? 'bg-red-500/25' : 'bg-sky-500/25')} />
        <div className="absolute bottom-0 right-0 w-[32rem] h-[32rem] rounded-full bg-violet-500/20 blur-[100px]" />
      </div>

      <div className="relative sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800/60 bg-zinc-950/60 backdrop-blur-xl">
        <div className="flex items-center gap-3 min-w-0">
          <Link href="/markets" className="flex items-center justify-center w-8 h-8 rounded-lg
                          bg-zinc-900/60 backdrop-blur-sm border border-white/10 shrink-0 hover:border-white/20 hover:bg-zinc-800/60 transition-colors">
            <ArrowLeft className="h-4 w-4 text-zinc-400" />
          </Link>
          <div className="flex items-center justify-center w-8 h-8 rounded-lg
                          bg-sky-500/10 border border-sky-500/25 shrink-0 backdrop-blur-sm">
            <Icon className={cn('h-4 w-4', isMcx ? 'text-amber-400' : 'text-sky-400')} />
          </div>
          <div className="min-w-0">
            <p className="text-[9px] font-bold text-sky-400 uppercase tracking-[0.18em] mb-0.5">
              {isMcx ? 'MCX' : 'Index'}
            </p>
            <h1 className={cn(geistDisplay.className, 'text-sm font-bold text-white tracking-tight leading-none truncate')}>
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
          <button
            type="button"
            onClick={pipWindow ? closePip : openPip}
            disabled={pipSupported === false}
            title={
              pipSupported === false
                ? 'Floating window needs Chrome or Edge'
                : pipWindow ? 'Close floating window' : 'Open always-on-top floating window'
            }
            aria-label={pipWindow ? 'Close floating window' : 'Open floating window'}
            className="flex items-center justify-center w-8 h-8 rounded-lg bg-zinc-900/60 backdrop-blur-sm
                      border border-white/10 shrink-0 hover:border-white/20 hover:bg-zinc-800/60
                      transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-zinc-900/60"
          >
            <PictureInPicture2 className={cn('h-4 w-4', pipWindow ? 'text-sky-400' : 'text-zinc-400')} />
          </button>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {pipWindow && createPortal(
        <PipContent
          label={row?.label ?? marketKey}
          isMcx={isMcx}
          quote={quote}
          pct={pct}
          up={up}
          down={down}
          flash={f}
          stale={stale}
          hasData={!!data}
          ageMs={ageMs}
        />,
        pipWindow.document.body,
      )}

      {notFound ? (
        <div className="relative z-10 flex-1 flex items-center justify-center text-sm text-zinc-500">
          Unknown market &ldquo;{marketKey}&rdquo;. <Link href="/markets" className="ml-1 underline hover:text-zinc-300">Back to Markets Overview</Link>
        </div>
      ) : (
        <div className="relative z-10 flex-1 px-4 sm:px-6 py-5 md:h-[calc(100vh-73px)]">
          <Card className="relative bg-zinc-900/40 border-white/10 backdrop-blur-xl rounded-2xl flex flex-col items-center justify-center gap-6 sm:gap-8 md:gap-10 p-5 sm:p-8 md:p-12 h-full shadow-2xl shadow-black/30
                          before:absolute before:inset-x-0 before:top-0 before:h-px before:rounded-t-2xl
                          before:bg-gradient-to-r before:from-transparent before:via-white/20 before:to-transparent">
            <div className="flex flex-col items-center text-center w-full">
              <div className={cn('font-mono font-bold tabular-nums leading-none transition-colors text-5xl sm:text-7xl md:text-9xl lg:text-[11rem]',
                f === 'up' ? 'text-emerald-300' : f === 'down' ? 'text-red-300' : 'text-zinc-100')}>
                {quote && quote.ltp > 0 ? fmtPrice(quote.ltp) : '—'}
              </div>
              <div className="flex items-center flex-wrap justify-center gap-2 sm:gap-3 md:gap-4 mt-4 sm:mt-6 md:mt-8">
                <DirIcon className={cn('h-5 w-5 sm:h-8 sm:w-8 md:h-12 md:w-12', toneClass)} />
                <span className={cn('inline-flex items-center rounded-lg font-bold tabular-nums font-mono border px-2.5 py-1 sm:px-4 sm:py-1.5 md:px-5 md:py-2 text-lg sm:text-2xl md:text-4xl',
                  pct === null ? 'bg-zinc-800 border-zinc-700 text-zinc-500'
                    : up ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                    : down ? 'bg-red-500/10 border-red-500/30 text-red-400'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-500')}>
                  {pct === null ? 'N/A' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}
                </span>
                <span className="text-zinc-500 text-xs sm:text-lg md:text-2xl">vs yesterday&apos;s close</span>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-3 sm:gap-4 md:gap-5 w-full max-w-7xl">
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

function PipContent({
  label, isMcx, quote, pct, up, down, flash, stale, hasData, ageMs,
}: {
  label: string;
  isMcx: boolean;
  quote: IndexQuote | null;
  pct: number | null;
  up: boolean;
  down: boolean;
  flash: 'up' | 'down' | undefined;
  stale: boolean;
  hasData: boolean;
  ageMs: number;
}) {
  const Icon = isMcx ? Fuel : LineChart;
  const DirIcon = pct === null ? Minus : up ? TrendingUp : down ? TrendingDown : Minus;
  const toneClass = up ? 'text-emerald-400' : down ? 'text-red-400' : 'text-zinc-400';

  return (
    <div className="flex flex-col h-screen w-screen bg-zinc-950 text-white px-2.5 py-2 gap-1 font-sans overflow-hidden">
      <div className="flex items-center justify-between gap-1.5">
        <div className="flex items-center gap-1 min-w-0">
          <Icon className={cn('h-3 w-3 shrink-0', isMcx ? 'text-amber-400' : 'text-sky-400')} />
          <span className="text-[10px] font-bold text-white tracking-tight truncate">{label}</span>
        </div>
        <span className={cn('w-1.5 h-1.5 rounded-full shrink-0',
          !hasData ? 'bg-yellow-400 animate-pulse' : stale ? 'bg-rose-400' : 'bg-emerald-400 animate-pulse')}
          title={stale ? `Stale ${ageLabel(ageMs)}` : 'Live'} />
      </div>

      <div className="flex items-center justify-between gap-2">
        <div className={cn('font-mono font-bold tabular-nums leading-none text-2xl transition-colors truncate',
          flash === 'up' ? 'text-emerald-300' : flash === 'down' ? 'text-red-300' : 'text-zinc-100')}>
          {quote && quote.ltp > 0 ? fmtPrice(quote.ltp) : '—'}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <DirIcon className={cn('h-3 w-3', toneClass)} />
          <span className={cn('inline-flex items-center rounded font-bold tabular-nums font-mono border px-1.5 py-0.5 text-[11px]',
            pct === null ? 'bg-zinc-800 border-zinc-700 text-zinc-500'
              : up ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
              : down ? 'bg-red-500/10 border-red-500/30 text-red-400'
              : 'bg-zinc-800 border-zinc-700 text-zinc-500')}>
            {pct === null ? 'N/A' : `${pct > 0 ? '+' : ''}${pct.toFixed(2)}%`}
          </span>
        </div>
      </div>

      <div className="flex items-center justify-between gap-2 mt-auto text-[10px] font-mono tabular-nums">
        <span className="text-zinc-500">H <span className="text-emerald-400 font-bold">{quote?.day_high ? fmtPrice(quote.day_high) : '—'}</span></span>
        <span className="text-zinc-500">L <span className="text-red-400 font-bold">{quote?.day_low ? fmtPrice(quote.day_low) : '—'}</span></span>
      </div>
    </div>
  );
}

function StatTile({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div className="flex flex-col gap-1.5 sm:gap-2 md:gap-2.5 rounded-lg border border-white/10 bg-zinc-950/50 backdrop-blur-md px-3 py-3 sm:px-5 sm:py-4 md:px-6 md:py-5 min-w-0 transition-colors hover:border-white/20 hover:bg-zinc-950/70">
      <span className="font-bold uppercase tracking-[0.1em] sm:tracking-[0.15em] text-zinc-500 text-[10px] sm:text-sm md:text-base truncate">{label}</span>
      <span className={cn('font-mono font-bold leading-none tabular-nums text-lg sm:text-2xl md:text-4xl truncate', tone ?? 'text-zinc-100')}>{value}</span>
    </div>
  );
}
