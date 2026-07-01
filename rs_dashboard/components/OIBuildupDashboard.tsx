'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
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
  const sorted = [...rows].sort((a, b) => {
    const av = a[sortKey] as string | number;
    const bv = b[sortKey] as string | number;
    const cmp = av < bv ? -1 : av > bv ? 1 : 0;
    return sortDir === 'asc' ? cmp : -cmp;
  });

  const arrow = (k: SortKey) => sortKey === k ? (sortDir === 'asc' ? ' ↑' : ' ↓') : '';

  const thCls =
    'px-3 py-2 text-left text-xs font-bold text-white cursor-pointer select-none ' +
    'hover:text-zinc-200 transition-colors whitespace-nowrap';
  const thRCls = thCls + ' text-right';

  return (
    <div className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden flex flex-col">
      <div className="px-4 py-3 border-b border-zinc-800">
        <span className="text-sm font-bold text-zinc-100">{title}</span>
      </div>
      <div className="overflow-y-auto" style={{ maxHeight: 280 }}>
        <table className="w-full text-[12px] border-collapse">
          <thead className="sticky top-0 bg-zinc-800">
            <tr>
              <th className={thCls}    onClick={() => onSort('symbol')}>SYMBOL{arrow('symbol')}</th>
              <th className={thRCls}   onClick={() => onSort('price')}>PRICE{arrow('price')}</th>
              <th className={thRCls}   onClick={() => onSort('priceChgPct')}>CHANGE%{arrow('priceChgPct')}</th>
              <th className={thRCls}   onClick={() => onSort('oi')}>OI{arrow('oi')}</th>
              <th className={thRCls}   onClick={() => onSort('oiChgPct')}>CHANGE OI%{arrow('oiChgPct')}</th>
            </tr>
          </thead>
          <tbody>
            {sorted.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-zinc-600 text-[11px]">
                  No data
                </td>
              </tr>
            ) : sorted.map(r => (
              <tr
                key={r.symbol}
                className="border-t border-zinc-800/50 hover:bg-zinc-800/30 transition-colors"
              >
                <td className="px-3 py-2 font-semibold text-zinc-100">{r.symbol}</td>
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
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function OIBuildupDashboard({ refreshKey }: { refreshKey: number }) {
  const [data, setData]       = useState<OIBuildupResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('oiChgPct');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

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

  useEffect(() => { fetchData(); }, [fetchData, refreshKey]);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir('desc');
    }
  };

  if (loading) return (
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

  const quadrants: { title: string; rows: OIRow[] }[] = [
    { title: `Long Buildup (${data.longBuildup.length})`,   rows: data.longBuildup },
    { title: `Short Buildup (${data.shortBuildup.length})`, rows: data.shortBuildup },
    { title: `Short Covering (${data.shortCovering.length})`, rows: data.shortCovering },
    { title: `Long Unwinding (${data.longUnwinding.length})`, rows: data.longUnwinding },
  ];

  return (
    <div>
      {data.dataDate && (
        <p className="text-[10px] text-zinc-500 mb-3 font-medium">DATA: {data.dataDate}</p>
      )}
      <div className="grid grid-cols-2 gap-4">
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
