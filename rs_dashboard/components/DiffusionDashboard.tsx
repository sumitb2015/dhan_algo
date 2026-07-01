'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import type { DiffusionResponse } from '@/app/api/diffusion/route';
import NavBar from './NavBar';

// ─── Indicator catalogue ──────────────────────────────────────────────────────

type SeriesKey = keyof Omit<DiffusionResponse, 'dates' | 'indexSeries' | 'dataDate' | 'universe' | 'totalScanned'>;

interface IndicatorItem {
  key: SeriesKey;
  label: string;
}

interface Category {
  label: string;
  items: IndicatorItem[];
}

const CATEGORIES: Category[] = [
  {
    label: 'Simple Moving Average',
    items: [
      { key: 'pctAboveSma20',  label: '% of Stocks Above 20 SMA' },
      { key: 'pctAboveSma50',  label: '% of Stocks Above 50 SMA' },
      { key: 'pctAboveSma100', label: '% of Stocks Above 100 SMA' },
      { key: 'pctAboveSma200', label: '% of Stocks Above 200 SMA' },
    ],
  },
  {
    label: 'MACD',
    items: [{ key: 'pctMacdBullish', label: '% of Stocks With MACD Buy' }],
  },
  {
    label: 'RSI',
    items: [{ key: 'pctRsiAbove50', label: '% of Stocks With RSI ≥ 50' }],
  },
  {
    label: 'ADX',
    items: [{ key: 'pctAdxAbove25', label: '% of Stocks With ADX > 25' }],
  },
  {
    label: 'Periodical Highs — 9-day Avg',
    items: [
      { key: 'new1MHighPct9d', label: 'New 1-Month Highs' },
      { key: 'new1QHighPct9d', label: 'New 1-Quarter Highs' },
      { key: 'new1YHighPct9d', label: 'New 1-Year Highs' },
    ],
  },
  {
    label: 'Periodical Lows — 9-day Avg',
    items: [
      { key: 'new1MLowPct9d', label: 'New 1-Month Lows' },
      { key: 'new1QLowPct9d', label: 'New 1-Quarter Lows' },
      { key: 'new1YLowPct9d', label: 'New 1-Year Lows' },
    ],
  },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Sample at most maxPts evenly from an array (keeps first & last). */
function sampleDates(dates: string[], maxPts = 600): number[] {
  const n = dates.length;
  if (n <= maxPts) return dates.map((_, i) => i);
  const step = (n - 1) / (maxPts - 1);
  const out: number[] = [];
  for (let k = 0; k < maxPts; k++) out.push(Math.round(k * step));
  return out;
}

function formatDate(iso: string): string {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[parseInt(m, 10) - 1]}`;
}

function formatYear(iso: string): string {
  return iso ? iso.slice(0, 4) : '';
}

// X-axis tick: show abbreviated date, but print year only at year boundaries
function buildXAxisTicks(dates: string[], sampleIdx: number[]): { idx: number; label: string }[] {
  const ticks: { idx: number; label: string }[] = [];
  const total = sampleIdx.length;
  const every = Math.max(1, Math.floor(total / 8));
  let lastYear = '';
  sampleIdx.forEach((di, si) => {
    if (si % every !== 0 && si !== total - 1) return;
    const year = formatYear(dates[di]);
    const label = year !== lastYear ? year : formatDate(dates[di]);
    lastYear = year;
    ticks.push({ idx: di, label });
  });
  return ticks;
}

// ─── Custom Tooltip ───────────────────────────────────────────────────────────

function IndexTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs">
      <div className="text-zinc-400">{label}</div>
      <div className="text-emerald-300 font-bold">{payload[0].value.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</div>
    </div>
  );
}

function IndicatorTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { value: number }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded px-3 py-1.5 text-xs">
      <div className="text-zinc-400">{label}</div>
      <div className="font-bold text-sky-300">{payload[0].value.toFixed(1)}%</div>
    </div>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function DiffusionDashboard() {
  const [universe, setUniverse] = useState<'nifty50' | 'nifty500'>('nifty50');
  const [selectedKey, setSelectedKey] = useState<SeriesKey>('pctAboveSma20');
  const [data, setData] = useState<DiffusionResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Find current item metadata
  const selectedItem = useMemo(() => {
    for (const cat of CATEGORIES) {
      const item = cat.items.find((it) => it.key === selectedKey);
      if (item) return item;
    }
    return null;
  }, [selectedKey]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/diffusion?index=${universe}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json: DiffusionResponse = await res.json();
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [universe]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Build chart data
  const { indexChartData, indicatorChartData, xTicks } = useMemo(() => {
    if (!data) return { indexChartData: [], indicatorChartData: [], xTicks: [] };

    const idxs = sampleDates(data.dates, 600);
    const ticks = buildXAxisTicks(data.dates, idxs);
    const series = data[selectedKey] as number[];

    const indexCD = idxs.map((di) => ({
      date: data.dates[di],
      label: formatDate(data.dates[di]),
      value: data.indexSeries[di],
    }));
    const indicatorCD = idxs.map((di) => ({
      date: data.dates[di],
      label: formatDate(data.dates[di]),
      value: Number(series[di].toFixed(2)),
    }));

    return { indexChartData: indexCD, indicatorChartData: indicatorCD, xTicks: ticks };
  }, [data, selectedKey]);

  const toggleCat = (label: string) =>
    setCollapsed((prev) => ({ ...prev, [label]: !prev[label] }));


  return (
    <div className="flex flex-col h-screen bg-black text-white overflow-hidden">
      {/* ── Header ── */}
      <div className="sticky top-0 z-20 bg-black border-b border-zinc-800 px-4 py-2 flex items-center gap-4 flex-shrink-0 flex-wrap">
        <span className="text-sm font-bold text-white whitespace-nowrap">Diffusion Indicators</span>
        <NavBar />

        {/* Index selector */}
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-lg p-0.5">
          {(['nifty50', 'nifty500'] as const).map((u) => (
            <button
              key={u}
              onClick={() => setUniverse(u)}
              className={`px-3 py-1 text-xs font-bold rounded-md transition-all ${
                universe === u
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-zinc-400 hover:text-white'
              }`}
            >
              {u === 'nifty50' ? 'Nifty 50' : 'Nifty 500'}
            </button>
          ))}
        </div>

        {data && (
          <span className="text-xs font-bold text-zinc-500 bg-zinc-900 border border-zinc-700 rounded px-2 py-0.5">
            DATA: {data.dataDate}
          </span>
        )}
        {data && (
          <span className="text-xs text-zinc-600 ml-auto">
            {data.totalScanned} stocks
          </span>
        )}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* ── Left panel ── */}
        <div className="w-56 flex-shrink-0 border-r border-zinc-800 overflow-y-auto bg-zinc-950">
          {CATEGORIES.map((cat) => {
            const open = !collapsed[cat.label];
            return (
              <div key={cat.label} className="border-b border-zinc-800">
                <button
                  onClick={() => toggleCat(cat.label)}
                  className="w-full flex items-center justify-between px-3 py-2 text-xs font-bold text-zinc-300 hover:text-white hover:bg-zinc-900 transition-colors"
                >
                  <span>{cat.label}</span>
                  <svg
                    className={`w-3 h-3 transition-transform ${open ? '' : '-rotate-90'}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {open && (
                  <div className="pb-1">
                    {cat.items.map((item) => {
                      const active = item.key === selectedKey;
                      return (
                        <button
                          key={item.key}
                          onClick={() => setSelectedKey(item.key)}
                          className={`w-full text-left px-4 py-1.5 text-xs transition-colors ${
                            active
                              ? 'bg-zinc-800 text-white font-semibold border-l-2 border-emerald-500'
                              : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
                          }`}
                        >
                          {item.label}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* ── Chart area ── */}
        <div className="flex-1 flex flex-col overflow-hidden relative">
          {loading && (
            <div className="absolute inset-0 z-10 bg-black/60 flex flex-col items-center justify-center gap-2">
              <div className="w-6 h-6 border-2 border-emerald-500 border-t-transparent rounded-full animate-spin" />
              {universe === 'nifty500' && (
                <span className="text-xs text-zinc-400">Computing 500 stocks… this may take a few seconds</span>
              )}
            </div>
          )}
          {error && (
            <div className="absolute inset-0 z-10 flex items-center justify-center">
              <div className="bg-red-900/40 border border-red-700 text-red-300 text-xs px-4 py-3 rounded-lg">
                {error}
              </div>
            </div>
          )}

          {/* Index chart */}
          <div className="flex-1 border-b border-zinc-800 px-2 pt-2">
            <div className="text-xs font-bold text-zinc-400 px-2 pb-1">
              {universe === 'nifty50' ? 'NIFTY 50' : 'NIFTY 500'} — Daily
            </div>
            <ResponsiveContainer width="100%" height="90%">
              <LineChart data={indexChartData} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  ticks={xTicks.map((t) => data?.dates[t.idx] ?? '')}
                  tickFormatter={(v) => {
                    const tick = xTicks.find((t) => data?.dates[t.idx] === v);
                    return tick?.label ?? formatDate(v);
                  }}
                  interval="preserveStartEnd"
                  axisLine={{ stroke: '#3f3f46' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  width={56}
                  domain={['auto', 'auto']}
                  tickFormatter={(v: number) => v.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                />
                <Tooltip content={<IndexTooltip />} />
                <Line
                  dataKey="value"
                  stroke="#10b981"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3, fill: '#10b981' }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Indicator chart */}
          <div className="flex-1 px-2 pt-2 pb-2">
            <div className="text-xs font-bold text-zinc-400 px-2 pb-1">
              {selectedItem?.label ?? ''} — {universe === 'nifty50' ? 'Nifty 50' : 'Nifty 500'}
            </div>
            <ResponsiveContainer width="100%" height="90%">
              <LineChart data={indicatorChartData} margin={{ top: 4, right: 16, bottom: 4, left: 8 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="date"
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  ticks={xTicks.map((t) => data?.dates[t.idx] ?? '')}
                  tickFormatter={(v) => {
                    const tick = xTicks.find((t) => data?.dates[t.idx] === v);
                    return tick?.label ?? formatDate(v);
                  }}
                  interval="preserveStartEnd"
                  axisLine={{ stroke: '#3f3f46' }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  width={40}
                  tickFormatter={(v: number) => v.toFixed(0)}
                  domain={[0, 'auto']}
                />
                <Tooltip content={<IndicatorTooltip />} />
                <Line
                  dataKey="value"
                  stroke="#0ea5e9"
                  strokeWidth={1.5}
                  dot={false}
                  activeDot={{ r: 3, fill: '#0ea5e9' }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
