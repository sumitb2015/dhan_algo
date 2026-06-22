'use client';

import React, { useState, useEffect } from 'react';
import { AreaChart, Area, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, ReferenceLine, ResponsiveContainer, ComposedChart } from 'recharts';
import { Calendar, RefreshCw, BarChart2, TrendingUp, Columns, Layers, Activity } from 'lucide-react';

interface ChartPoint {
  date: string;
  stockClose: number;
  indexClose: number;
  rsLine: number;
}

interface RSChartProps {
  symbol: string | null;
  indexType: 'nifty50' | 'nifty500';
  lookback: 50 | 100 | 252;
}

export default function RSChart({ symbol, indexType, lookback }: RSChartProps) {
  const [period, setPeriod] = useState<'1w' | '1m' | '3m' | '6m' | '1y' | '2y'>('1y');
  const [viewMode, setViewMode] = useState<'split' | 'overlay' | 'ratio'>('split');
  const [data, setData] = useState<ChartPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{
    currentRS: number;
    latestClose: number;
    priceChangePct: number;
    latestDate: string;
  } | null>(null);

  useEffect(() => {
    if (!symbol) return;

    const fetchChartData = async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`/api/chart/${symbol}?index=${indexType}&period=${period}&lookback=${lookback}`);
        const json = await res.json();
        if (json.success) {
          setData(json.data);
          setSummary({
            currentRS: json.currentRS,
            latestClose: json.latestClose,
            priceChangePct: json.priceChangePct,
            latestDate: json.latestDate,
          });
        } else {
          setError(json.error || 'Failed to load chart data');
        }
      } catch (err) {
        setError('Network error. Failed to retrieve chart data.');
      } finally {
        setLoading(false);
      }
    };

    fetchChartData();
  }, [symbol, indexType, period, lookback]);

  // Pre-process data to inject raw Stock / Index price ratio
  const processedData = React.useMemo(() => {
    return data.map((p) => ({
      ...p,
      rawRatio: p.indexClose > 0 ? p.stockClose / p.indexClose : 0,
    }));
  }, [data]);

  if (!symbol) {
    return (
      <div className="flex flex-col items-center justify-center rounded-2xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md p-10 text-center text-zinc-500 min-h-[350px] w-full">
        <div className="mb-4 p-3.5 rounded-full bg-zinc-900/60 border border-zinc-850 shadow-inner">
          <BarChart2 className="h-7 w-7 text-emerald-500/85 animate-pulse" />
        </div>
        <p className="text-sm font-semibold text-zinc-300">Select a Stock to Begin Analysis</p>
        <p className="text-xs text-zinc-500 max-w-sm mt-1.5 leading-relaxed">
          Choose any asset from the leaderboard table or the sector heatmap below to populate the interactive split, overlay, or ratio charts.
        </p>
      </div>
    );
  }

  const CustomTooltip = ({ active, payload }: any) => {
    if (active && payload && payload.length) {
      const point = payload[0].payload;
      const rawRatio = point.rawRatio ?? (point.indexClose > 0 ? point.stockClose / point.indexClose : 0);
      const rsLineVal = point.rsLine;
      const rsLineFormatted = `${rsLineVal >= 0 ? '+' : ''}${(rsLineVal * 100).toFixed(2)}%`;

      return (
        <div className="rounded-xl border border-zinc-800 bg-zinc-950/95 p-3.5 shadow-2xl backdrop-blur-md text-xs font-mono text-zinc-300 border-l-4 border-l-emerald-500">
          <div className="border-b border-zinc-850 pb-2 mb-2 font-sans font-bold text-white text-xs">
            {new Date(point.date).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })}
          </div>
          <div className="flex items-center justify-between gap-8 py-0.5">
            <span className="text-zinc-500 font-sans">Stock Close:</span>
            <span className="font-bold text-white">₹{point.stockClose.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex items-center justify-between gap-8 py-0.5">
            <span className="text-zinc-500 font-sans">Index Close:</span>
            <span className="text-zinc-400">₹{point.indexClose.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
          </div>
          <div className="flex items-center justify-between gap-8 py-0.5 mt-1 pt-1 border-t border-zinc-900/40">
            <span className="text-zinc-500 font-sans">RS Line ({lookback === 252 ? '52w' : `${lookback}d`}):</span>
            <span className={`font-bold ${rsLineVal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {rsLineFormatted}
            </span>
          </div>
          <div className="flex items-center justify-between gap-8 py-0.5">
            <span className="text-zinc-500 font-sans">Raw Ratio (Stock/Index):</span>
            <span className="font-bold text-purple-400">
              {rawRatio.toFixed(5)}
            </span>
          </div>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="flex flex-col rounded-2xl border border-zinc-800/80 bg-zinc-950/60 backdrop-blur-md p-6 overflow-hidden w-full shadow-lg">
      {/* Chart Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-6 pb-4 border-b border-zinc-900/60">
        <div className="flex items-start gap-3">
          <div className="p-2 bg-emerald-500/10 border border-emerald-500/20 rounded-xl text-emerald-400 mt-0.5">
            <TrendingUp className="h-5 w-5" />
          </div>
          <div>
            <div className="flex items-baseline gap-2">
              <h2 className="text-xl font-black text-white tracking-wide uppercase">{symbol}</h2>
              <span className="text-xs text-zinc-500 font-semibold font-mono">
                vs {indexType === 'nifty50' ? 'NIFTY 50 INDEX' : 'NIFTY 500 INDEX'}
              </span>
            </div>
            {summary && (
              <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mt-1 text-xs">
                <div>
                  <span className="text-zinc-500 mr-1.5">Last Price:</span>
                  <span className="font-bold text-zinc-200 font-mono">₹{summary.latestClose.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                </div>
                <div>
                  <span className="text-zinc-500 mr-1.5">Period Return:</span>
                  <span className={`font-bold font-mono ${summary.priceChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {summary.priceChangePct >= 0 ? '+' : ''}{summary.priceChangePct.toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 mr-1.5">Current RS:</span>
                  <span className={`font-bold font-mono ${summary.currentRS >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {summary.currentRS >= 0 ? '+' : ''}{(summary.currentRS * 100).toFixed(2)}%
                  </span>
                </div>
                <div>
                  <span className="text-zinc-500 mr-1.5">As Of:</span>
                  <span className="font-medium text-zinc-400 font-mono">{summary.latestDate}</span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* View Mode & Period Selector Group */}
        <div className="flex flex-wrap items-center gap-3 self-start sm:self-auto">
          {/* View Switcher */}
          <div className="flex items-center bg-zinc-900/60 border border-zinc-850 p-1 rounded-xl shadow-inner">
            <button
              onClick={() => setViewMode('split')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all duration-150 active:scale-95 ${
                viewMode === 'split'
                  ? 'bg-zinc-800 text-white border border-zinc-700 shadow'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Split View (Stacked Charts)"
            >
              <Columns className="h-3.5 w-3.5" />
              <span>Split</span>
            </button>
            <button
              onClick={() => setViewMode('overlay')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all duration-150 active:scale-95 ${
                viewMode === 'overlay'
                  ? 'bg-zinc-800 text-white border border-zinc-700 shadow'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Overlay View (Dual Axis Chart)"
            >
              <Layers className="h-3.5 w-3.5" />
              <span>Overlay</span>
            </button>
            <button
              onClick={() => setViewMode('ratio')}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all duration-150 active:scale-95 ${
                viewMode === 'ratio'
                  ? 'bg-zinc-800 text-white border border-zinc-700 shadow'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
              title="Ratio View (Simple Stock / Index Ratio)"
            >
              <Activity className="h-3.5 w-3.5" />
              <span>Stock/Index</span>
            </button>
          </div>

          {/* Period Selector */}
          <div className="flex items-center gap-1 bg-zinc-900/60 border border-zinc-850 p-1.5 rounded-xl shadow-inner">
            {(['1w', '1m', '3m', '6m', '1y', '2y'] as const).map((p) => (
              <button
                key={p}
                onClick={() => setPeriod(p)}
                className={`px-3 py-1 text-xs font-bold rounded-lg uppercase tracking-wider transition-all duration-150 active:scale-95 ${
                  period === p
                    ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 shadow'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Chart Body */}
      {loading ? (
        <div className="flex items-center justify-center min-h-[380px] w-full">
          <div className="flex flex-col items-center gap-3">
            <RefreshCw className="h-7 w-7 text-emerald-500 animate-spin" />
            <span className="text-zinc-500 text-xs font-medium">Re-aligning prices and calculating Mansfield line...</span>
          </div>
        </div>
      ) : error ? (
        <div className="flex flex-col items-center justify-center min-h-[380px] w-full text-center text-zinc-500">
          <p className="text-sm font-semibold text-red-400">Failed to render chart</p>
          <p className="text-xs text-zinc-600 mt-1 max-w-xs">{error}</p>
        </div>
      ) : data.length === 0 ? (
        <div className="flex items-center justify-center min-h-[380px] w-full text-zinc-500 text-sm">
          No historical data found for the selected lookback.
        </div>
      ) : viewMode === 'split' ? (
        /* Dual-Pane Split View Layout */
        <div className="flex flex-col gap-6 w-full h-[580px]">
          {/* Upper Pane: Stock Price Area Chart */}
          <div className="h-[62%] w-full relative">
            <div className="absolute top-2 left-2 text-[10px] uppercase font-bold text-zinc-550 bg-zinc-950/80 px-2 py-0.5 border border-zinc-850 rounded tracking-wider z-10">
              Stock Price Close (INR)
            </div>
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <AreaChart data={processedData} syncId="rs_dashboard_chart" margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <defs>
                  <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.16} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" strokeOpacity={0.3} vertical={false} />
                <XAxis dataKey="date" hide />
                <YAxis
                  domain={['auto', 'auto']}
                  tick={{ fill: '#a1a1aa', fontSize: 10, fontFamily: 'monospace' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1.2, strokeDasharray: '3 3' }} />
                <Area
                  type="monotone"
                  dataKey="stockClose"
                  stroke="#10b981"
                  strokeWidth={2}
                  fillOpacity={1}
                  fill="url(#priceGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* Lower Pane: RS Line Chart */}
          <div className="h-[32%] w-full relative">
            <div className="absolute top-2 left-2 text-[10px] uppercase font-bold text-zinc-550 bg-zinc-950/80 px-2 py-0.5 border border-zinc-850 rounded tracking-wider z-10">
              Relative Strength ({lookback === 252 ? '52w' : `${lookback}d`} performance-based)
            </div>
            <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
              <LineChart data={processedData} syncId="rs_dashboard_chart" margin={{ top: 5, right: 10, left: -10, bottom: 5 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#27272a" strokeOpacity={0.3} vertical={false} />
                <XAxis
                  dataKey="date"
                  tickFormatter={(val) => {
                    const d = new Date(val);
                    return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
                  }}
                  tick={{ fill: '#71717a', fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  domain={['auto', 'auto']}
                  tickFormatter={(val) => `${val >= 0 ? '+' : ''}${(val * 100).toFixed(0)}%`}
                  tick={{ fill: '#a1a1aa', fontSize: 10, fontFamily: 'monospace' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1.2, strokeDasharray: '3 3' }} />
                {/* 0 baseline reference line */}
                <ReferenceLine
                  y={0}
                  stroke="#ef4444"
                  strokeDasharray="4 3"
                  strokeWidth={1.5}
                  label={{ value: 'Index Baseline (0%)', fill: '#f87171', fontSize: 8, position: 'insideBottomRight', offset: 10 }}
                />
                <Line
                  type="monotone"
                  dataKey="rsLine"
                  stroke="#3b82f6"
                  strokeWidth={2.2}
                  dot={false}
                  activeDot={{ r: 5, stroke: '#60a5fa', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      ) : viewMode === 'overlay' ? (
        /* Overlay Dual Y-Axis View Layout */
        <div className="w-full h-[580px] relative">
          <div className="absolute top-2 left-2 text-[10px] uppercase font-bold text-zinc-550 bg-zinc-950/80 px-2 py-0.5 border border-zinc-850 rounded tracking-wider z-10">
            Overlay Chart (Left: RS Ratio | Right: Stock Price)
          </div>
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <ComposedChart data={processedData} margin={{ top: 25, right: 10, left: -5, bottom: 5 }}>
              <defs>
                <linearGradient id="overlayPriceGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10b981" stopOpacity={0.08} />
                  <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" strokeOpacity={0.3} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(val) => {
                  const d = new Date(val);
                  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
                }}
                tick={{ fill: '#71717a', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              {/* Left Y-Axis: RS line */}
              <YAxis
                yAxisId="left"
                orientation="left"
                domain={['auto', 'auto']}
                tickFormatter={(val) => `${val >= 0 ? '+' : ''}${(val * 100).toFixed(0)}%`}
                tick={{ fill: '#3b82f6', fontSize: 10, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
              />
              {/* Right Y-Axis: Stock Close Price */}
              <YAxis
                yAxisId="right"
                orientation="right"
                domain={['auto', 'auto']}
                tick={{ fill: '#10b981', fontSize: 10, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1.2, strokeDasharray: '3 3' }} />
              {/* 0 reference line linked to left axis */}
              <ReferenceLine
                y={0}
                yAxisId="left"
                stroke="#ef4444"
                strokeDasharray="4 3"
                strokeWidth={1.5}
                label={{ value: 'Index Baseline (0%)', fill: '#f87171', fontSize: 8, position: 'insideBottomRight', offset: 10 }}
              />
              {/* Stock Price Area (Right Axis) */}
              <Area
                yAxisId="right"
                type="monotone"
                dataKey="stockClose"
                stroke="#10b981"
                strokeWidth={1.5}
                fillOpacity={1}
                fill="url(#overlayPriceGradient)"
              />
              {/* Relative Strength Line (Left Axis) */}
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="rsLine"
                stroke="#3b82f6"
                strokeWidth={2.2}
                dot={false}
                activeDot={{ r: 5, stroke: '#60a5fa', strokeWidth: 2 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      ) : (
        /* Raw Ratio View: Simple Stock / Index Ratio */
        <div className="w-full h-[580px] relative">
          <div className="absolute top-2 left-2 text-[10px] uppercase font-bold text-zinc-550 bg-zinc-950/80 px-2 py-0.5 border border-zinc-850 rounded tracking-wider z-10">
            Raw Ratio Line ({symbol} / {indexType === 'nifty50' ? 'Nifty 50' : 'Nifty 500'})
          </div>
          <ResponsiveContainer width="100%" height="100%" minWidth={0} minHeight={0}>
            <AreaChart data={processedData} margin={{ top: 25, right: 10, left: -5, bottom: 5 }}>
              <defs>
                <linearGradient id="ratioGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#a855f7" stopOpacity={0.12} />
                  <stop offset="95%" stopColor="#a855f7" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" strokeOpacity={0.3} vertical={false} />
              <XAxis
                dataKey="date"
                tickFormatter={(val) => {
                  const d = new Date(val);
                  return d.toLocaleDateString('en-US', { month: 'short', year: '2-digit' });
                }}
                tick={{ fill: '#71717a', fontSize: 10 }}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                domain={['auto', 'auto']}
                tick={{ fill: '#a1a1aa', fontSize: 10, fontFamily: 'monospace' }}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<CustomTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1.2, strokeDasharray: '3 3' }} />
              <Area
                type="monotone"
                dataKey="rawRatio"
                stroke="#a855f7"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#ratioGradient)"
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
      
      {/* RS Interpretation Bar */}
      <div className="mt-6 pt-4 border-t border-zinc-900/60 flex flex-wrap items-center justify-between gap-3 text-[11px] text-zinc-550 select-none">
        <div className="flex items-center gap-1.5">
          <span className="font-semibold text-zinc-400">How to Interpret {lookback === 252 ? '52-Week' : `${lookback}-Day`} RS:</span>
        </div>
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            <span className="text-zinc-400"><strong className="text-emerald-400">RS above 0</strong> → Stock has outperformed the index</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500 shadow-[0_0_8px_rgba(239,68,68,0.5)]" />
            <span className="text-zinc-400"><strong className="text-red-400">RS below 0</strong> → Stock has underperformed the index</span>
          </div>
        </div>
      </div>
    </div>
  );
}
