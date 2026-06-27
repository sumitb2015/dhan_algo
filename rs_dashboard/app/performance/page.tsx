'use client';

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import { TrendingUp, RefreshCw, Search, ChevronUp, ChevronDown, Loader2, AlertCircle } from 'lucide-react';
import { NIFTY50_SET } from '@/lib/nifty50';
import type { MoverResult, MoversResponse } from '@/app/api/movers/route';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pctColor(v: number | null | undefined): string {
  if (v == null) return 'text-zinc-400';
  if (v > 0) return 'text-emerald-300';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}

function pctFmt(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(decimals) + '%';
}

function numFmt(v: number | null | undefined, decimals = 2): string {
  if (v == null) return '—';
  return v.toFixed(decimals);
}

function rsiColor(v: number): string {
  if (v >= 70) return 'text-red-300';
  if (v <= 30) return 'text-emerald-300';
  return 'text-zinc-100';
}

function pctFrom(close: number, ma: number): number | null {
  if (!ma || ma === 0) return null;
  return ((close - ma) / ma) * 100;
}

// ─── Column definitions ───────────────────────────────────────────────────────

type ColKey =
  | 'symbol' | 'sector' | 'price'
  | '1d' | '1w' | '1m' | '3m' | '1y'
  | 'rsi'
  | 'high52w' | 'from52wH' | 'from52wL'
  | 'from50dma' | 'from200dma';

interface Col {
  key: ColKey;
  label: string;
  title?: string;
  align: 'left' | 'right';
  render: (row: MoverResult) => React.ReactNode;
  sortVal: (row: MoverResult) => number | string;
}

const COLS: Col[] = [
  {
    key: 'symbol',
    label: 'Symbol',
    align: 'left',
    render: row => <span className="font-semibold text-zinc-100">{row.symbol}</span>,
    sortVal: row => row.symbol,
  },
  {
    key: 'sector',
    label: 'Sector',
    align: 'left',
    render: row => <span className="text-zinc-300 text-[11px]">{row.sector || '—'}</span>,
    sortVal: row => row.sector || '',
  },
  {
    key: 'price',
    label: 'Price',
    align: 'right',
    render: row => <span className="text-white">{numFmt(row.latestClose)}</span>,
    sortVal: row => row.latestClose,
  },
  {
    key: '1d',
    label: '1D %',
    align: 'right',
    render: row => <span className={pctColor(row.priceChange1D)}>{pctFmt(row.priceChange1D)}</span>,
    sortVal: row => row.priceChange1D,
  },
  {
    key: '1w',
    label: '1W %',
    align: 'right',
    render: row => <span className={pctColor(row.priceChange1W)}>{pctFmt(row.priceChange1W)}</span>,
    sortVal: row => row.priceChange1W,
  },
  {
    key: '1m',
    label: '1M %',
    align: 'right',
    render: row => <span className={pctColor(row.priceChange1M)}>{pctFmt(row.priceChange1M)}</span>,
    sortVal: row => row.priceChange1M,
  },
  {
    key: '3m',
    label: '3M %',
    align: 'right',
    render: row => <span className={pctColor(row.priceChange3M)}>{pctFmt(row.priceChange3M)}</span>,
    sortVal: row => row.priceChange3M,
  },
  {
    key: '1y',
    label: '1Y %',
    align: 'right',
    render: row => <span className={pctColor(row.priceChange1Y)}>{pctFmt(row.priceChange1Y)}</span>,
    sortVal: row => row.priceChange1Y,
  },
  {
    key: 'rsi',
    label: 'RSI 14',
    align: 'right',
    render: row => <span className={rsiColor(row.rsi14)}>{numFmt(row.rsi14, 1)}</span>,
    sortVal: row => row.rsi14,
  },
  {
    key: 'high52w',
    label: '52W High',
    align: 'right',
    render: row => <span className="text-zinc-200">{numFmt(row.high52W)}</span>,
    sortVal: row => row.high52W,
  },
  {
    key: 'from52wH',
    label: 'vs 52W Hi',
    title: '% from 52-week high (0 = at high)',
    align: 'right',
    render: row => <span className={pctColor(row.pctFrom52WHigh)}>{pctFmt(row.pctFrom52WHigh)}</span>,
    sortVal: row => row.pctFrom52WHigh,
  },
  {
    key: 'from52wL',
    label: 'vs 52W Lo',
    title: '% from 52-week low (higher = further from bottom)',
    align: 'right',
    render: row => <span className={pctColor(row.pctFrom52WLow)}>{pctFmt(row.pctFrom52WLow)}</span>,
    sortVal: row => row.pctFrom52WLow,
  },
  {
    key: 'from50dma',
    label: 'vs 50DMA',
    title: '% above/below 50-day moving average',
    align: 'right',
    render: row => {
      const v = pctFrom(row.latestClose, row.ma50);
      return <span className={pctColor(v)}>{pctFmt(v)}</span>;
    },
    sortVal: row => pctFrom(row.latestClose, row.ma50) ?? -9999,
  },
  {
    key: 'from200dma',
    label: 'vs 200DMA',
    title: '% above/below 200-day moving average',
    align: 'right',
    render: row => {
      const v = pctFrom(row.latestClose, row.ma200);
      return <span className={pctColor(v)}>{pctFmt(v)}</span>;
    },
    sortVal: row => pctFrom(row.latestClose, row.ma200) ?? -9999,
  },
];

// ─── Table ────────────────────────────────────────────────────────────────────

type SortDir = 'asc' | 'desc';

interface TableProps {
  rows: MoverResult[];
  search: string;
}

function PerformanceTable({ rows, search }: TableProps) {
  const [sortKey, setSortKey] = useState<ColKey>('symbol');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [page, setPage] = useState(0);
  const PAGE_SIZE = 50;

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q ? rows.filter(r => r.symbol.toLowerCase().includes(q) || (r.sector || '').toLowerCase().includes(q)) : rows;
  }, [rows, search]);

  const sorted = useMemo(() => {
    const col = COLS.find(c => c.key === sortKey);
    if (!col) return filtered;
    return [...filtered].sort((a, b) => {
      const av = col.sortVal(a);
      const bv = col.sortVal(b);
      let cmp = 0;
      if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
      else cmp = String(av).localeCompare(String(bv));
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sortKey, sortDir]);

  const pages = Math.max(1, Math.ceil(sorted.length / PAGE_SIZE));
  const pageRows = sorted.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  // Reset page when filter/sort changes
  useEffect(() => setPage(0), [search, sortKey, sortDir]);

  const handleSort = (key: ColKey) => {
    if (key === sortKey) setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir(key === 'symbol' || key === 'sector' ? 'asc' : 'desc'); }
  };

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap text-xs text-zinc-300">
        <span>{sorted.length} stocks</span>
        {pages > 1 && (
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 disabled:opacity-30 hover:border-zinc-500 text-zinc-200"
            >‹</button>
            <span>{page + 1} / {pages}</span>
            <button
              onClick={() => setPage(p => Math.min(pages - 1, p + 1))}
              disabled={page >= pages - 1}
              className="px-2 py-1 rounded border border-zinc-700 bg-zinc-900 disabled:opacity-30 hover:border-zinc-500 text-zinc-200"
            >›</button>
          </div>
        )}
      </div>

      <div className="overflow-x-auto rounded-xl border border-zinc-800/60">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800 border-b border-zinc-700">
              {COLS.map(col => (
                <th
                  key={col.key}
                  title={col.title}
                  onClick={() => handleSort(col.key)}
                  className={`px-3 py-2 whitespace-nowrap cursor-pointer select-none text-xs font-bold text-white hover:text-zinc-200 transition-colors ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                >
                  <span className="inline-flex items-center gap-1">
                    {sortKey === col.key && (
                      sortDir === 'asc'
                        ? <ChevronUp className="h-3 w-3 text-sky-400" />
                        : <ChevronDown className="h-3 w-3 text-sky-400" />
                    )}
                    {col.label}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {pageRows.map((row, i) => (
              <tr
                key={row.symbol}
                className={`border-b border-zinc-900 hover:bg-zinc-900/50 transition-colors ${i % 2 === 0 ? '' : 'bg-zinc-950/30'}`}
              >
                {COLS.map(col => (
                  <td
                    key={col.key}
                    className={`px-3 py-2 whitespace-nowrap ${col.align === 'right' ? 'text-right' : 'text-left'}`}
                  >
                    {col.render(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────────────

type Tab = 'nifty50' | 'nifty500';

export default function PerformancePage() {
  const [data, setData] = useState<MoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('nifty50');
  const [search, setSearch] = useState('');

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/movers?index=nifty500');
      const json = await res.json();
      if (!json.success) throw new Error(json.error || 'API error');
      setData(json.data as MoversResponse);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const rows = useMemo(() => {
    if (!data?.allMovers) return [];
    if (tab === 'nifty50') return data.allMovers.filter(r => NIFTY50_SET.has(r.symbol));
    return data.allMovers;
  }, [data, tab]);

  const n50Count = data?.allMovers ? data.allMovers.filter(r => NIFTY50_SET.has(r.symbol)).length : 0;
  const n500Count = data?.allMovers?.length ?? 0;

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center justify-between gap-4 z-20">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-sky-500/10">
            <TrendingUp className="h-4.5 w-4.5 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Performance Table
            </h1>
            <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
              {data?.dataDate ? `Data as of ${data.dataDate}` : 'Nifty 50 · Nifty 500'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          {/* Nav */}
          <div className="flex items-center bg-zinc-900/80 border border-zinc-800 p-0.5 rounded-xl">
            <Link href="/" className="px-3 py-1.5 text-xs font-semibold rounded-lg text-zinc-300 hover:text-white transition-all">
              RS Scanner
            </Link>
            <Link href="/movers" className="px-3 py-1.5 text-xs font-semibold rounded-lg text-zinc-300 hover:text-white transition-all">
              Movers
            </Link>
            <span className="px-3 py-1.5 text-xs font-semibold rounded-lg bg-sky-500/10 text-sky-400 border border-sky-500/20">
              Performance
            </span>
            <Link href="/reports" className="px-3 py-1.5 text-xs font-semibold rounded-lg text-zinc-300 hover:text-white transition-all">
              Reports
            </Link>
            <Link href="/strategies" className="px-3 py-1.5 text-xs font-semibold rounded-lg text-zinc-300 hover:text-white transition-all">
              Strategies
            </Link>
          </div>

          <button
            onClick={fetchData}
            disabled={loading}
            className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-400 hover:text-white transition-all hover:border-zinc-700 disabled:opacity-40"
            title="Refresh data"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* ── Body ───────────────────────────────────────────────────────────── */}
      <main className="flex-1 px-5 py-6 max-w-screen-2xl mx-auto w-full">

        {/* Controls row */}
        <div className="flex items-center justify-between gap-4 mb-5 flex-wrap">

          {/* Index tabs */}
          <div className="flex items-center gap-1 p-1 bg-zinc-900/60 border border-zinc-800 rounded-xl">
            <button
              onClick={() => { setTab('nifty50'); setSearch(''); }}
              className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                tab === 'nifty50'
                  ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                  : 'text-zinc-300 hover:text-white'
              }`}
            >
              Nifty 50
              <span className="ml-1.5 text-[10px] opacity-60">{n50Count}</span>
            </button>
            <button
              onClick={() => { setTab('nifty500'); setSearch(''); }}
              className={`px-4 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                tab === 'nifty500'
                  ? 'bg-sky-500/10 text-sky-400 border border-sky-500/20'
                  : 'text-zinc-300 hover:text-white'
              }`}
            >
              Nifty 500
              <span className="ml-1.5 text-[10px] opacity-60">{n500Count}</span>
            </button>
          </div>

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-500" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Filter symbol or sector…"
              className="pl-8 pr-3 py-1.5 text-xs bg-zinc-900 border border-zinc-800 rounded-lg text-zinc-200 placeholder-zinc-600 focus:outline-none focus:border-zinc-600 w-52"
            />
          </div>
        </div>

        {/* Stat pills */}
        {data && data.allMovers && !loading && (
          <div className="flex items-center gap-3 mb-4 flex-wrap">
            {(() => {
              const subset = tab === 'nifty50'
                ? data.allMovers.filter(r => NIFTY50_SET.has(r.symbol))
                : data.allMovers;
              const gainers = subset.filter(r => r.priceChange1D > 0).length;
              const losers  = subset.filter(r => r.priceChange1D < 0).length;
              const aboveMA200 = subset.filter(r => r.aboveMa200).length;
              const aboveAllMAs = subset.filter(r => r.aboveMa20 && r.aboveMa50 && r.aboveMa200).length;
              return (
                <>
                  <span className="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[11px] font-semibold">
                    ↑ {gainers} up
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-[11px] font-semibold">
                    ↓ {losers} down
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-semibold">
                    {aboveMA200} above 200DMA
                  </span>
                  <span className="px-2.5 py-1 rounded-lg bg-zinc-800 border border-zinc-700 text-zinc-300 text-[11px] font-semibold">
                    {aboveAllMAs} above all MAs
                  </span>
                </>
              );
            })()}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-24 text-zinc-300 gap-2">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Computing performance metrics…</span>
          </div>
        ) : error ? (
          <div className="flex items-center justify-center py-24 text-red-400 gap-2">
            <AlertCircle className="h-5 w-5" />
            <span className="text-sm">{error}</span>
          </div>
        ) : (
          <PerformanceTable rows={rows} search={search} />
        )}
      </main>
    </div>
  );
}
