'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import Link from 'next/link';
import { Loader2, AlertCircle, Search, Flame, ExternalLink, SlidersHorizontal, ArrowUpDown } from 'lucide-react';
import type { OIRow, OIBuildupResponse } from '@/app/api/futures-oi/route';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtLakh(v: number): string {
  if (v >= 10000000) return (v / 10000000).toFixed(2) + 'Cr';
  if (v >= 100000)   return (v / 100000).toFixed(1) + 'L';
  if (v >= 1000)     return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(0);
}

function fmtPct(v: number): string {
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

// ─── Sortable quadrant table ──────────────────────────────────────────────────

type SortKey = keyof OIRow;

const QUADRANT_META: Record<string, { eyebrow: string; accent: string; dot: string; actionCls: string }> = {
  'Long Buildup': {
    eyebrow: 'Price ▲ · OI ▲ (Institutional Accumulation)',
    accent: 'border-emerald-500/20',
    dot: 'bg-emerald-400',
    actionCls: 'bg-emerald-600/90 hover:bg-emerald-500 text-oncolor',
  },
  'Short Buildup': {
    eyebrow: 'Price ▼ · OI ▲ (Institutional Shorting)',
    accent: 'border-red-500/20',
    dot: 'bg-red-400',
    actionCls: 'bg-rose-600/90 hover:bg-rose-500 text-oncolor',
  },
  'Short Covering': {
    eyebrow: 'Price ▲ · OI ▼ (Bear Squeeze Scalp)',
    accent: 'border-sky-500/20',
    dot: 'bg-sky-400',
    actionCls: 'bg-sky-600/90 hover:bg-sky-500 text-oncolor',
  },
  'Long Unwinding': {
    eyebrow: 'Price ▼ · OI ▼ (Liquidation Dump)',
    accent: 'border-amber-500/20',
    dot: 'bg-amber-400',
    actionCls: 'bg-amber-600/90 hover:bg-amber-500 text-oncolor',
  },
};

function QuadrantTable({
  title,
  rows,
  sortKey,
  sortDir,
  onSort,
}: {
  title: string;
  rows: OIRow[];
  sortKey: SortKey;
  sortDir: 'asc' | 'desc';
  onSort: (key: SortKey) => void;
}) {
  const sorted = useMemo(() => {
    return [...rows].sort((a, b) => {
      const av = a[sortKey] as string | number;
      const bv = b[sortKey] as string | number;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sortKey, sortDir]);

  const arrow = (k: SortKey) => sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';
  const baseName = title.replace(/\s*\(\d+\)$/, '');
  const meta = QUADRANT_META[baseName] ?? {
    eyebrow: '',
    accent: 'border-zinc-800',
    dot: 'bg-zinc-400',
    actionCls: 'bg-zinc-800 hover:bg-zinc-700 text-white',
  };

  const thCls =
    'px-3 py-2 text-left text-xs font-bold text-white cursor-pointer select-none ' +
    'hover:text-zinc-200 transition-colors whitespace-nowrap';
  const thRCls = thCls + ' text-right';

  return (
    <div className={`rounded-2xl border bg-zinc-900/60 overflow-hidden flex flex-col ${meta.accent}`}>
      <div className="px-4 py-3 border-b border-zinc-800 flex items-center justify-between">
        <div>
          <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-0.5 flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full ${meta.dot}`} />
            {meta.eyebrow}
          </p>
          <span className="text-sm font-bold text-zinc-100">{title}</span>
        </div>
        <span className="text-[10px] font-mono text-zinc-500">
          {rows.length} scrips
        </span>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 320 }}>
        <table className="w-full text-[12px] border-collapse font-mono">
          <thead className="sticky top-0 bg-zinc-800 z-10">
            <tr>
              <th className={thCls + ' font-sans'} onClick={() => onSort('symbol')}>SYMBOL{arrow('symbol')}</th>
              <th className={thRCls} onClick={() => onSort('price')}>PRICE{arrow('price')}</th>
              <th className={thRCls} onClick={() => onSort('priceChgPct')}>CHANGE%{arrow('priceChgPct')}</th>
              <th className={thRCls} onClick={() => onSort('oi')}>OI (contracts){arrow('oi')}</th>
              <th className={thRCls} onClick={() => onSort('oiChgPct')}>OI Δ%{arrow('oiChgPct')}</th>
              <th className="px-3 py-2 text-center text-xs font-bold text-white font-sans">ACTION</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-3 py-8 text-center text-zinc-600 text-[11px] font-sans">
                  No matching contracts
                </td>
              </tr>
            ) : sorted.map(r => {
              const isHighConviction = Math.abs(r.oiChgPct) >= 4.0 && Math.abs(r.priceChgPct) >= 1.0;
              return (
                <tr
                  key={r.symbol}
                  className="border-t border-zinc-800/50 hover:bg-zinc-800/30 transition-colors"
                >
                  <td className="px-3 py-2 font-sans font-semibold text-zinc-100">
                    <div className="flex items-center gap-1.5">
                      <span>{r.symbol}</span>
                      {isHighConviction && (
                        <span title="High conviction setup: OI change ≥4% with ≥1% price move">
                          <Flame className="h-3.5 w-3.5 text-amber-400 shrink-0" />
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-200">
                    {fmtPrice(r.price)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                    r.priceChgPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {fmtPct(r.priceChgPct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-200">
                    {fmtLakh(r.oi)}
                  </td>
                  <td className={`px-3 py-2 text-right tabular-nums font-semibold ${
                    r.oiChgPct >= 0 ? 'text-emerald-400' : 'text-red-400'
                  }`}>
                    {fmtPct(r.oiChgPct)}
                  </td>
                  <td className="px-3 py-2 text-center">
                    <Link
                      href={`/scalper?symbol=${r.symbol}`}
                      className={`inline-flex items-center gap-1 px-2.5 py-1 text-[10px] font-bold rounded-lg transition-colors shadow-sm ${meta.actionCls}`}
                      title={`Execute ${r.symbol} on Scalper`}
                    >
                      Trade
                      <ExternalLink className="h-2.5 w-2.5" />
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OIBuildupDashboard({
  refreshKey,
  initialData,
}: {
  refreshKey?: number;
  initialData?: OIBuildupResponse | null;
}) {
  const [data, setData]             = useState<OIBuildupResponse | null>(initialData ?? null);
  const [loading, setLoading]       = useState(!initialData);
  const [error, setError]           = useState<string | null>(null);
  const [sortKey, setSortKey]       = useState<SortKey>('oiChgPct');
  const [sortDir, setSortDir]       = useState<'asc' | 'desc'>('desc');
  const [searchQuery, setSearchQuery] = useState('');
  const [minOiFilter, setMinOiFilter] = useState<number>(0);
  const [minPriceFilter, setMinPriceFilter] = useState<number>(0);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/futures-oi');
      const json: OIBuildupResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? 'API error');
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialData) {
      setData(initialData);
      setLoading(false);
    } else {
      fetchData();
    }
  }, [initialData, fetchData, refreshKey]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  // Filter rows across all quadrants based on search & thresholds:
  const filterRows = useCallback((rows: OIRow[]): OIRow[] => {
    return rows.filter(r => {
      if (searchQuery) {
        const query = searchQuery.toUpperCase();
        if (!r.symbol.toUpperCase().includes(query)) return false;
      }
      if (minOiFilter > 0 && Math.abs(r.oiChgPct) < minOiFilter) {
        return false;
      }
      if (minPriceFilter > 0 && Math.abs(r.priceChgPct) < minPriceFilter) {
        return false;
      }
      return true;
    });
  }, [searchQuery, minOiFilter, minPriceFilter]);

  if (loading && !data) return (
    <div className="flex items-center justify-center py-32 gap-2 text-zinc-400">
      <Loader2 className="h-5 w-5 animate-spin" />
      <span className="text-sm">Loading OI data…</span>
    </div>
  );

  if (error) return (
    <div className="flex flex-col items-center justify-center py-24 gap-3 text-zinc-400">
      <AlertCircle className="h-8 w-8" />
      <span className="text-sm text-center max-w-md">{error}</span>
    </div>
  );

  if (!data) return null;

  const filteredLongBuildup = filterRows(data.longBuildup);
  const filteredShortBuildup = filterRows(data.shortBuildup);
  const filteredShortCovering = filterRows(data.shortCovering);
  const filteredLongUnwinding = filterRows(data.longUnwinding);

  const quadrants: { title: string; rows: OIRow[] }[] = [
    { title: `Long Buildup (${filteredLongBuildup.length})`,   rows: filteredLongBuildup },
    { title: `Short Buildup (${filteredShortBuildup.length})`, rows: filteredShortBuildup },
    { title: `Short Covering (${filteredShortCovering.length})`, rows: filteredShortCovering },
    { title: `Long Unwinding (${filteredLongUnwinding.length})`, rows: filteredLongUnwinding },
  ];

  return (
    <div className="space-y-4">
      {/* ─── Search & Screener Toolbar ────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4 p-3 rounded-xl border border-zinc-800 bg-zinc-900/60 flex-wrap">
        {/* Symbol Search */}
        <div className="relative min-w-[200px] flex-1 max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-zinc-400" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search stock symbol..."
            className="w-full pl-9 pr-3 py-1.5 bg-zinc-950/80 border border-zinc-800 rounded-lg text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-sky-500/60 transition-colors"
          />
        </div>

        {/* Min OI Change Filter */}
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-zinc-400 font-medium">Min OI Δ:</span>
          {[0, 3, 5, 10].map(val => (
            <button
              key={val}
              onClick={() => setMinOiFilter(val)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                minOiFilter === val
                  ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                  : 'bg-zinc-950/60 text-zinc-400 border border-zinc-800 hover:text-white'
              }`}
            >
              {val === 0 ? 'All' : `≥ ${val}%`}
            </button>
          ))}
        </div>

        {/* Min Price Change Filter */}
        <div className="flex items-center gap-1.5 text-xs">
          <span className="text-zinc-400 font-medium">Min Price Δ:</span>
          {[0, 1, 2].map(val => (
            <button
              key={val}
              onClick={() => setMinPriceFilter(val)}
              className={`px-2.5 py-1 rounded-lg text-xs font-semibold transition-colors ${
                minPriceFilter === val
                  ? 'bg-sky-500/20 text-sky-400 border border-sky-500/30'
                  : 'bg-zinc-950/60 text-zinc-400 border border-zinc-800 hover:text-white'
              }`}
            >
              {val === 0 ? 'All' : `≥ ${val}%`}
            </button>
          ))}
        </div>
      </div>

      {data.dataDate && (
        <div className="flex items-center justify-between text-[10px] text-zinc-500 px-1">
          <span>DATA: {data.dataDate}</span>
          <span>Click any <strong>Trade</strong> button to load the contract in Scalper</span>
        </div>
      )}

      {/* ─── 4 Quadrants Grid ────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {quadrants.map(q => (
          <QuadrantTable
            key={q.title}
            title={q.title}
            rows={q.rows}
            sortKey={sortKey}
            sortDir={sortDir}
            onSort={handleSort}
          />
        ))}
      </div>
    </div>
  );
}
