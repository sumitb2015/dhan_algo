'use client';

// Full-page tile dashboard for the headline NSE indices plus MCX crude oil /
// crude oil mini futures — click a tile to open its detail view (live stats
// + today's intraday chart) at /markets/[key].
//
// Data comes from /api/scalper/top-indices (live LTP + % change vs yesterday's
// close). That route already solves the hard parts — Dhan-only sourcing, the
// 15:30 close-flip trap, pre-market "yesterday vs day before" fallback — so
// this page just renders it; see dhan-prevclose-pct-change skill for why.

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { TrendingUp, TrendingDown, Minus, ArrowUp, ArrowDown, Fuel, LineChart, LayoutGrid, Table2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Card } from '@/components/ui/card';
import NavBar from './NavBar';
import { useLiveTickerPoll, isStale, ageOf, ageLabel } from '@/lib/useLiveTickerPoll';
import { fmtPrice, TH, TD, PctPill, type SortDir } from './LiveTickerPanel';
import { startLiveIndicesBridge } from '@/lib/startLiveIndicesBridge';
import { geistDisplay } from '@/lib/fonts';
import { useGlobalQuotes } from '@/lib/useGlobalQuotes';
import { GLOBAL_MARKETS, GLOBAL_BY_KEY } from '@/lib/globalMarkets';
import { useMarketHistory, type MarketHistory } from '@/lib/useMarketHistory';
import { indianMarketState, globalMarketState, fmtAge, type MarketState } from '@/lib/marketStatus';

interface IndexQuote {
  ltp: number;
  prev_close: number;
  change_pct: number | null;
  source: string;
  day_high?: number | null;
  day_low?: number | null;
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

  const globalQuotes = useGlobalQuotes();

  const [view, setViewState] = useState<'grid' | 'table'>('grid');
  useEffect(() => {
    try { if (localStorage.getItem('markets_view') === 'table') setViewState('table'); } catch { /* storage blocked */ }
  }, []);
  const setView = (v: 'grid' | 'table') => {
    setViewState(v);
    try { localStorage.setItem('markets_view', v); } catch { /* storage blocked */ }
  };

  const tickMs = data?.updated_at ? new Date(data.updated_at).getTime() : NaN;
  const stale = isStale(tickMs, now);
  const ageMs = ageOf(tickMs, now);

  const rows = useMemo(() => {
    const order = data?.order ?? [];
    const quotes = data?.quotes ?? {};
    const base = order.map(o => ({ ...o, quote: (quotes[o.key] ?? null) as IndexQuote | null }));
    // DXY / US yields come from Yahoo, not the Dhan feed above.
    const global = GLOBAL_MARKETS.filter(m => globalQuotes[m.key])
      .map(m => ({ key: m.key, label: m.label, quote: globalQuotes[m.key] as IndexQuote }));
    return [...base, ...global];
  }, [data, globalQuotes]);

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
          <div role="group" aria-label="View" className="flex items-center rounded-lg border border-white/10 bg-zinc-900/60 p-0.5">
            {([['grid', LayoutGrid, 'Grid view'], ['table', Table2, 'Table view']] as const).map(([v, VIcon, lbl]) => (
              <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} aria-label={lbl} title={lbl}
                className={cn('flex items-center gap-1 px-2 py-1 rounded-md text-[11px] font-bold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500',
                  view === v ? 'bg-sky-500/15 text-sky-400' : 'text-zinc-500 hover:text-zinc-300')}>
                <VIcon className="h-3.5 w-3.5" />{v === 'grid' ? 'Grid' : 'Table'}
              </button>
            ))}
          </div>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
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
        {view === 'table' ? (
          <MarketsTable rows={rows} globalQuotes={globalQuotes} loaded={!!data} now={now} feedStale={stale} />
        ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3.5">
          {rows.map(r => {
            const f = flash[r.key];
            const pct = r.quote?.change_pct ?? null;
            const up = pct !== null && pct > 0;
            const down = pct !== null && pct < 0;
            const isMcx = MCX_KEYS.has(r.key);
            const isGlobal = r.key in GLOBAL_BY_KEY;
            const unit = GLOBAL_BY_KEY[r.key]?.unit ?? '';
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
                      {isMcx ? 'MCX' : isGlobal ? (globalQuotes[r.key]?.source === 'yahoo-live' ? 'Global · Live' : 'Global · EOD') : 'Index'}
                    </span>
                    <DirIcon className={cn('h-3.5 w-3.5', toneClass)} />
                  </div>

                  <div className={cn(geistDisplay.className, 'text-sm font-semibold text-zinc-200 mb-1.5 truncate')}>
                    {r.label}
                  </div>

                  <div className="flex items-end justify-between gap-2">
                    <span className={cn('font-mono text-lg font-bold leading-none tabular-nums transition-colors',
                      f === 'up' ? 'text-emerald-300' : f === 'down' ? 'text-red-300' : 'text-zinc-100')}>
                      {r.quote && r.quote.ltp > 0 ? `${fmtPrice(r.quote.ltp)}${unit}` : '—'}
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
        )}
      </div>
    </div>
  );
}

type TableRow = { key: string; label: string; quote: IndexQuote | null };
type SortKey = 'label' | 'group' | 'ltp' | 'chg' | 'pct' | 'prev' | 'high' | 'low' | 'range'
  | 'w1' | 'm1' | 'ytd' | 'w52';

function groupOf(key: string): string {
  return key in GLOBAL_BY_KEY ? GLOBAL_BY_KEY[key].group : MCX_KEYS.has(key) ? 'MCX' : 'Index';
}

// Table sections, in display order. Sorting reorders rows within a section only,
// so the borders/headers never move.
const SECTIONS = [
  { id: 'india',  title: 'Indian Markets',   sub: 'NSE indices, India VIX, MCX crude' },
  { id: 'global', title: 'Global Indices',   sub: 'US, Asia, Europe' },
  { id: 'bonds',  title: 'Bonds & Currency', sub: 'US Treasury yields, Dollar Index' },
] as const;
type SectionId = typeof SECTIONS[number]['id'];

function sectionOf(key: string): SectionId {
  const g = GLOBAL_BY_KEY[key];
  if (!g) return 'india';
  return g.group === 'Bond yield' || g.group === 'Currency' ? 'bonds' : 'global';
}

const COLS = 14;

// Fixed column widths (px) so every numeric column is the same width and the
// layout doesn't shift as live values change length. Order = header order.
const COL_WIDTHS = [150, 82, 98, 98, 98, 98, 98, 98, 140, 78, 78, 78, 150, 128];
const TABLE_MIN_W = COL_WIDTHS.reduce((a, b) => a + b, 0);

// Direction arrow for the table's change columns; flat/unknown renders nothing
// but keeps the column width so numbers stay aligned.
function DirArrow({ v }: { v: number | null }) {
  if (v === null || v === 0) return <span aria-hidden className="inline-block w-3.5" />;
  const Icon = v > 0 ? ArrowUp : ArrowDown;
  return <Icon aria-label={v > 0 ? 'Up' : 'Down'} role="img" className={cn('inline-block h-3.5 w-3.5 shrink-0', v > 0 ? 'text-emerald-400' : 'text-red-400')} />;
}

const toneOf = (n: number | null) => (n === null || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : 'text-red-400');
const signed = (n: number, d = 2) => `${n > 0 ? '+' : ''}${n.toFixed(d)}`;

/** Move since a reference close: % for prices, basis points for yields (quoted in %). */
function sinceRef(ltp: number | null, ref: number | null | undefined, isYield: boolean): number | null {
  if (ltp === null || !ref || ref <= 0) return null;
  return isYield ? (ltp - ref) * 100 : (ltp / ref - 1) * 100;
}

function PerfCell({ v, isYield }: { v: number | null; isYield: boolean }) {
  if (v === null) return <span className="text-zinc-600">—</span>;
  return (
    <span className={cn('tabular-nums', toneOf(v))}>
      {isYield ? `${signed(v, 1)} bp` : `${signed(v)}%`}
    </span>
  );
}

const STATE_UI: Record<MarketState, { label: string; dot: string; text: string }> = {
  live:   { label: 'Live',     dot: 'bg-emerald-400 animate-pulse', text: 'text-emerald-400' },
  pre:    { label: 'Pre-open', dot: 'bg-amber-400',                 text: 'text-amber-400' },
  stale:  { label: 'Stale',    dot: 'bg-rose-400',                  text: 'text-rose-400' },
  closed: { label: 'Closed',   dot: 'bg-zinc-500',                  text: 'text-zinc-400' },
};

function MarketsTable({ rows, globalQuotes, loaded, now, feedStale }: {
  rows: TableRow[]; globalQuotes: Record<string, { source: string; ts?: number }>; loaded: boolean;
  now: number; feedStale: boolean;
}) {
  const [sort, setSort] = useState<{ key: SortKey; dir: SortDir } | null>(null);
  const clickSort = (key: SortKey) =>
    setSort(prev => (prev?.key === key ? (prev.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: 'desc' }));
  const dirOf = (key: SortKey) => (sort?.key === key ? sort.dir : null);
  const history = useMarketHistory();

  const enriched = useMemo(() => rows.map(r => {
    const q = r.quote && r.quote.ltp > 0 ? r.quote : null;
    const g = GLOBAL_BY_KEY[r.key];
    const isYield = g?.unit === '%';
    const h: MarketHistory | undefined = history[r.key];
    const ltp = q?.ltp ?? null;
    const prev = q && q.prev_close > 0 ? q.prev_close : null;
    // Yield change in basis points; everything else in points.
    const chg = q && prev ? (isYield ? (q.ltp - prev) * 100 : q.ltp - prev) : null;
    const hi = q?.day_high ?? null;
    const lo = q?.day_low ?? null;
    // Where LTP sits inside today's range: 0 = at the low, 100 = at the high.
    const range = q && hi !== null && lo !== null && hi > lo ? ((q.ltp - lo) / (hi - lo)) * 100 : null;
    // 52-week window = CSV history extended by the live price.
    const hi52 = h?.hi52 != null && ltp !== null ? Math.max(h.hi52, ltp) : null;
    const lo52 = h?.lo52 != null && ltp !== null ? Math.min(h.lo52, ltp) : null;
    const pos52 = hi52 !== null && lo52 !== null && hi52 > lo52 && ltp !== null ? ((ltp - lo52) / (hi52 - lo52)) * 100 : null;
    const fromHigh = hi52 !== null && ltp !== null ? (ltp / hi52 - 1) * 100 : null;

    let state: MarketState; let age: string | null = null;
    if (g) {
      const gq = globalQuotes[r.key];
      state = globalMarketState(now, gq?.ts, gq?.source === 'yahoo-live');
      if (gq?.ts) age = fmtAge(now, gq.ts);
    } else {
      state = indianMarketState(now, MCX_KEYS.has(r.key), feedStale);
    }
    return { ...r, q, group: groupOf(r.key), unit: g?.unit ?? '', isYield, chg, hi, lo, range,
      pct: q?.change_pct ?? null, prev, ltp, pos52, fromHigh, state, age,
      w1: sinceRef(ltp, h?.c1w, isYield), m1: sinceRef(ltp, h?.c1m, isYield), ytd: sinceRef(ltp, h?.cytd, isYield),
      feed: g ? (globalQuotes[r.key]?.source === 'yahoo-live' ? 'Yahoo · live' : 'Yahoo · EOD') : 'Dhan' };
  }), [rows, globalQuotes, history, now, feedStale]);

  const sortedAll = useMemo(() => {
    if (!sort) return enriched;
    const val = (r: typeof enriched[number]): number | string | null => {
      switch (sort.key) {
        case 'label': return r.label;
        case 'group': return r.group;
        case 'ltp': return r.ltp;
        case 'chg': return r.chg;
        case 'pct': return r.pct;
        case 'prev': return r.prev;
        case 'high': return r.hi;
        case 'low': return r.lo;
        case 'range': return r.range;
        case 'w1': return r.w1;
        case 'm1': return r.m1;
        case 'ytd': return r.ytd;
        case 'w52': return r.fromHigh;
      }
    };
    const m = sort.dir === 'asc' ? 1 : -1;
    return [...enriched].sort((a, b) => {
      const x = val(a), y = val(b);
      if (x === null && y === null) return 0;
      if (x === null) return 1;   // missing values always last
      if (y === null) return -1;
      return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * m;
    });
  }, [enriched, sort]);

  const sections = useMemo(
    () => SECTIONS.map(sec => ({ ...sec, rows: sortedAll.filter(r => sectionOf(r.key) === sec.id) }))
      .filter(sec => sec.rows.length > 0),
    [sortedAll],
  );

  const fmtUnit = (n: number | null, unit: string) => (n === null ? '—' : `${fmtPrice(n)}${unit}`);
  const hd = 'px-3 py-2.5';

  return (
    <div className="rounded-2xl border border-white/10 bg-zinc-900/40 backdrop-blur-xl shadow-lg shadow-black/20 overflow-x-auto">
      <table className="w-full table-fixed border-collapse" style={{ minWidth: TABLE_MIN_W }}>
        <colgroup>
          {COL_WIDTHS.map((w, i) => <col key={i} style={{ width: w }} />)}
        </colgroup>
        <thead>
          <tr>
            <TH onClick={() => clickSort('label')} sortDir={dirOf('label')} className={hd}>Market</TH>
            <TH onClick={() => clickSort('group')} sortDir={dirOf('group')} className={hd}>Type</TH>
            <TH right onClick={() => clickSort('ltp')} sortDir={dirOf('ltp')} className={hd}>LTP</TH>
            <TH right onClick={() => clickSort('chg')} sortDir={dirOf('chg')} className={hd}>Chg</TH>
            <TH right onClick={() => clickSort('pct')} sortDir={dirOf('pct')} className={hd}>Chg %</TH>
            <TH right onClick={() => clickSort('prev')} sortDir={dirOf('prev')} className={hd}>Prev Close</TH>
            <TH right onClick={() => clickSort('high')} sortDir={dirOf('high')} className={hd}>Day High</TH>
            <TH right onClick={() => clickSort('low')} sortDir={dirOf('low')} className={hd}>Day Low</TH>
            <TH onClick={() => clickSort('range')} sortDir={dirOf('range')} className={hd}>Day Range</TH>
            <TH right onClick={() => clickSort('w1')} sortDir={dirOf('w1')} className={hd}>1W</TH>
            <TH right onClick={() => clickSort('m1')} sortDir={dirOf('m1')} className={hd}>1M</TH>
            <TH right onClick={() => clickSort('ytd')} sortDir={dirOf('ytd')} className={hd}>YTD</TH>
            <TH onClick={() => clickSort('w52')} sortDir={dirOf('w52')} className={hd}>52W Range</TH>
            <TH className={hd}>Status</TH>
          </tr>
        </thead>
        {sections.map(sec => (
        <tbody key={sec.id} className="border-t-2 border-zinc-600">
          <tr>
            <th colSpan={COLS} scope="colgroup" className="px-3 py-2 text-left bg-zinc-800/70">
              <span className="text-xs font-bold uppercase tracking-[0.15em] text-zinc-100">{sec.title}</span>
              <span className="ml-2 text-[11px] font-medium normal-case tracking-normal text-zinc-400">
                {sec.sub} · {sec.rows.length}
              </span>
            </th>
          </tr>
          {sec.rows.map(r => {
            const ui = STATE_UI[r.state];
            return (
            <tr key={r.key} className="border-t border-white/5 hover:bg-zinc-800/40 transition-colors">
              <TD className="px-3 py-2 font-sans font-semibold text-zinc-100">
                <Link href={`/markets/${r.key}`} className="hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500 rounded">{r.label}</Link>
              </TD>
              <TD className="px-3 py-2 text-zinc-400 font-sans">{r.group}</TD>
              <TD right className="px-3 py-2 font-bold text-zinc-100 tabular-nums">{fmtUnit(r.ltp, r.unit)}</TD>
              <TD right className={cn('px-3 py-2 tabular-nums', toneOf(r.chg))}>
                <div className="flex items-center justify-end gap-1">
                  <DirArrow v={r.chg} />
                  <span>{r.chg === null ? '—' : r.isYield ? `${signed(r.chg, 1)} bp` : signed(r.chg)}</span>
                </div>
              </TD>
              <TD right className="px-3 py-2">
                <div className="flex items-center justify-end gap-1">
                  <DirArrow v={r.pct} />
                  <PctPill v={r.pct} />
                </div>
              </TD>
              <TD right className="px-3 py-2 text-zinc-300 tabular-nums">{fmtUnit(r.prev, r.unit)}</TD>
              <TD right className="px-3 py-2 text-emerald-400 tabular-nums">{fmtUnit(r.hi, r.unit)}</TD>
              <TD right className="px-3 py-2 text-red-400 tabular-nums">{fmtUnit(r.lo, r.unit)}</TD>
              <TD className="px-3 py-2">
                <RangeBar pct={r.range} title={r.range === null ? undefined : `${r.range.toFixed(0)}% of today's range`} />
              </TD>
              <TD right className="px-3 py-2"><PerfCell v={r.w1} isYield={r.isYield} /></TD>
              <TD right className="px-3 py-2"><PerfCell v={r.m1} isYield={r.isYield} /></TD>
              <TD right className="px-3 py-2"><PerfCell v={r.ytd} isYield={r.isYield} /></TD>
              <TD className="px-3 py-2">
                <RangeBar pct={r.pos52}
                  label={r.fromHigh === null ? undefined : `${r.fromHigh.toFixed(1)}%`}
                  title={r.pos52 === null ? undefined : `${r.fromHigh?.toFixed(1)}% from 52-week high · ${r.pos52.toFixed(0)}% of 52-week range`} />
              </TD>
              <TD className="px-3 py-2 font-sans" >
                <div title={`${r.feed}${r.age ? ` · last tick ${r.age}` : ''}`} className="flex items-center gap-1.5">
                  <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', ui.dot)} />
                  <span className={cn('text-[11px] font-bold', ui.text)}>{ui.label}</span>
                  {r.age && r.state !== 'live' && <span className="text-[11px] text-zinc-500">{r.age}</span>}
                </div>
              </TD>
            </tr>
            );
          })}
        </tbody>
        ))}
        {!loaded && (
          <tbody>
            <tr><td colSpan={COLS} className="px-3 py-6 text-center text-sm text-zinc-500">Loading…</td></tr>
          </tbody>
        )}
      </table>
    </div>
  );
}

// Position of the last price inside a range (0 = low, 100 = high).
function RangeBar({ pct, label, title }: { pct: number | null; label?: string; title?: string }) {
  if (pct === null) return <span className="text-zinc-600">—</span>;
  return (
    <div className="flex items-center gap-2" title={title}>
      <div className="relative h-1.5 w-16 shrink-0 rounded-full bg-zinc-700">
        <span className="absolute top-1/2 h-2.5 w-1 -translate-y-1/2 rounded-sm bg-sky-400" style={{ left: `calc(${Math.min(100, Math.max(0, pct))}% - 2px)` }} />
      </div>
      <span className="text-[11px] text-zinc-400 tabular-nums w-11">{label ?? `${pct.toFixed(0)}%`}</span>
    </div>
  );
}
