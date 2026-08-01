'use client';

import React, { useState, useEffect, useMemo } from 'react';
import NavBar from './NavBar';
import type { RRGResponse, RRGSeries } from '@/app/api/rrg/route';

// ── SVG layout constants ──────────────────────────────────────────────────────
const SVG_W = 1200;
const SVG_H = 500;
const M = { top: 30, right: 20, bottom: 40, left: 45 };
const CW = SVG_W - M.left - M.right;  // 1135
const CH = SVG_H - M.top - M.bottom;  // 430

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
interface TooltipTailPoint {
  date: string;
  rsRatio: number;
  rsMomentum: number;
}

interface TooltipState {
  x: number;
  y: number;
  symbol: string;
  label: string;
  color: string;
  tailHistory: TooltipTailPoint[];
}

type QuadrantType = 'leading' | 'weakening' | 'lagging' | 'improving';

export default function RRGDashboard() {
  const [universe, setUniverse]           = useState<'indices' | 'nifty50'>('indices');
  const [benchmark, setBenchmark]         = useState<'nifty500' | 'nifty50'>('nifty500');
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
  const [method, setMethod]               = useState<'RATIO' | 'EMA' | 'SMA'>('RATIO');
  
  // Custom RRG options & View modes
  const [showLabels, setShowLabels]       = useState(true);
  const [lookbackLimit, setLookbackLimit] = useState(60); // Default: 3 Months
  const [rrgMode, setRrgMode]             = useState<'rrg' | 'chart'>('rrg');
  const [viewMode, setViewMode]           = useState<'fit' | 'center' | 'max'>('center');
  const [quadrantFilter, setQuadrantFilter] = useState<'all' | QuadrantType>('all');

  // ── Fetch Data ───────────────────────────────────────────────────────────────
  useEffect(() => {
    const ctrl = new AbortController();
    setLoading(true);
    setIsPlaying(false);
    setSearch('');
    setTooltip(null);
    fetch(`/api/rrg?universe=${universe}&timeframe=${timeframe}&benchmark=${benchmark}&method=${method}&lookback=252&_t=${Date.now()}`, { signal: ctrl.signal, cache: 'no-store' })
      .then(r => r.json())
      .then(({ data: d }: { data: RRGResponse }) => {
        setData(d);
        setActiveSymbols(new Set(d.symbols.map(s => s.symbol)));
        const len = d.symbols[0]?.history.slice(-lookbackLimit).length ?? 1;
        setPlayhead(len - 1);
      })
      .catch(err => { if (err.name !== 'AbortError') console.error(err); })
      .finally(() => { if (!ctrl.signal.aborted) setLoading(false); });
    return () => ctrl.abort();
  }, [universe, timeframe, benchmark, method]);

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

  // Animation playback effect
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
    let maxDist = 0.5;
    
    for (const s of slicedSymbols) {
      if (!activeSymbols.has(s.symbol)) continue;
      
      const start = viewMode === 'max'
        ? 0
        : Math.max(0, playhead - tailCount + 1);
      
      const end = viewMode === 'max' ? s.history.length : playhead + 1;
      const pts = s.history.slice(start, end);
      
      for (const p of pts) {
        const dx = Math.abs(p.rsRatio - 100);
        const dy = Math.abs(p.rsMomentum - 100);
        if (isFinite(dx) && dx > maxDist) maxDist = dx;
        if (isFinite(dy) && dy > maxDist) maxDist = dy;
      }
    }
    
    const multiplier = viewMode === 'center' ? 1.25 : 1.15;
    const half = Math.max(1.5, maxDist * multiplier);
    
    return {
      xMin: 100 - half,
      xMax: 100 + half,
      yMin: 100 - half,
      yMax: 100 + half
    };
  }, [slicedSymbols, activeSymbols, playhead, tailCount, viewMode]);

  const xS = (v: number) => M.left + ((v - bounds.xMin) / (bounds.xMax - bounds.xMin)) * CW;
  const yS = (v: number) => M.top  + CH - ((v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * CH;
  const cx100 = xS(100);
  const cy100 = yS(100);

  const firstActive = slicedSymbols.find(s => activeSymbols.has(s.symbol)) || slicedSymbols[0];
  const currentDate = firstActive?.history[playhead]?.date ?? data?.dataDate ?? '';
  const startDateStr = firstActive?.history[0]?.date ?? '';

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

  const filteredSymbols: RRGSeries[] = useMemo(() => {
    return slicedSymbols.filter(s => {
      const matchesSearch = search === '' ||
        s.label.toLowerCase().includes(search.toLowerCase()) ||
        s.symbol.toLowerCase().includes(search.toLowerCase());
      
      if (!matchesSearch) return false;
      if (quadrantFilter === 'all') return true;

      const currentPoint = s.history[Math.min(playhead, s.history.length - 1)];
      if (!currentPoint) return true;
      const { rsRatio, rsMomentum } = currentPoint;

      const q: QuadrantType = rsRatio >= 100
        ? (rsMomentum >= 100 ? 'leading' : 'weakening')
        : (rsMomentum >= 100 ? 'improving' : 'lagging');

      return q === quadrantFilter;
    });
  }, [slicedSymbols, search, quadrantFilter, playhead]);

  // Quadrant stats summary at current playhead
  const quadrantStats = useMemo(() => {
    const stats = { leading: 0, weakening: 0, lagging: 0, improving: 0 };
    for (const s of slicedSymbols) {
      if (!activeSymbols.has(s.symbol)) continue;
      const cur = s.history[Math.min(playhead, s.history.length - 1)];
      if (!cur) continue;
      if (cur.rsRatio >= 100 && cur.rsMomentum >= 100) stats.leading++;
      else if (cur.rsRatio >= 100 && cur.rsMomentum < 100) stats.weakening++;
      else if (cur.rsRatio < 100 && cur.rsMomentum < 100) stats.lagging++;
      else stats.improving++;
    }
    return stats;
  }, [slicedSymbols, activeSymbols, playhead]);

  // Historical Timeline Markers along top of chart
  const timelineMarkers = useMemo(() => {
    if (!firstActive || firstActive.history.length === 0) return [];
    const points = firstActive.history;
    const step = Math.max(1, Math.floor(points.length / 10));
    const markers: Array<{ label: string; xPct: number }> = [];
    
    for (let i = 0; i < points.length; i += step) {
      const dateStr = points[i].date;
      const parts = dateStr.split('-');
      if (parts.length === 3) {
        const months = ['Jan', 'Apr', 'Jul', 'Oct'];
        const mIdx = parseInt(parts[1], 10) - 1;
        const monthName = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][mIdx];
        markers.push({
          label: `${monthName} ${parts[0]}`,
          xPct: (i / (points.length - 1))
        });
      }
    }
    return markers;
  }, [firstActive]);

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="h-screen bg-[#090a0f] text-zinc-100 flex flex-col font-sans antialiased select-none overflow-hidden">
      {/* Sleek Dark Header */}
      <header className="bg-[#12141c]/90 border-b border-zinc-800/80 px-4 py-2 flex items-center gap-4 sticky top-0 z-30 flex-wrap backdrop-blur-md flex-shrink-0">
        <div>
          <div className="text-sm font-black text-zinc-100 tracking-wider uppercase flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-purple-500 animate-pulse" />
            <span>Relative Rotation Graph</span>
          </div>
          <div className="text-[11px] text-zinc-400 font-medium tracking-wide">Dhan Broker Standard · Relative Rotation Engine</div>
        </div>
        <NavBar />
        <div className="flex items-center gap-3 ml-2">
          <label className="flex items-center gap-1.5 cursor-pointer text-xs font-bold text-purple-400 bg-purple-950/40 px-2.5 py-1 rounded border border-purple-800/50">
            <input
              type="radio"
              name="rrgMode"
              checked={rrgMode === 'rrg'}
              onChange={() => setRrgMode('rrg')}
              className="h-3.5 w-3.5 text-purple-500 border-zinc-700 focus:ring-purple-500 cursor-pointer"
            />
            <span>RRG View</span>
          </label>
        </div>
        <div className="ml-auto flex items-center gap-3">
          {data && (
            <span className="font-mono text-xs bg-zinc-900 text-zinc-400 px-3 py-1 rounded border border-zinc-800 font-semibold shadow-inner">
              DATA: {data.dataDate}
            </span>
          )}
        </div>
      </header>

      {/* Control bar */}
      <div className="px-4 py-2 flex flex-wrap items-center gap-4 border-b border-zinc-800/80 bg-[#0d0e14]">
        {/* Benchmark dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 font-bold uppercase tracking-wider">Benchmark</span>
          <div className="relative">
            <select
              value={benchmark}
              onChange={e => setBenchmark(e.target.value as 'nifty500' | 'nifty50')}
              className="appearance-none pl-3 pr-8 py-1 text-xs font-bold text-purple-400 border border-zinc-700/80 rounded bg-[#1a1d29] cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              <option value="nifty500">Nifty 500 (Dhan Standard)</option>
              <option value="nifty50">Nifty 50 Index</option>
            </select>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-zinc-400 text-[10px]">
              ▼
            </span>
          </div>
        </div>

        {/* Benchmark Sparkline */}
        {data && slicedBenchmarkHistory.length > 1 && (
          <div className="flex-1 max-w-[180px] h-6 mx-2 relative hidden sm:block">
            <svg className="w-full h-full overflow-visible" viewBox="0 0 200 24" preserveAspectRatio="none">
              {(() => {
                const bh = slicedBenchmarkHistory;
                const bMin = Math.min(...bh.map(p => p.close));
                const bMax = Math.max(...bh.map(p => p.close));
                const bRange = bMax - bMin || 1;
                const pts = bh.map((p, i) => `${(i / (bh.length - 1)) * 200},${22 - ((p.close - bMin) / bRange) * 20}`).join(' ');
                return (
                  <>
                    <polyline points={pts} fill="none" stroke="#a855f7" strokeWidth={1.5} />
                    <circle cx={200} cy={22 - ((bh[bh.length - 1].close - bMin) / bRange) * 20} r={2.5} fill="#c084fc" />
                  </>
                );
              })()}
            </svg>
          </div>
        )}

        {/* Timeframe dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 font-bold uppercase tracking-wider">Timeframe</span>
          <div className="relative">
            <select
              value={timeframe}
              onChange={e => setTimeframe(e.target.value as 'daily' | 'weekly')}
              className="appearance-none pl-3 pr-8 py-1 text-xs font-bold text-zinc-200 border border-zinc-700/80 rounded bg-[#1a1d29] cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              <option value="daily">Daily</option>
              <option value="weekly">Weekly</option>
            </select>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-zinc-400 text-[10px]">
              ▼
            </span>
          </div>
        </div>

        {/* Method dropdown */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 font-bold uppercase tracking-wider">Method</span>
          <div className="relative">
            <select
              value={method}
              onChange={e => setMethod(e.target.value as 'RATIO' | 'EMA' | 'SMA')}
              className="appearance-none pl-3 pr-8 py-1 text-xs font-bold text-zinc-200 border border-zinc-700/80 rounded bg-[#1a1d29] cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              <option value="RATIO">Dhan / Optuma Ratio (Standard)</option>
              <option value="EMA">EMA (Z-Score)</option>
              <option value="SMA">SMA (Z-Score)</option>
            </select>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-zinc-400 text-[10px]">
              ▼
            </span>
          </div>
        </div>

        {/* Date range lookback */}
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-zinc-400 font-bold uppercase tracking-wider">Lookback</span>
          <div className="relative">
            <select
              value={lookbackLimit}
              onChange={e => setLookbackLimit(parseInt(e.target.value, 10))}
              className="appearance-none pl-3 pr-8 py-1 text-xs font-bold text-zinc-200 border border-zinc-700/80 rounded bg-[#1a1d29] cursor-pointer focus:outline-none focus:ring-1 focus:ring-purple-500"
            >
              <option value={20}>1 Month (20 bars)</option>
              <option value={60}>3 Months (60 bars)</option>
              <option value={120}>6 Months (120 bars)</option>
              <option value={252}>1 Year (252 bars)</option>
            </select>
            <span className="absolute inset-y-0 right-0 flex items-center pr-2 pointer-events-none text-zinc-400 text-[10px]">
              ▼
            </span>
          </div>
        </div>

        {/* Tail counts selector */}
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-[11px] text-zinc-400 uppercase tracking-wider font-bold">Tail:</span>
          <div className="flex items-center rounded border border-zinc-700/80 overflow-hidden bg-[#1a1d29]">
            <button
              onClick={() => setTailCount(c => Math.max(1, c - 1))}
              className="px-2.5 py-0.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800 border-r border-zinc-700/80"
            >
              -
            </button>
            <span className="w-8 text-center text-xs font-bold text-purple-300">{tailCount}</span>
            <button
              onClick={() => setTailCount(c => Math.min(30, c + 1))}
              className="px-2.5 py-0.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800 border-l border-zinc-700/80"
            >
              +
            </button>
          </div>
          <span className="text-[11px] text-zinc-400 font-medium">Bars</span>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex flex-1 min-h-0">
        
        {/* Symbol panel */}
        <div className="w-[420px] flex-shrink-0 border-r border-zinc-800/80 flex flex-col bg-[#12141c]">
          {/* Header, Search & Quadrant Quick Filters */}
          <div className="p-3 border-b border-zinc-800/80 bg-[#12141c]">
            <div className="flex items-center justify-between gap-2 mb-2">
              <span className="text-sm font-black text-zinc-100 tracking-wide">Symbols</span>
              <div className="relative flex-1 max-w-[170px]">
                <span className="absolute inset-y-0 left-0 flex items-center pl-2 text-zinc-500">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </span>
                <input
                  type="text"
                  placeholder="Search symbol..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="w-full pl-7 pr-2 py-1 text-xs border border-zinc-700/80 rounded bg-[#1a1d29] text-zinc-100 placeholder-zinc-500 focus:outline-none focus:ring-1 focus:ring-purple-500 font-medium"
                />
              </div>
            </div>
            
            <div className="flex items-center justify-between text-xs text-purple-400 font-semibold mb-2">
              <div className="flex items-center gap-1 cursor-pointer hover:text-purple-300">
                <select
                  value={universe}
                  onChange={e => setUniverse(e.target.value as 'indices' | 'nifty50')}
                  className="appearance-none font-bold text-purple-400 bg-transparent cursor-pointer focus:outline-none pr-4"
                >
                  <option value="indices">Sector Indices ({slicedSymbols.length})</option>
                  <option value="nifty50">Nifty 50 Stocks ({slicedSymbols.length})</option>
                </select>
                <span className="text-[10px] pointer-events-none text-purple-400">▼</span>
              </div>
            </div>

            {/* Dhan Quadrant Filter Pills */}
            <div className="grid grid-cols-5 gap-1 pt-1.5 border-t border-zinc-800/80">
              <button
                onClick={() => setQuadrantFilter('all')}
                className={`px-1 py-1 text-[9px] font-black rounded text-center transition-all ${
                  quadrantFilter === 'all' ? 'bg-zinc-100 text-zinc-950 shadow' : 'bg-zinc-800/60 text-zinc-400 hover:bg-zinc-800'
                }`}
              >
                ALL ({slicedSymbols.filter(s => activeSymbols.has(s.symbol)).length})
              </button>
              <button
                onClick={() => setQuadrantFilter('leading')}
                className={`px-1 py-1 text-[9px] font-black rounded text-center transition-all ${
                  quadrantFilter === 'leading' ? 'bg-emerald-500 text-zinc-950 shadow' : 'bg-emerald-950/50 text-emerald-400 hover:bg-emerald-900/50 border border-emerald-800/40'
                }`}
              >
                ACCEL ({quadrantStats.leading})
              </button>
              <button
                onClick={() => setQuadrantFilter('weakening')}
                className={`px-1 py-1 text-[9px] font-black rounded text-center transition-all ${
                  quadrantFilter === 'weakening' ? 'bg-amber-500 text-zinc-950 shadow' : 'bg-amber-950/50 text-amber-400 hover:bg-amber-900/50 border border-amber-800/40'
                }`}
              >
                DECEL ({quadrantStats.weakening})
              </button>
              <button
                onClick={() => setQuadrantFilter('lagging')}
                className={`px-1 py-1 text-[9px] font-black rounded text-center transition-all ${
                  quadrantFilter === 'lagging' ? 'bg-red-500 text-zinc-950 shadow' : 'bg-red-950/50 text-red-400 hover:bg-red-900/50 border border-red-800/40'
                }`}
              >
                UNDER ({quadrantStats.lagging})
              </button>
              <button
                onClick={() => setQuadrantFilter('improving')}
                className={`px-1 py-1 text-[9px] font-black rounded text-center transition-all ${
                  quadrantFilter === 'improving' ? 'bg-purple-500 text-zinc-950 shadow' : 'bg-purple-950/50 text-purple-400 hover:bg-purple-900/50 border border-purple-800/40'
                }`}
              >
                RECOV ({quadrantStats.improving})
              </button>
            </div>
          </div>

          {/* Table headers */}
          <div className="flex items-center px-3 py-1.5 border-b border-zinc-800/80 bg-[#0d0e14] select-none text-[10px] font-black text-zinc-400 tracking-wider">
            <div className="w-6 flex items-center">
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
                className="h-3.5 w-3.5 rounded border-zinc-700 text-purple-600 focus:ring-purple-500 cursor-pointer bg-zinc-800"
              />
            </div>
            <span className="w-26 truncate">NAME</span>
            <span className="w-20 text-center">STATE</span>
            <span className="w-20 text-center font-mono">TREND / MOM</span>
            <span className="flex-1 text-right font-mono">PRICE / 1D%</span>
          </div>

          {/* List of symbols */}
          <div className="flex-1 overflow-y-auto divide-y divide-zinc-800/50">
            {filteredSymbols.map(s => {
              const currentPoint = s.history[Math.min(playhead, s.history.length - 1)];
              let bgClass = '';
              let badgeText = 'N/A';
              let badgeStyle = 'bg-zinc-800 text-zinc-400 border-zinc-700';

              if (currentPoint) {
                const { rsRatio, rsMomentum } = currentPoint;
                if (rsRatio >= 100 && rsMomentum >= 100) {
                  bgClass = 'bg-emerald-950/20 hover:bg-emerald-950/40';
                  badgeText = 'ACCELERATING';
                  badgeStyle = 'bg-emerald-950/90 text-emerald-300 border-emerald-800/80 shadow-[0_0_8px_rgba(52,211,153,0.15)]';
                } else if (rsRatio >= 100 && rsMomentum < 100) {
                  bgClass = 'bg-amber-950/20 hover:bg-amber-950/40';
                  badgeText = 'DECELERATING';
                  badgeStyle = 'bg-amber-950/90 text-amber-300 border-amber-800/80 shadow-[0_0_8px_rgba(251,191,36,0.15)]';
                } else if (rsRatio < 100 && rsMomentum < 100) {
                  bgClass = 'bg-red-950/20 hover:bg-red-950/40';
                  badgeText = 'UNDERPERFORM';
                  badgeStyle = 'bg-red-950/90 text-red-300 border-red-800/80 shadow-[0_0_8px_rgba(248,113,113,0.15)]';
                } else {
                  bgClass = 'bg-purple-950/20 hover:bg-purple-950/40';
                  badgeText = 'RECOVERING';
                  badgeStyle = 'bg-purple-950/90 text-purple-300 border-purple-800/80 shadow-[0_0_8px_rgba(192,132,252,0.15)]';
                }
              }

              const isActive = activeSymbols.has(s.symbol);

              return (
                <label
                  key={s.symbol}
                  className={`flex items-center px-3 py-2 cursor-pointer transition-all ${bgClass} ${
                    isActive ? 'font-bold text-zinc-100 border-l-4' : 'opacity-50 text-zinc-400 border-l-0'
                  }`}
                  style={isActive ? { borderLeftColor: s.color } : undefined}
                >
                  <div className="w-6 flex items-center">
                    <input
                      type="checkbox"
                      checked={isActive}
                      onChange={() => toggleSymbol(s.symbol)}
                      className="h-3.5 w-3.5 rounded border-zinc-700 text-purple-600 focus:ring-purple-500 cursor-pointer bg-zinc-800"
                    />
                  </div>
                  
                  <div className="w-26 pr-1 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: s.color }} />
                    <span className="text-xs truncate font-bold" title={s.label}>
                      {s.label}
                    </span>
                  </div>

                  <div className="w-20 flex justify-center">
                    <span className={`text-[8px] font-black px-1.5 py-0.5 rounded border ${badgeStyle} tracking-tight`}>
                      {badgeText}
                    </span>
                  </div>

                  <div className="w-20 text-center font-mono text-[11px] text-zinc-300 font-medium">
                    {currentPoint ? `${currentPoint.rsRatio.toFixed(1)} / ${currentPoint.rsMomentum.toFixed(1)}` : '-'}
                  </div>

                  <div className="flex-1 flex flex-col items-end justify-center font-mono text-xs">
                    <span className="font-semibold text-zinc-200">
                      {s.latestClose != null ? s.latestClose.toFixed(1) : '-'}
                    </span>
                    <span className={`text-[10px] font-bold ${(s.priceChange1D ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {s.priceChange1D != null ? `${s.priceChange1D >= 0 ? '+' : ''}${s.priceChange1D.toFixed(2)}%` : '-'}
                    </span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>

        {/* Chart area */}
        <div className="flex-1 flex flex-col bg-[#090a0f] overflow-hidden">
          
          {/* Subheader controls */}
          <div className="flex items-center justify-between px-4 py-2 border-b border-zinc-800/80 bg-[#12141c] flex-wrap gap-2">
            <div className="flex items-center gap-3">
              <span className="text-xs font-black text-purple-300 tracking-wide">{currentDateRangeText}</span>
              <span className="text-[10px] text-zinc-400 font-semibold bg-zinc-900 px-2 py-0.5 rounded border border-zinc-800">
                Clockwise Rotation Cycle
              </span>
            </div>
            
            <div className="flex items-center gap-4">
              {/* View mode toggle */}
              <div className="flex items-center gap-1 bg-[#1a1d29] p-0.5 rounded border border-zinc-700/80">
                <span className="text-[10px] text-zinc-400 font-bold uppercase px-1">VIEW:</span>
                <button
                  onClick={() => setViewMode('fit')}
                  className={`px-2.5 py-0.5 text-xs font-bold rounded transition-all ${
                    viewMode === 'fit' ? 'bg-purple-600 text-white shadow font-black' : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                  title="Fit bounds to visible tails"
                >
                  Fit
                </button>
                <button
                  onClick={() => setViewMode('center')}
                  className={`px-2.5 py-0.5 text-xs font-bold rounded transition-all ${
                    viewMode === 'center' ? 'bg-purple-600 text-white shadow font-black' : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                  title="Center bounds symmetrically at (100, 100)"
                >
                  Center
                </button>
                <button
                  onClick={() => setViewMode('max')}
                  className={`px-2.5 py-0.5 text-xs font-bold rounded transition-all ${
                    viewMode === 'max' ? 'bg-purple-600 text-white shadow font-black' : 'text-zinc-400 hover:text-zinc-100'
                  }`}
                  title="Scale bounds to full lookback history"
                >
                  Max
                </button>
              </div>

              {/* Playback speed */}
              <div className="flex items-center gap-1 text-xs">
                <span className="text-[10px] text-zinc-400 font-bold uppercase">Speed:</span>
                <button
                  onClick={() => setSpeed('slow')}
                  className={`px-2 py-0.5 text-[10px] font-bold rounded ${speed === 'slow' ? 'bg-purple-600 text-white' : 'bg-[#1a1d29] text-zinc-400 hover:text-zinc-100 border border-zinc-700/80'}`}
                >
                  Slow
                </button>
                <button
                  onClick={() => setSpeed('normal')}
                  className={`px-2 py-0.5 text-[10px] font-bold rounded ${speed === 'normal' ? 'bg-purple-600 text-white' : 'bg-[#1a1d29] text-zinc-400 hover:text-zinc-100 border border-zinc-700/80'}`}
                >
                  1x
                </button>
                <button
                  onClick={() => setSpeed('fast')}
                  className={`px-2 py-0.5 text-[10px] font-bold rounded ${speed === 'fast' ? 'bg-purple-600 text-white' : 'bg-[#1a1d29] text-zinc-400 hover:text-zinc-100 border border-zinc-700/80'}`}
                >
                  Fast
                </button>
              </div>

              {/* Label toggle */}
              <label className="flex items-center gap-1.5 cursor-pointer text-xs font-bold text-zinc-300">
                <input
                  type="checkbox"
                  checked={showLabels}
                  onChange={e => setShowLabels(e.target.checked)}
                  className="h-3.5 w-3.5 rounded border-zinc-700 text-purple-600 focus:ring-purple-500 cursor-pointer bg-zinc-800"
                />
                <span>Labels</span>
              </label>
            </div>
          </div>

          {/* Canvas SVG Container */}
          <div className="flex-1 p-0 flex items-center justify-center bg-[#07080c] overflow-hidden relative">
            {loading && (
              <div className="text-purple-400 text-sm font-semibold animate-pulse">Calculating RRG Rotations...</div>
            )}

            {!loading && !data && (
              <div className="text-zinc-500 text-sm">No historical index data available</div>
            )}

            {!loading && data && (
              <svg
                viewBox={`0 0 ${SVG_W} ${SVG_H}`}
                className="w-full h-full text-zinc-100"
                style={{ width: '100%', height: '100%' }}
                shapeRendering="geometricPrecision"
                onMouseLeave={() => setTooltip(null)}
              >
                <defs>
                  {/* Glow Filters for crisp dots */}
                  <filter id="glow-purple" x="-50%" y="-50%" width="200%" height="200%">
                    <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#c084fc" floodOpacity="0.8" />
                  </filter>
                  <filter id="glow-green" x="-50%" y="-50%" width="200%" height="200%">
                    <feDropShadow dx="0" dy="0" stdDeviation="3.5" floodColor="#34d399" floodOpacity="0.8" />
                  </filter>
                </defs>

                {/* ── Quadrant overlays (Dhan Dark Theme) ── */}
                {/* ACCELERATING (Top-Right x>100, y>100) */}
                <rect x={cx100} y={M.top} width={M.left + CW - cx100} height={cy100 - M.top}
                  fill="#0e2a1e" fillOpacity={0.65} />
                {/* DECELERATING (Bottom-Right x>100, y<100) */}
                <rect x={cx100} y={cy100} width={M.left + CW - cx100} height={M.top + CH - cy100}
                  fill="#2a1f0e" fillOpacity={0.65} />
                {/* UNDERPERFORMING (Bottom-Left x<100, y<100) */}
                <rect x={M.left} y={cy100} width={cx100 - M.left} height={M.top + CH - cy100}
                  fill="#2c1115" fillOpacity={0.65} />
                {/* RECOVERING (Top-Left x<100, y>100) */}
                <rect x={M.left} y={M.top} width={cx100 - M.left} height={cy100 - M.top}
                  fill="#1e1834" fillOpacity={0.65} />

                {/* ── Dhan Quadrant Labels (Corners) ── */}
                <text x={M.left + CW - 15} y={M.top + 22} textAnchor="end" fontSize={11} fontWeight="900" fill="#34d399" letterSpacing="0.05em">
                  Accelerating
                </text>
                <text x={M.left + CW - 15} y={M.top + CH - 15} textAnchor="end" fontSize={11} fontWeight="900" fill="#fbbf24" letterSpacing="0.05em">
                  Decelerating
                </text>
                <text x={M.left + 15} y={M.top + CH - 15} textAnchor="start" fontSize={11} fontWeight="900" fill="#f87171" letterSpacing="0.05em">
                  Underperforming
                </text>
                <text x={M.left + 15} y={M.top + 22} textAnchor="start" fontSize={11} fontWeight="900" fill="#c084fc" letterSpacing="0.05em">
                  Recovering
                </text>

                {/* ── Chart border & Centre crosshair ── */}
                <rect x={M.left} y={M.top} width={CW} height={CH} fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth={1} />
                <line x1={M.left} y1={cy100} x2={M.left + CW} y2={cy100} stroke="#4b5563" strokeWidth={1.5} />
                <line x1={cx100} y1={M.top} x2={cx100} y2={M.top + CH} stroke="#4b5563" strokeWidth={1.5} />

                {/* ── Dhan Axis Titles ── */}
                <text x={M.left + CW / 2} y={SVG_H - 10} textAnchor="middle" fontSize={11} fontWeight="bold" fill="#9ca3af" letterSpacing="0.05em">
                  Strength Trend
                </text>
                <text
                  x={14} y={M.top + CH / 2}
                  textAnchor="middle" fontSize={11} fontWeight="bold" fill="#9ca3af" letterSpacing="0.05em"
                  transform={`rotate(-90, 14, ${M.top + CH / 2})`}
                >
                  Strength Momentum
                </text>

                {/* ── X-axis grid lines ── */}
                {(() => {
                  const step = (bounds.xMax - bounds.xMin) / 10;
                  const niceStep = step < 0.5 ? 0.5 : step < 1 ? 1 : step < 2 ? 2 : step < 5 ? 5 : 10;
                  const start = Math.ceil(bounds.xMin / niceStep) * niceStep;
                  const ticks: number[] = [];
                  for (let v = start; v <= bounds.xMax + 0.001; v += niceStep) ticks.push(+v.toFixed(4));
                  return ticks.map(v => {
                    const px = xS(v);
                    if (px < M.left - 1 || px > M.left + CW + 1) return null;
                    const isCenter = Math.abs(v - 100) < 0.01;
                    return (
                      <g key={`xt-${v}`}>
                        <line
                          x1={px} y1={M.top} x2={px} y2={M.top + CH}
                          stroke={isCenter ? '#6b7280' : 'rgba(255,255,255,0.05)'}
                          strokeWidth={isCenter ? 1.5 : 0.7}
                          strokeDasharray={isCenter ? undefined : '3,3'}
                        />
                        <text
                          x={px} y={M.top + CH + 16}
                          textAnchor="middle" fontSize={9.5} fill={isCenter ? '#f3f4f6' : '#9ca3af'}
                          fontWeight={isCenter ? 'bold' : 'medium'}
                          fontFamily="monospace"
                        >
                          {v.toFixed(1)}
                        </text>
                      </g>
                    );
                  });
                })()}

                {/* ── Y-axis grid lines ── */}
                {(() => {
                  const step = (bounds.yMax - bounds.yMin) / 10;
                  const niceStep = step < 0.5 ? 0.5 : step < 1 ? 1 : step < 2 ? 2 : step < 5 ? 5 : 10;
                  const start = Math.ceil(bounds.yMin / niceStep) * niceStep;
                  const ticks: number[] = [];
                  for (let v = start; v <= bounds.yMax + 0.001; v += niceStep) ticks.push(+v.toFixed(4));
                  return ticks.map(v => {
                    const py = yS(v);
                    if (py < M.top - 1 || py > M.top + CH + 1) return null;
                    const isCenter = Math.abs(v - 100) < 0.01;
                    return (
                      <g key={`yt-${v}`}>
                        <line
                          x1={M.left} y1={py} x2={M.left + CW} y2={py}
                          stroke={isCenter ? '#6b7280' : 'rgba(255,255,255,0.05)'}
                          strokeWidth={isCenter ? 1.5 : 0.7}
                          strokeDasharray={isCenter ? undefined : '3,3'}
                        />
                        <text
                          x={M.left - 10} y={py + 3.5}
                          textAnchor="end" fontSize={9.5} fill={isCenter ? '#f3f4f6' : '#9ca3af'}
                          fontWeight={isCenter ? 'bold' : 'medium'}
                          fontFamily="monospace"
                        >
                          {v.toFixed(1)}
                        </text>
                      </g>
                    );
                  });
                })()}

                {/* ── Symbol trails (Dhan Ultra-Thin Crisp Vector Rendering) ── */}
                {(() => {
                  const activeList = slicedSymbols.filter(s => activeSymbols.has(s.symbol));
                  return activeList.map((s, activeIdx) => {
                    const start = Math.max(0, playhead - tailCount + 1);
                    const tail = s.history.slice(start, playhead + 1);
                    if (tail.length === 0) return null;

                    const head = tail[tail.length - 1];
                    const prev = tail.length > 1 ? tail[tail.length - 2] : null;
                    const hx = xS(head.rsRatio);
                    const hy = yS(head.rsMomentum);

                    let arrow: React.ReactNode = null;
                    if (prev) {
                      const dx = hx - xS(prev.rsRatio);
                      const dy = hy - yS(prev.rsMomentum);
                      const len = Math.sqrt(dx * dx + dy * dy) || 1;
                      const nx = dx / len, ny = dy / len;
                      const px = -ny, py = nx;
                      // Small sharp arrowhead (matching Dhan broker)
                      const tip = `${hx + nx * 5},${hy + ny * 5}`;
                      const bl  = `${hx - nx * 2 + px * 2},${hy - ny * 2 + py * 2}`;
                      const br  = `${hx - nx * 2 - px * 2},${hy - ny * 2 - py * 2}`;
                      arrow = <polygon points={`${tip} ${bl} ${br}`} fill={s.color} stroke={s.color} strokeWidth={0.5} />;
                    }

                    // Smart staggered label offsets to prevent text overlap
                    const offsets = [
                      { dx: 6, dy: -4, anchor: 'start' },
                      { dx: 6, dy: 10, anchor: 'start' },
                      { dx: -6, dy: -4, anchor: 'end' },
                      { dx: -6, dy: 10, anchor: 'end' },
                      { dx: 0, dy: -9, anchor: 'middle' },
                      { dx: 0, dy: 13, anchor: 'middle' },
                    ];
                    const off = offsets[activeIdx % offsets.length];
                    const labelText = s.label.replace(/^Nifty\s+/, '');

                    return (
                      <g key={s.symbol}>
                        {/* Ultra-thin vector path */}
                        <path
                          d={getCurvePath(tail.map(p => ({ x: xS(p.rsRatio), y: yS(p.rsMomentum) })))}
                          fill="none"
                          stroke={s.color}
                          strokeWidth={1.3}
                          strokeOpacity={0.9}
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                        
                        {/* Tail dots (tiny crisp dots) */}
                        {tail.map((p, i) => (
                          <circle
                            key={i}
                            cx={xS(p.rsRatio)}
                            cy={yS(p.rsMomentum)}
                            r={i === tail.length - 1 ? 3.5 : 1.5}
                            fill={s.color}
                            opacity={i === tail.length - 1 ? 1 : 0.4 + 0.6 * ((i + 1) / tail.length)}
                            stroke={i === tail.length - 1 ? "#ffffff" : "none"}
                            strokeWidth={i === tail.length - 1 ? 1 : 0}
                            style={{ cursor: 'pointer' }}
                            onMouseEnter={() => setTooltip({
                              x: xS(p.rsRatio),
                              y: yS(p.rsMomentum),
                              symbol: s.symbol,
                              label: s.label,
                              color: s.color,
                              tailHistory: [...tail].reverse(), // Latest date first
                            })}
                          />
                        ))}
                        
                        {/* Arrow direction */}
                        {arrow}
                        
                        {/* Crisp Staggered Text Label */}
                        {showLabels && (
                          <text
                            x={hx + off.dx}
                            y={hy + off.dy}
                            textAnchor={off.anchor as any}
                            fontSize={8}
                            fill={s.color}
                            fontWeight="700"
                            style={{ filter: 'drop-shadow(0px 1px 2px rgba(0,0,0,0.95))' }}
                          >
                            {labelText}
                          </text>
                        )}
                      </g>
                    );
                  });
                })()}

                {/* ── Multi-Day Historical Tail Hover Tooltip ── */}
                {tooltip && (() => {
                  const cardW = 245;
                  const rowH = 17;
                  const historyList = tooltip.tailHistory.slice(0, 10);
                  const cardH = 36 + historyList.length * rowH + 6;
                  
                  const tx = tooltip.x + 12;
                  const ty = tooltip.y - cardH / 2;
                  const clampedTx = Math.min(Math.max(M.left + 5, tx), SVG_W - M.right - cardW - 5);
                  const clampedTy = Math.min(Math.max(M.top + 5, ty), SVG_H - M.bottom - cardH - 5);

                  return (
                    <g pointerEvents="none">
                      {/* Background Card */}
                      <rect
                        x={clampedTx}
                        y={clampedTy}
                        width={cardW}
                        height={cardH}
                        rx={6}
                        fill="#12141c"
                        stroke="#374151"
                        strokeWidth={1}
                        filter="drop-shadow(0 8px 24px rgba(0,0,0,0.85))"
                      />

                      {/* Header Bar */}
                      <circle cx={clampedTx + 14} cy={clampedTy + 16} r={3.5} fill={tooltip.color} />
                      <text x={clampedTx + 24} y={clampedTy + 19} fontSize={10.5} fontWeight="900" fill="#f3f4f6">
                        {tooltip.label}
                      </text>

                      {/* Table Column Headers */}
                      <text x={clampedTx + 12} y={clampedTy + 32} fontSize={8} fontWeight="bold" fill="#6b7280">
                        DATE
                      </text>
                      <text x={clampedTx + 105} y={clampedTy + 32} fontSize={8} fontWeight="bold" fill="#34d399" textAnchor="end">
                        TREND
                      </text>
                      <text x={clampedTx + 165} y={clampedTy + 32} fontSize={8} fontWeight="bold" fill="#c084fc" textAnchor="end">
                        MOMENTUM
                      </text>
                      <text x={clampedTx + 233} y={clampedTy + 32} fontSize={8} fontWeight="bold" fill="#9ca3af" textAnchor="end">
                        STATE
                      </text>

                      <line
                        x1={clampedTx + 10} y1={clampedTy + 36}
                        x2={clampedTx + cardW - 10} y2={clampedTy + 36}
                        stroke="rgba(255,255,255,0.08)" strokeWidth={1}
                      />

                      {/* Tail History Rows */}
                      {historyList.map((pt, i) => {
                        const ry = clampedTy + 48 + i * rowH;
                        const isLatest = i === 0;

                        let qBadge = 'RECOVERING';
                        let qColor = '#c084fc';
                        if (pt.rsRatio >= 100 && pt.rsMomentum >= 100) { qBadge = 'ACCEL'; qColor = '#34d399'; }
                        else if (pt.rsRatio >= 100 && pt.rsMomentum < 100) { qBadge = 'DECEL'; qColor = '#fbbf24'; }
                        else if (pt.rsRatio < 100 && pt.rsMomentum < 100) { qBadge = 'UNDER'; qColor = '#f87171'; }

                        return (
                          <g key={pt.date}>
                            {isLatest && (
                              <rect
                                x={clampedTx + 6}
                                y={ry - 10}
                                width={cardW - 12}
                                height={rowH - 1}
                                fill="rgba(168,85,247,0.18)"
                                rx={3}
                              />
                            )}
                            <text
                              x={clampedTx + 12}
                              y={ry}
                              fontSize={8}
                              fill={isLatest ? '#ffffff' : '#9ca3af'}
                              fontWeight={isLatest ? 'bold' : 'normal'}
                              fontFamily="monospace"
                            >
                              {pt.date} {isLatest ? '★' : ''}
                            </text>
                            <text
                              x={clampedTx + 105}
                              y={ry}
                              fontSize={8.5}
                              fill={isLatest ? '#34d399' : '#d1d5db'}
                              fontWeight={isLatest ? 'bold' : 'normal'}
                              textAnchor="end"
                              fontFamily="monospace"
                            >
                              {pt.rsRatio.toFixed(2)}
                            </text>
                            <text
                              x={clampedTx + 165}
                              y={ry}
                              fontSize={8.5}
                              fill={isLatest ? '#c084fc' : '#d1d5db'}
                              fontWeight={isLatest ? 'bold' : 'normal'}
                              textAnchor="end"
                              fontFamily="monospace"
                            >
                              {pt.rsMomentum.toFixed(2)}
                            </text>
                            <text
                              x={clampedTx + 233}
                              y={ry}
                              fontSize={7.5}
                              fill={qColor}
                              fontWeight="bold"
                              textAnchor="end"
                            >
                              {qBadge}
                            </text>
                          </g>
                        );
                      })}
                    </g>
                  );
                })()}
              </svg>
            )}
          </div>

          {/* ── Interactive Historical Timeline Scrubber ── */}
          <div className="px-4 py-2.5 bg-[#12141c] border-t border-zinc-800/80 flex items-center gap-3 select-none">
            <button
              onClick={() => {
                if (playhead >= maxPlayhead) setPlayhead(0);
                setIsPlaying(p => !p);
              }}
              className="flex items-center justify-center w-8 h-8 rounded-full bg-purple-600 hover:bg-purple-500 text-white shadow-[0_0_12px_rgba(168,85,247,0.4)] font-bold text-xs transition-all"
              title={isPlaying ? 'Pause animation' : 'Play animation'}
            >
              {isPlaying ? '⏸' : '▶'}
            </button>

            <button
              onClick={() => { setIsPlaying(false); setPlayhead(0); }}
              className="px-2 py-1 text-xs border border-zinc-700/80 rounded bg-[#1a1d29] text-zinc-300 hover:bg-zinc-800 font-bold"
              title="Reset to beginning"
            >
              ⏮
            </button>

            <button
              onClick={() => { setIsPlaying(false); setPlayhead(p => Math.max(0, p - 1)); }}
              className="px-2 py-1 text-xs border border-zinc-700/80 rounded bg-[#1a1d29] text-zinc-300 hover:bg-zinc-800 font-bold"
              title="Step 1 bar backward"
            >
              ◀
            </button>

            <button
              onClick={() => { setIsPlaying(false); setPlayhead(p => Math.min(maxPlayhead, p + 1)); }}
              className="px-2 py-1 text-xs border border-zinc-700/80 rounded bg-[#1a1d29] text-zinc-300 hover:bg-zinc-800 font-bold"
              title="Step 1 bar forward"
            >
              ▶
            </button>

            <button
              onClick={() => { setIsPlaying(false); setPlayhead(maxPlayhead); }}
              className="px-2 py-1 text-xs border border-zinc-700/80 rounded bg-[#1a1d29] text-zinc-300 hover:bg-zinc-800 font-bold"
              title="Jump to latest date"
            >
              ⏭
            </button>

            <span className="text-xs font-mono text-zinc-400 font-medium pl-1">{startDateStr}</span>

            <input
              type="range"
              min={0}
              max={maxPlayhead}
              value={playhead}
              onChange={e => {
                setIsPlaying(false);
                setPlayhead(parseInt(e.target.value, 10));
              }}
              className="flex-1 accent-purple-500 cursor-pointer h-2 bg-zinc-800 rounded-lg"
            />

            <span className="text-xs font-mono font-bold text-purple-300 bg-purple-950/60 px-3 py-1 rounded border border-purple-800/60 shadow">
              {currentDate}
            </span>
          </div>

        </div>
      </div>
    </div>
  );
}
