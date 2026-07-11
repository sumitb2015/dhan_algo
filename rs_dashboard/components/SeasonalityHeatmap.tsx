'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { CalendarRange, Loader2 } from 'lucide-react';
import type { SeasonalityResponse, SeasonalityCell } from '@/app/api/seasonality/route';
import type { SymbolsResponse, IndexOption } from '@/app/api/symbols/route';
import { NIFTY50_SYMBOLS } from '@/lib/nifty50';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import { Card, CardContent } from './ui/card';
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxEmpty,
} from './ui/combobox';

// ─── Color scale ──────────────────────────────────────────────────────────────
// Diverging emerald (gain) ↔ red (loss) around a neutral zinc midpoint, matching
// the dashboard's established gain/loss convention. Alpha scales with magnitude.
const SCALE_CAP = 12; // % change at which the cell reaches full saturation

function cellStyle(value: number | null): React.CSSProperties {
  if (value === null) return { backgroundColor: 'rgba(63,63,70,0.25)' }; // zinc-700/25 — no data
  const alpha = Math.min(Math.abs(value) / SCALE_CAP, 1);
  const rgb = value >= 0 ? '16,185,129' : '239,68,68'; // emerald-500 / red-500
  return { backgroundColor: `rgba(${rgb},${(alpha * 0.85 + 0.08).toFixed(3)})` };
}

function cellTextClass(value: number | null): string {
  if (value === null) return 'text-zinc-500';
  const alpha = Math.min(Math.abs(value) / SCALE_CAP, 1);
  return alpha > 0.45 ? 'text-white' : value >= 0 ? 'text-emerald-300' : 'text-red-300';
}

function fmtPct(v: number | null): string {
  if (v === null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(1) + '%';
}

function fmtDate(d: string): string {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-IN', {
    day: '2-digit', month: 'short', year: 'numeric',
  });
}

function cellTitle(cell: SeasonalityCell): string | undefined {
  if (!cell.startDate || !cell.endDate) return undefined;
  return `${fmtDate(cell.startDate)} → ${fmtDate(cell.endDate)}`;
}

export default function SeasonalityHeatmap() {
  const [symbol, setSymbol] = useState('RELIANCE');
  const [data, setData] = useState<SeasonalityResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [indices, setIndices] = useState<IndexOption[]>([]);

  useEffect(() => {
    fetch('/api/symbols')
      .then((res) => res.json())
      .then((json: SymbolsResponse) => {
        if (json.success) setIndices(json.indices);
      })
      .catch(() => {});
  }, []);

  // Indices are searched/selected by their display label (e.g. "Nifty 50")
  // while stocks are searched/selected by ticker — both share one combobox.
  const indexLabelToKey = useMemo(() => new Map(indices.map((i) => [i.label, i.key])), [indices]);
  const indexKeyToLabel = useMemo(() => new Map(indices.map((i) => [i.key, i.label])), [indices]);
  const comboItems = useMemo(() => [...indices.map((i) => i.label), ...NIFTY50_SYMBOLS], [indices]);
  const displayValue = indexKeyToLabel.get(symbol) ?? symbol;

  const fetchData = useCallback(async (sym: string) => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/seasonality?symbol=${encodeURIComponent(sym)}`);
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      } else {
        setError(json.error || 'Failed to load seasonality data');
        setData(null);
      }
    } catch {
      setError('Failed to load seasonality data');
      setData(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData(symbol);
  }, [symbol, fetchData]);

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">
      {/* Sticky header */}
      <header className="sticky top-0 w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-emerald-600 to-lime-400 flex items-center justify-center shadow-lg shadow-emerald-500/10">
            <CalendarRange className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Seasonality Heatmap
            </h1>
            {data?.dataDate && (
              <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
                DATA: {data.dataDate}
              </p>
            )}
          </div>
        </div>

        <NavBar />
      </header>

      <main className="flex-1 p-5 flex flex-col gap-4">
        {/* Toolbar */}
        <div className="flex items-center gap-3 flex-wrap">
          <Combobox
            items={comboItems}
            value={displayValue}
            onValueChange={(v) => v && setSymbol(indexLabelToKey.get(v) ?? v)}
          >
            <ComboboxInput
              placeholder="Search stock or index…"
              className="w-56"
            />
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

          {/* Legend */}
          <div className="flex items-center gap-2 ml-auto text-[11px] text-zinc-400">
            <span>Loss</span>
            <div className="flex h-3 w-32 rounded-full overflow-hidden ring-1 ring-zinc-800">
              <div className="flex-1" style={{ background: 'linear-gradient(to right, rgba(239,68,68,0.93), rgba(239,68,68,0.08))' }} />
              <div className="flex-1" style={{ background: 'linear-gradient(to right, rgba(16,185,129,0.08), rgba(16,185,129,0.93))' }} />
            </div>
            <span>Gain</span>
          </div>
        </div>

        {/* Heatmap */}
        {loading && (
          <div className="flex items-center justify-center py-24">
            <Loader2 className="h-6 w-6 text-emerald-500 animate-spin" />
          </div>
        )}

        {error && !loading && (
          <div className="flex items-center justify-center py-24">
            <p className="text-sm font-semibold text-red-400">{error}</p>
          </div>
        )}

        {data && !loading && !error && (
          <Card className="p-0 gap-0 w-[70%] min-w-[720px] max-w-full">
            <CardContent className="p-0 overflow-x-auto">
              <table className="border-collapse table-fixed w-full">
                <colgroup>
                  <col className="w-[7%]" />
                  {data.months.map((m) => (
                    <col key={m} className="w-[7.75%]" />
                  ))}
                </colgroup>
                <thead>
                  <tr className="bg-zinc-800">
                    <th className="text-xs font-bold text-white text-left px-2.5 py-3 sticky left-0 bg-zinc-800 z-10 rounded-tl-xl">
                      Year
                    </th>
                    {data.months.map((m) => (
                      <th key={m} className="text-xs font-bold text-white text-center px-2 py-3">
                        {m}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.years.map((year, yIdx) => (
                    <tr key={year} className="border-t border-zinc-900">
                      <td className="text-xs font-bold text-zinc-200 px-2.5 py-3 sticky left-0 bg-zinc-950 z-10 tabular-nums">
                        {year}
                      </td>
                      {data.matrix[yIdx].map((cell, mIdx) => (
                        <td
                          key={mIdx}
                          style={cellStyle(cell.value)}
                          title={cellTitle(cell)}
                          className="px-2 py-3 text-center cursor-default"
                        >
                          <span className={cn('text-xs font-bold tabular-nums', cellTextClass(cell.value))}>
                            {fmtPct(cell.value)}
                          </span>
                        </td>
                      ))}
                    </tr>
                  ))}
                  <tr className="border-t-2 border-zinc-700 bg-zinc-900/60">
                    <td className="text-xs font-bold text-zinc-100 px-2.5 py-3 sticky left-0 bg-zinc-900 z-10 rounded-bl-xl">
                      Avg
                    </td>
                    {data.monthAverages.map((val, mIdx) => (
                      <td
                        key={mIdx}
                        style={cellStyle(val)}
                        title={`Average ${data.months[mIdx]} gain across ${data.years.length} years`}
                        className="px-2 py-3 text-center cursor-default"
                      >
                        <span className={cn('text-xs font-bold tabular-nums', cellTextClass(val))}>
                          {fmtPct(val)}
                        </span>
                      </td>
                    ))}
                  </tr>
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {data && !loading && !error && (
          <p className="text-[11px] text-zinc-500">
            Monthly gain = % change from previous month&apos;s last close to this month&apos;s last close. The current (in-progress) month uses the latest available close.
          </p>
        )}
      </main>
    </div>
  );
}
