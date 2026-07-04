'use client';

import React, { useState, useEffect, useMemo } from 'react';
import NavBar from './NavBar';
import type { RRGResponse, RRGSeries } from '@/app/api/rrg/route';

// ── SVG layout constants ──────────────────────────────────────────────────────
const SVG_W = 1200;
const SVG_H = 600;
const M = { top: 35, right: 90, bottom: 45, left: 70 };
const CW = SVG_W - M.left - M.right;  // 1040
const CH = SVG_H - M.top - M.bottom;  // 520

function getCurvePath(points: { x: number; y: number }[]): string {
  if (points.length < 2) return '';
  if (points.length === 2) {
    return `M ${points[0].x} ${points[0].y} L ${points[1].x} ${points[1].y}`;
  }
  
  let d = `M ${points[0].x} ${points[0].y}`;
  
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[i - 1] || points[i];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[i + 2] || p2;
    
    const cp1x = p1.x + (p2.x - p0.x) / 6;
    const cp1y = p1.y + (p2.y - p0.y) / 6;
    
    const cp2x = p2.x - (p3.x - p1.x) / 6;
    const cp2y = p2.y - (p3.y - p1.y) / 6;
    
    d += ` C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${p2.x} ${p2.y}`;
  }
  
  return d;
}

// ── Tooltip state ─────────────────────────────────────────────────────────────
interface TooltipState {
  x: number;
  y: number;
  symbol: string;
  label: string;
  date: string;
  rsRatio: number;
  rsMomentum: number;
}

export default function RRGDashboard() {
  const [universe, setUniverse]           = useState<'indices' | 'nifty50'>('indices');
  const [timeframe, setTimeframe]         = useState<'daily' | 'weekly'>('daily');
  const [tailCount, setTailCount]         = useState(5);
  const [playhead, setPlayhead]           = useState(0);
  const [isPlaying, setIsPlaying]         = useState(false);
  const [speed, setSpeed]                 = useState<'slow' | 'normal' | 'fast'>('normal');
  const [activeSymbols, setActiveSymbols] = useState<Set<string>>(new Set());
  const [data, setData]                   = useState<RRGResponse | null>(null);
  const [loading, setLoading]             = useState(false);
  const [search, setSearch]               = useState('');
  const [tooltip, setTooltip]             = useState<TooltipState | null>(null);
  const [method, setMethod]               = useState<'EMA' | 'SMA'>('EMA');
  
  // Custom RRG options
  const [showLabels, setShowLabels]       = useState(true);
  const [lookbackLimit, setLookbackLimit] = useState(60); // Default: 3 Months (approx 60 trading days)
  const [rrgMode, setRrgMode]             = useState<'rrg' | 'chart'>('rrg');

  // ── Fetch ────────────────────────────────────────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setIsPlaying(false);
    setSearch('');
    setTooltip(null);
    // Fetch full data; slicing is done client-side based on lookbackLimit
    fetch(`/api/rrg?universe=${universe}&timeframe=${timeframe}&method=${method}&lookback=252`, { signal: ctrl.signal })
      .then(r => r.json())
      .then(({ data: d }: { data: RRGResponse }) => {
        setData(d);
        setActiveSymbols(new Set(d.symbols.map(s => s.symbol)));
        // Initialize playhead at the end of the sliced dataset
        const len = d.symbols[0]?.history.slice(-lookbackLimit).length ?? 1;
        setPlayhead(len - 1);
      })
      .catch(err => { if (err.name !== 'AbortError') console.error(err); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [universe, timeframe, method]);

  // ── Sliced Data & Playback Bounds ────────────────────────────────────────────
  const slicedSymbols = useMemo(() => {
    if (!data) return [];
    return data.symbols.map(s => ({
      ...s,
      history: s.history.slice(-lookbackLimit)
    }));
  }, [data, lookbackLimit]);

  const slicedBenchmarkHistory = useMemo(() => {
    if (!data) return [];
    return data.benchmarkHistory.slice(-lookbackLimit);
  }, [data, lookbackLimit]);

  const maxPlayhead = useMemo(() => {
    if (slicedSymbols.length === 0) return 0;
    const active = slicedSymbols.filter(s => activeSymbols.has(s.symbol));
    if (active.length === 0) return (slicedSymbols[0]?.history.length ?? 1) - 1;
    return Math.min(...active.map(s => s.history.length)) - 1;
  }, [slicedSymbols, activeSymbols]);

  // Adjust playhead safely when bounds change
  useEffect(() => {
    if (slicedSymbols.length > 0) {
      const len = slicedSymbols[0].history.length;
      setPlayhead(prev => Math.min(prev, len - 1));
    }
  }, [slicedSymbols]);

  // Animation effect
  useEffect(() => {
    if (!isPlaying) return;
    const ms = speed === 'slow' ? 600 : speed === 'normal' ? 300 : 100;
    const id = setInterval(() => {
      setPlayhead(p => {
        if (p >= maxPlayhead) { setIsPlaying(false); return p; }
        return p + 1;
      });
    }, ms);
    return () => clearInterval(id);
  }, [isPlaying, speed, maxPlayhead]);

  // ── Coordinate symmetric bounds around 100 ───────────────────────────────────
  const bounds = useMemo(() => {
    if (slicedSymbols.length === 0) return { xMin: 98, xMax: 102, yMin: 98, yMax: 102 };
    let maxDist = 0.5; // Minimum half-width from 100 center
    for (const s of slicedSymbols) {
      if (!activeSymbols.has(s.symbol)) continue;
      
      const start = Math.max(0, playhead - tailCount + 1);
      const tail = s.history.slice(start, playhead + 1);
      
      for (const p of tail) {
        const dx = Math.abs(p.rsRatio - 100);
        const dy = Math.abs(p.rsMomentum - 100);
        if (isFinite(dx) && dx > maxDist) maxDist = dx;
        if (isFinite(dy) && dy > maxDist) maxDist = dy;
      }
    }
    
    // Add dynamic padding and construct symmetric range
    const half = maxDist * 1.15;
    return {
      xMin: 100 - half,
      xMax: 100 + half,
      yMin: 100 - half,
      yMax: 100 + half
    };
  }, [slicedSymbols, activeSymbols, playhead, tailCount]);

  const xS = (v: number) => M.left + ((v - bounds.xMin) / (bounds.xMax - bounds.xMin)) * CW;
  const yS = (v: number) => M.top  + CH - ((v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * CH;
  const cx100 = xS(100);
  const cy100 = yS(100);

  const firstActive = slicedSymbols.find(s => activeSymbols.has(s.symbol)) || slicedSymbols[0];
  const currentDate = firstActive?.history[playhead]?.date ?? data?.dataDate ?? '';

  const currentDateRangeText = useMemo(() => {
    if (slicedSymbols.length === 0 || !firstActive) return '';
    const startIdx = Math.max(0, playhead - tailCount + 1);
    const startDate = firstActive.history[startIdx]?.date ?? '';
    const endDate = firstActive.history[playhead]?.date ?? '';

    const formatDate = (ds: string) => {
      if (!ds) return '';
      const parts = ds.split('-');
      if (parts.length !== 3) return ds;
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[parseInt(parts[1], 10) - 1];
      return `${parts[2]} ${month} ${parts[0]}`;
    };

    return `${formatDate(startDate)} to ${formatDate(endDate)}`;
  }, [slicedSymbols, firstActive, playhead, tailCount]);

  const toggleSymbol = (sym: string) =>
    setActiveSymbols(prev => {
      const next = new Set(prev);
      next.has(sym) ? next.delete(sym) : next.add(sym);
      return next;
    });

  const filteredSymbols: RRGSeries[] = slicedSymbols.filter(s =>
    search === '' ||
    s.label.toLowerCase().includes(search.toLowerCase()) ||
    s.symbol.toLowerCase().includes(search.toLowerCase())
  );

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-white text-zinc-900 flex flex-col">
      <div className="p-4 pb-2">
        <NavBar />
      </div>

      {/* Sticky header matching screenshot layout */}
      <div className="sticky top-0 z-10 bg-white border-b border-zinc-200 px-4 py-2 flex items-center justify-between">
        <div className="flex items-center gap-6">
          <h1 className="text-sm font-extrabold text-zinc-900 tracking-wide">Relative Rotation Graph</h1>
          <div className="flex items-center gap-3 text-xs">
            <label className="flex items-center gap-1.5 cursor-pointer font-bold text-zinc-700">
              <input
                type="radio"
                name="rrgMode"
                checked={rrgMode === 'rrg'}
                onChange={() => setRrgMode('rrg')}
                className="h-3.5 w-3.5 text-blue-600 border-zinc-300 focus:ring-blue-500 cursor-pointer"
              />
              <span>RRG</span>
            </label>
            <label className="flex items-center gap-1.5 cursor-pointer font-semibold text-zinc-400">
              <input
                type="radio"
                name="rrgMode"
                checked={rrgMode === 'chart'}
                onChange={() => setRrgMode('chart')}
                className="h-3.5 w-3.5 text-blue-600 border-zinc-300 focus:ring-blue-500 cursor-pointer"
              />
              <span>Chart</span>
            </label>
          </div>
        </div>
        {data && (
          <span className="px-2 py-0.5 rounded bg-zinc-100 text-zinc-500 text-xs font-mono border border-zinc-200">
            DATA: {data.dataDate}
          </span>
        )}
      </div>

      {/* Filters row with sparkline */}
      <div className="px-4 py-2 flex flex-wrap items-center gap-4 border-b border-zinc-200 bg-zinc-50">
        {/* Benchmark dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 font-semibold uppercase">Benchmark</span>
          <div className="relative">
            <select
              value="nifty50"
              onChange={() => {}}
              className="appearance-none pl-3 pr-8 py-1 text-xs font-bold text-blue-600 border border-zinc-300 rounded bg-white cursor-default focus:outline-none"
            >
              <option value="nifty50">Nifty 50</option>
            </select>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-zinc-500">
              ▼
            </span>
          </div>
        </div>

        {/* Sparkline of index */}
        {data && slicedBenchmarkHistory.length > 1 && (
          <div className="flex-1 max-w-[220px] h-6 mx-4 relative hidden sm:block">
            <svg className="w-full h-full overflow-visible" viewBox="0 0 200 24" preserveAspectRatio="none">
              {(() => {
                const bh = slicedBenchmarkHistory;
                const bMin = Math.min(...bh.map(p => p.close));
                const bMax = Math.max(...bh.map(p => p.close));
                const bRange = bMax - bMin || 1;
                const pts = bh.map((p, i) => `${(i / (bh.length - 1)) * 200},${22 - ((p.close - bMin) / bRange) * 20}`).join(' ');
                return (
                  <>
                    <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth={1.5} />
                    <circle cx={200} cy={22 - ((bh[bh.length - 1].close - bMin) / bRange) * 20} r={2} fill="#2563eb" />
                  </>
                );
              })()}
            </svg>
          </div>
        )}

        {/* Timeframe dropdown */}
        <div className="flex items-center gap-2 ml-auto sm:ml-0">
          <span className="text-xs text-zinc-500 font-semibold uppercase">Timeframe</span>
          <div className="relative">
            <select
              value={timeframe}
              onChange={e => setTimeframe(e.target.value as 'daily' | 'weekly')}
              className="appearance-none pl-3 pr-8 py-1 text-xs font-bold text-zinc-700 border border-zinc-300 rounded bg-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-zinc-500">
              ▼
            </span>
          </div>
        </div>

        {/* Method dropdown (EMA / SMA) */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 font-semibold uppercase">Method</span>
          <div className="relative">
            <select
              value={method}
              onChange={e => setMethod(e.target.value as 'EMA' | 'SMA')}
              className="appearance-none pl-3 pr-8 py-1 text-xs font-bold text-zinc-700 border border-zinc-300 rounded bg-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="EMA">EMA (Bloomberg)</option>
              <option value="SMA">SMA (Classic)</option>
            </select>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-zinc-500">
              ▼
            </span>
          </div>
        </div>

        {/* Date range selection */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 font-semibold uppercase">Date Range</span>
          <div className="relative">
            <select
              value={lookbackLimit}
              onChange={e => setLookbackLimit(parseInt(e.target.value))}
              className="appearance-none pl-3 pr-8 py-1 text-xs font-bold text-zinc-700 border border-zinc-300 rounded bg-white cursor-pointer focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value={20}>1 Month</option>
              <option value={60}>3 Months</option>
              <option value={120}>6 Months</option>
              <option value={252}>1 Year</option>
            </select>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-zinc-500">
              ▼
            </span>
          </div>
        </div>

        {/* Counts selector */}
        <div className="flex items-center gap-2">
          <span className="text-xs text-zinc-500 uppercase tracking-wider font-semibold">Counts:</span>
          <div className="flex items-center rounded border border-zinc-300 overflow-hidden bg-white">
            <button
              onClick={() => setTailCount(c => Math.max(1, c - 1))}
              className="px-2.5 py-0.5 text-sm font-bold text-zinc-600 hover:bg-zinc-100 transition-all border-r border-zinc-200"
            >
              -
            </button>
            <span className="w-8 text-center text-xs font-bold text-zinc-800">{tailCount}</span>
            <button
              onClick={() => setTailCount(c => Math.min(30, c + 1))}
              className="px-2.5 py-0.5 text-sm font-bold text-zinc-600 hover:bg-zinc-100 transition-all border-l border-zinc-200"
            >
              +
            </button>
          </div>
          <span className="text-xs text-zinc-500 font-medium">Days</span>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex flex-1 min-h-0">
        
        {/* Symbol panel: wider layout */}
        <div className="w-[360px] flex-shrink-0 border-r border-zinc-200 flex flex-col bg-white">
          {/* Header & Search */}
          <div className="p-3 border-b border-zinc-200 bg-white">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-bold text-zinc-800">Symbols</span>
              <div className="relative flex-1 max-w-[150px]">
                <span className="absolute inset-y-0 left-0 flex items-center pl-2 text-zinc-400">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </span>
                <input
                  type="text"
                  placeholder="Search..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-7 pr-2 py-1 text-xs border border-zinc-300 rounded bg-white text-zinc-800 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </div>
            </div>
            
            <div className="flex items-center justify-between text-xs text-blue-600 font-semibold">
              <div className="flex items-center gap-1 cursor-pointer hover:text-blue-800">
                <select
                  value={universe}
                  onChange={e => setUniverse(e.target.value as 'indices' | 'nifty50')}
                  className="appearance-none font-bold text-blue-600 bg-transparent cursor-pointer focus:outline-none pr-4"
                >
                  <option value="indices">Only Indices ({slicedSymbols.length})</option>
                  <option value="nifty50">Nifty 50 Stocks ({slicedSymbols.length})</option>
                </select>
                <span className="text-[10px] pointer-events-none text-blue-600">▼</span>
              </div>
              <button className="hover:text-blue-800">+ Add</button>
            </div>
          </div>

          {/* Table headers */}
          <div className="flex items-center px-3 py-1 border-b border-zinc-200 bg-zinc-50 select-none">
            <div className="w-7 flex items-center">
              <input
                type="checkbox"
                checked={data ? activeSymbols.size === data.symbols.length : false}
                onChange={(e) => {
                  if (e.target.checked && data) {
                    setActiveSymbols(new Set(data.symbols.map(s => s.symbol)));
                  } else {
                    setActiveSymbols(new Set());
                  }
                }}
                className="h-3.5 w-3.5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
              />
            </div>
            <span className="text-[10px] font-bold text-zinc-500 flex-1">NAME</span>
            <span className="text-[10px] font-bold text-zinc-500 w-10 text-center">TAIL</span>
            <span className="text-[10px] font-bold text-zinc-500 w-16 text-right">PRICE</span>
            <span className="text-[10px] font-bold text-zinc-500 w-16 text-right">% CHANGE</span>
          </div>

          {/* List of symbols with color-coded rows */}
          <div className="flex-1 overflow-y-auto">
            {filteredSymbols.map(s => {
              const currentPoint = s.history[Math.min(playhead, s.history.length - 1)];
              let bgClass = '';
              if (currentPoint) {
                const { rsRatio, rsMomentum } = currentPoint;
                if (rsRatio >= 100 && rsMomentum >= 100) {
                  bgClass = 'bg-emerald-50/70 border-emerald-100 hover:bg-emerald-100/70'; // Leading (light green)
                } else if (rsRatio >= 100 && rsMomentum < 100) {
                  bgClass = 'bg-amber-50/70 border-amber-100 hover:bg-amber-100/70'; // Weakening (light orange)
                } else if (rsRatio < 100 && rsMomentum < 100) {
                  bgClass = 'bg-red-50/70 border-red-100 hover:bg-red-100/70'; // Lagging (light pink)
                } else {
                  bgClass = 'bg-purple-50/70 border-purple-100 hover:bg-purple-100/70'; // Improving (light purple)
                }
              }

              const isActive = activeSymbols.has(s.symbol);

              return (
                <label
                  key={s.symbol}
                  className={`flex items-center px-3 py-1.5 border-b cursor-pointer transition-all ${bgClass} ${
                    isActive ? 'font-semibold text-zinc-900 border-l-4' : 'opacity-60 text-zinc-600 border-l-0'
                  }`}
                  style={isActive ? { borderLeftColor: s.color } : undefined}
                >
                  <div className="w-7 flex items-center">
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={() => toggleSymbol(s.symbol)}
                      className="h-3.5 w-3.5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                    />
                  </div>
                  <span className="text-xs flex-1 truncate pr-2" title={s.label}>
                    {s.label}
                  </span>
                  <div className="w-10 flex justify-center">
                    <div className="w-1.5 h-4 rounded-sm shadow-sm" style={{ backgroundColor: s.color }} />
                  </div>
                  <span className="text-xs w-16 text-right font-mono font-medium">
                    {s.latestClose != null ? s.latestClose.toFixed(2) : '-'}
                  </span>
                  <span
                    className={`text-xs w-16 text-right font-mono font-bold ${
                      (s.priceChange1D ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-500'
                    }`}
                  >
                    {s.priceChange1D != null
                      ? `${s.priceChange1D >= 0 ? '+' : ''}${s.priceChange1D.toFixed(2)}`
                      : '-'}
                  </span>
                </label>
              );
            })}
          </div>
        </div>

        {/* Chart area: flex fill, responsive */}
        <div className="flex-1 flex flex-col bg-white overflow-hidden">
          
          {/* Subheader with View controls, Date & Play */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-200 bg-white">
            <div className="text-xs font-bold text-zinc-500">
              {currentDateRangeText}
            </div>
            
            <div className="flex items-center gap-6">
              {/* View options */}
              <div className="flex items-center gap-1">
                <span className="text-[10px] text-zinc-400 font-bold uppercase mr-1">VIEW:</span>
                <button className="px-2 py-0.5 text-xs font-semibold border border-zinc-300 rounded bg-white text-zinc-700 hover:bg-zinc-50">Fit</button>
                <button className="px-2 py-0.5 text-xs font-semibold border border-zinc-300 rounded bg-white text-zinc-700 hover:bg-zinc-50">Center</button>
                <button className="px-2 py-0.5 text-xs font-semibold border border-zinc-300 rounded bg-white text-zinc-700 hover:bg-zinc-50">Max</button>
                {/* Zoom buttons */}
                <button className="p-1 hover:bg-zinc-50 text-zinc-500 rounded ml-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </button>
              </div>

              {/* Play buttons */}
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    if (playhead >= maxPlayhead) setPlayhead(0);
                    setIsPlaying(p => !p);
                  }}
                  className="flex items-center gap-1 px-3 py-1 text-xs font-bold border border-zinc-300 rounded bg-white text-zinc-700 hover:bg-zinc-50 transition-all shadow-sm"
                >
                  <span>{isPlaying ? 'Pause' : 'Play'}</span>
                  <span className="text-[9px]">{isPlaying ? '⏸' : '▶'}</span>
                </button>
                <button
                  onClick={() => { setIsPlaying(false); setPlayhead(0); }}
                  className="px-2 py-1 text-xs border border-zinc-300 rounded bg-white text-zinc-500 hover:bg-zinc-50"
                  title="Reset"
                >
                  ⏮
                </button>
              </div>

              {/* Label toggle */}
              <label className="flex items-center gap-1.5 cursor-pointer text-xs font-semibold text-zinc-700">
                <input
                  type="checkbox"
                  checked={showLabels}
                  onChange={e => setShowLabels(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-300 text-blue-600 focus:ring-blue-500 cursor-pointer"
                />
                <span>Label</span>
              </label>
            </div>
          </div>

          {/* SVG Container: full responsive scale */}
          <div className="flex-1 p-4 flex items-center justify-center bg-white overflow-hidden relative">
            {loading && (
              <div className="text-zinc-400 text-sm">Loading RRG calculations...</div>
            )}

            {!loading && !data && (
              <div className="text-zinc-500 text-sm">No historical index data available</div>
            )}

            {!loading && data && (
              <svg
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="w-full h-full"
                style={{ width: '100%', height: '100%' }}
                onMouseLeave={() => setTooltip(null)}
              >
                {/* ── Quadrant fills (pastel soft overlays) ── */}
                {/* LEADING: top-right x>100, y>100 */}
                <rect x={cx100} y={M.top} width={M.left + CW - cx100} height={cy100 - M.top}
                  fill="#dcfce7" fillOpacity={0.6} />
                {/* WEAKENING: bottom-right x>100, y<100 */}
                <rect x={cx100} y={cy100} width={M.left + CW - cx100} height={M.top + CH - cy100}
                  fill="#ffedd5" fillOpacity={0.6} />
                {/* LAGGING: bottom-left x<100, y<100 */}
                <rect x={M.left} y={cy100} width={cx100 - M.left} height={M.top + CH - cy100}
                  fill="#fee2e2" fillOpacity={0.6} />
                {/* IMPROVING: top-left x<100, y>100 */}
                <rect x={M.left} y={M.top} width={cx100 - M.left} height={cy100 - M.top}
                  fill="#f3e8ff" fillOpacity={0.6} />

                {/* ── Chart border ── */}
                <rect x={M.left} y={M.top} width={CW} height={CH}
                  fill="none" stroke="rgba(0,0,0,0.15)" strokeWidth={1} />

                {/* ── Centre axes (heavy black lines) ── */}
                <line x1={M.left} y1={cy100} x2={M.left + CW} y2={cy100}
                  stroke="#111827" strokeWidth={1.5} />
                <line x1={cx100} y1={M.top} x2={cx100} y2={M.top + CH}
                  stroke="#111827" strokeWidth={1.5} />

                {/* ── Centre axis labels (100.0) ── */}
                <text x={cx100} y={M.top + CH + 14} textAnchor="middle" fontSize={10} fill="#374151" fontWeight="bold">
                  100.0
                </text>
                <text x={M.left + CW + 6} y={cy100 + 3} textAnchor="start" fontSize={10} fill="#374151" fontWeight="bold">
                  100.0
                </text>

                {/* ── Quadrant corner labels (bold uppercase dark text) ── */}
                <text x={M.left + CW - 12} y={M.top + 18} textAnchor="end"
                  fontSize={10} fontWeight="900" fill="#1f2937" letterSpacing="0.05em">LEADING</text>
                <text x={M.left + CW - 12} y={M.top + CH - 10} textAnchor="end"
                  fontSize={10} fontWeight="900" fill="#1f2937" letterSpacing="0.05em">WEAKENING</text>
                <text x={M.left + 12} y={M.top + CH - 10} textAnchor="start"
                  fontSize={10} fontWeight="900" fill="#1f2937" letterSpacing="0.05em">LAGGING</text>
                <text x={M.left + 12} y={M.top + 18} textAnchor="start"
                  fontSize={10} fontWeight="900" fill="#1f2937" letterSpacing="0.05em">IMPROVING</text>

                {/* ── Axis titles (standard RRG edges) ── */}
                <text x={M.left + CW / 2} y={SVG_H - 6} textAnchor="middle" fontSize={10} fontWeight="bold" fill="#4b5563">
                  JDK RS-RATIO
                </text>
                <text
                  x={SVG_W - 6} y={M.top + CH / 2}
                  textAnchor="middle" fontSize={10} fontWeight="bold" fill="#4b5563"
                  transform={`rotate(-90, ${SVG_W - 6}, ${M.top + CH / 2})`}
                >
                  JDK RS-MOMENTUM
                </text>

                {/* ── X-axis grid lines & tick labels ── */}
                {(() => {
                  const step = (bounds.xMax - bounds.xMin) / 10; // ~10 divisions
                  const niceStep = step < 1 ? 1 : step < 2 ? 2 : step < 5 ? 5 : 10;
                  const start = Math.ceil(bounds.xMin / niceStep) * niceStep;
                  const ticks: number[] = [];
                  for (let v = start; v <= bounds.xMax + 0.001; v += niceStep) ticks.push(+v.toFixed(4));
                  return ticks.map(v => {
                    const px = xS(v);
                    if (px < M.left - 1 || px > M.left + CW + 1) return null;
                    const isCenter = Math.abs(v - 100) < 0.01;
                    return (
                      <g key={`xt-${v}`}>
                        {/* vertical grid line */}
                        <line
                          x1={px} y1={M.top} x2={px} y2={M.top + CH}
                          stroke={isCenter ? '#111827' : 'rgba(0,0,0,0.1)'}
                          strokeWidth={isCenter ? 1.5 : 0.7}
                          strokeDasharray={isCenter ? undefined : '3,3'}
                        />
                        {/* tick mark at bottom */}
                        <line x1={px} y1={M.top + CH} x2={px} y2={M.top + CH + 5} stroke="#6b7280" strokeWidth={1} />
                        {/* label */}
                        <text
                          x={px} y={M.top + CH + 15}
                          textAnchor="middle" fontSize={9} fill={isCenter ? '#111827' : '#6b7280'}
                          fontWeight={isCenter ? 'bold' : 'normal'}
                        >
                          {v.toFixed(1)}
                        </text>
                      </g>
                    );
                  });
                })()}

                {/* ── Y-axis grid lines & tick labels ── */}
                {(() => {
                  const step = (bounds.yMax - bounds.yMin) / 10;
                  const niceStep = step < 1 ? 1 : step < 2 ? 2 : step < 5 ? 5 : 10;
                  const start = Math.ceil(bounds.yMin / niceStep) * niceStep;
                  const ticks: number[] = [];
                  for (let v = start; v <= bounds.yMax + 0.001; v += niceStep) ticks.push(+v.toFixed(4));
                  return ticks.map(v => {
                    const py = yS(v);
                    if (py < M.top - 1 || py > M.top + CH + 1) return null;
                    const isCenter = Math.abs(v - 100) < 0.01;
                    return (
                      <g key={`yt-${v}`}>
                        {/* horizontal grid line */}
                        <line
                          x1={M.left} y1={py} x2={M.left + CW} y2={py}
                          stroke={isCenter ? '#111827' : 'rgba(0,0,0,0.1)'}
                          strokeWidth={isCenter ? 1.5 : 0.7}
                          strokeDasharray={isCenter ? undefined : '3,3'}
                        />
                        {/* tick mark on right */}
                        <line x1={M.left + CW} y1={py} x2={M.left + CW + 5} y2={py} stroke="#6b7280" strokeWidth={1} />
                        {/* label on right side */}
                        <text
                          x={M.left + CW + 10} y={py + 3.5}
                          textAnchor="start" fontSize={9} fill={isCenter ? '#111827' : '#6b7280'}
                          fontWeight={isCenter ? 'bold' : 'normal'}
                        >
                          {v.toFixed(1)}
                        </text>
                      </g>
                    );
                  });
                })()}

                {/* ── Symbol trails ── */}
                {slicedSymbols
                  .filter(s => activeSymbols.has(s.symbol))
                  .map(s => {
                    const start = Math.max(0, playhead - tailCount + 1);
                    const tail = s.history.slice(start, playhead + 1);
                    if (tail.length === 0) return null;

                    const head = tail[tail.length - 1];
                    const prev = tail.length > 1 ? tail[tail.length - 2] : null;
                    const hx = xS(head.rsRatio);
                    const hy = yS(head.rsMomentum);

                    // Arrowhead pointing in direction of movement
                    let arrow: React.ReactNode = null;
                    if (prev) {
                      const dx = hx - xS(prev.rsRatio);
                      const dy = hy - yS(prev.rsMomentum);
                      const len = Math.sqrt(dx * dx + dy * dy) || 1;
                      const nx = dx / len, ny = dy / len;
                      const px = -ny, py = nx;
                      const tip = `${hx + nx * 7},${hy + ny * 7}`;
                      const bl  = `${hx - nx * 3 + px * 3},${hy - ny * 3 + py * 3}`;
                      const br  = `${hx - nx * 3 - px * 3},${hy - ny * 3 - py * 3}`;
                      arrow = <polygon points={`${tip} ${bl} ${br}`} fill={s.color} stroke={s.color} strokeWidth={1} />;
                    }

                    return (
                      <g key={s.symbol}>
                        {/* Trail path (curved) */}
                        <path
                          d={getCurvePath(tail.map(p => ({ x: xS(p.rsRatio), y: yS(p.rsMomentum) })))}
                          fill="none"
                          stroke={s.color}
                          strokeWidth={2}
                          strokeOpacity={0.9}
                        />
                        
                        {/* Fading dots along tail */}
                        {tail.map((p, i) => (
                          <circle
                            key={i}
                            cx={xS(p.rsRatio)}
                            cy={yS(p.rsMomentum)}
                            r={i === tail.length - 1 ? 5.5 : 2.5}
                            fill={s.color}
                            opacity={0.35 + 0.65 * ((i + 1) / tail.length)}
                            stroke={i === tail.length - 1 ? "#ffffff" : "none"}
                            strokeWidth={1.5}
                            style={{ cursor: i === tail.length - 1 ? 'pointer' : 'default' }}
                            onMouseEnter={i === tail.length - 1 ? () => setTooltip({
                              x: hx, y: hy,
                              symbol: s.symbol,
                              label: s.label,
                              date: head.date,
                              rsRatio: head.rsRatio,
                              rsMomentum: head.rsMomentum,
                            }) : undefined}
                          />
                        ))}
                        
                        {/* Direction Arrow */}
                        {arrow}
                        
                        {/* Symbol label at head (toggleable) */}
                        {showLabels && (
                          <text x={hx + 8} y={hy + 3} fontSize={9} fill={s.color} fontWeight="bold">
                            {s.label}
                          </text>
                        )}
                      </g>
                    );
                  })}

                {/* ── Hover tooltip ── */}
                {tooltip && (() => {
                  const tx = tooltip.x + 12;
                  const ty = tooltip.y - 60;
                  const clampedTx = Math.min(tx, SVG_W - 160);
                  const clampedTy = Math.max(ty, M.top);
                  return (
                    <g pointerEvents="none">
                      <rect x={clampedTx} y={clampedTy} width={155} height={70} rx={4}
                        fill="white" stroke="#d1d5db" strokeWidth={1}
                        filter="drop-shadow(0 2px 4px rgba(0,0,0,0.15))" />
                      <text x={clampedTx + 8} y={clampedTy + 16} fontSize={9} fontWeight="bold" fill="#111">{tooltip.date}</text>
                      <text x={clampedTx + 8} y={clampedTy + 28} fontSize={8} fontWeight="bold" fill="#111">{tooltip.label}</text>
                      <text x={clampedTx + 8} y={clampedTy + 44} fontSize={9} fill="#555">JdK RS-RATIO</text>
                      <text x={clampedTx + 145} y={clampedTy + 44} fontSize={9} fontWeight="bold" fill="#111" textAnchor="end">{tooltip.rsRatio.toFixed(2)}</text>
                      <text x={clampedTx + 8} y={clampedTy + 58} fontSize={9} fill="#555">JdK RS-MOMENTUM</text>
                      <text x={clampedTx + 145} y={clampedTy + 58} fontSize={9} fontWeight="bold" fill="#111" textAnchor="end">{tooltip.rsMomentum.toFixed(2)}</text>
                    </g>
                  );
                })()}
              </svg>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
