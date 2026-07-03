'use client';

import React, { useState, useEffect, useMemo } from 'react';
import NavBar from './NavBar';
import type { RRGResponse } from '@/app/api/rrg/route';

// ── SVG constants ─────────────────────────────────────────────────────────────
const SVG_W = 720;
const SVG_H = 640;
const M = { top: 40, right: 100, bottom: 48, left: 56 };
const CW = SVG_W - M.left - M.right; // 564
const CH = SVG_H - M.top - M.bottom; // 552

export default function RRGDashboard() {
  const [universe, setUniverse]         = useState<'indices' | 'nifty50'>('indices');
  const [timeframe, setTimeframe]       = useState<'daily' | 'weekly'>('daily');
  const [tailCount, setTailCount]       = useState(5);
  const [playhead, setPlayhead]         = useState(0);
  const [isPlaying, setIsPlaying]       = useState(false);
  const [speed, setSpeed]               = useState<'slow' | 'normal' | 'fast'>('normal');
  const [activeSymbols, setActiveSymbols] = useState<Set<string>>(new Set());
  const [data, setData]                 = useState<RRGResponse | null>(null);
  const [loading, setLoading]           = useState(false);
  const [search, setSearch]             = useState('');

  // ── Fetch ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    setLoading(true);
    setSearch('');
    setIsPlaying(false);
    fetch(`/api/rrg?universe=${universe}&timeframe=${timeframe}&lookback=252`)
      .then(r => r.json())
      .then(({ data: d }: { data: RRGResponse }) => {
        setData(d);
        setActiveSymbols(new Set(d.symbols.map(s => s.symbol)));
        setPlayhead((d.symbols[0]?.history.length ?? 1) - 1);
      })
      .catch(console.error)
      .finally(() => setLoading(false));
  }, [universe, timeframe]);

  // ── Animation ─────────────────────────────────────────────────────────────
  const maxPlayhead = (data?.symbols[0]?.history.length ?? 1) - 1;

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

  // ── Coordinate bounds ─────────────────────────────────────────────────────
  const bounds = useMemo(() => {
    if (!data) return { xMin: 98, xMax: 102, yMin: 98, yMax: 102 };
    let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity;
    for (const s of data.symbols) {
      if (!activeSymbols.has(s.symbol)) continue;
      for (const p of s.history) {
        if (p.rsRatio < xMin)    xMin = p.rsRatio;
        if (p.rsRatio > xMax)    xMax = p.rsRatio;
        if (p.rsMomentum < yMin) yMin = p.rsMomentum;
        if (p.rsMomentum > yMax) yMax = p.rsMomentum;
      }
    }
    if (!isFinite(xMin)) return { xMin: 98, xMax: 102, yMin: 98, yMax: 102 };
    // Ensure 100 is always visible
    xMin = Math.min(xMin, 99.5); xMax = Math.max(xMax, 100.5);
    yMin = Math.min(yMin, 99.5); yMax = Math.max(yMax, 100.5);
    const xPad = (xMax - xMin) * 0.12, yPad = (yMax - yMin) * 0.12;
    return { xMin: xMin - xPad, xMax: xMax + xPad, yMin: yMin - yPad, yMax: yMax + yPad };
  }, [data, activeSymbols]);

  const xS = (v: number) => M.left + ((v - bounds.xMin) / (bounds.xMax - bounds.xMin)) * CW;
  const yS = (v: number) => M.top  + CH - ((v - bounds.yMin) / (bounds.yMax - bounds.yMin)) * CH;
  const cx100 = xS(100);
  const cy100 = yS(100);

  const currentDate = data?.symbols[0]?.history[playhead]?.date ?? data?.dataDate ?? '';

  const toggleSymbol = (sym: string) =>
    setActiveSymbols(prev => {
      const next = new Set(prev);
      next.has(sym) ? next.delete(sym) : next.add(sym);
      return next;
    });

  const filteredSymbols = data?.symbols.filter(s =>
    search === '' ||
    s.label.toLowerCase().includes(search.toLowerCase()) ||
    s.symbol.toLowerCase().includes(search.toLowerCase())
  ) ?? [];

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <div className="p-4 pb-2">
        <NavBar />
      </div>

      {/* Sticky header */}
      <div className="sticky top-0 z-10 bg-zinc-950/90 backdrop-blur border-b border-zinc-800 px-4 py-2 flex items-center gap-3">
        <h1 className="text-sm font-bold text-white tracking-wide">RELATIVE ROTATION GRAPH</h1>
        {data && (
          <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-400 text-xs font-mono">
            DATA: {data.dataDate}
          </span>
        )}
      </div>

      {/* Controls */}
      <div className="px-4 py-2 flex flex-wrap items-center gap-3 border-b border-zinc-800 bg-zinc-900/40">
        {/* Universe */}
        <div className="flex rounded-lg overflow-hidden border border-zinc-700">
          {(['indices', 'nifty50'] as const).map(u => (
            <button
              key={u}
              onClick={() => setUniverse(u)}
              className={`px-3 py-1.5 text-xs font-bold transition-colors ${
                universe === u
                  ? 'bg-emerald-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {u === 'indices' ? 'Indices' : 'Nifty 50'}
            </button>
          ))}
        </div>

        {/* Timeframe */}
        <div className="flex rounded-lg overflow-hidden border border-zinc-700">
          {(['daily', 'weekly'] as const).map(tf => (
            <button
              key={tf}
              onClick={() => setTimeframe(tf)}
              className={`px-3 py-1.5 text-xs font-bold capitalize transition-colors ${
                timeframe === tf
                  ? 'bg-blue-600 text-white'
                  : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {tf.charAt(0).toUpperCase() + tf.slice(1)}
            </button>
          ))}
        </div>

        {/* Tail count */}
        <div className="flex items-center gap-1.5">
          <span className="text-xs text-zinc-400">Tail:</span>
          <input
            type="number"
            min={1}
            max={30}
            value={tailCount}
            onChange={e =>
              setTailCount(Math.max(1, Math.min(30, parseInt(e.target.value) || 1)))
            }
            className="w-14 px-2 py-1.5 text-xs text-center bg-zinc-800 border border-zinc-700 rounded text-white"
          />
        </div>

        {/* Playback controls */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setIsPlaying(false); setPlayhead(0); }}
            className="px-2 py-1.5 text-xs bg-zinc-800 border border-zinc-700 rounded text-zinc-300 hover:text-white"
            title="Reset to start"
          >
            &#9198;
          </button>
          <button
            onClick={() => {
              if (playhead >= maxPlayhead) setPlayhead(0);
              setIsPlaying(p => !p);
            }}
            className="px-3 py-1.5 text-xs font-bold bg-zinc-800 border border-zinc-700 rounded text-zinc-300 hover:text-white min-w-[72px]"
          >
            {isPlaying ? '⏸ Pause' : '▶ Play'}
          </button>
          <div className="flex items-center gap-0.5">
            {(['slow', 'normal', 'fast'] as const).map(s => (
              <button
                key={s}
                onClick={() => setSpeed(s)}
                className={`px-2 py-1 text-xs rounded ${
                  speed === s ? 'bg-zinc-600 text-white' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {s.charAt(0).toUpperCase() + s.slice(1)}
              </button>
            ))}
          </div>
        </div>

        {currentDate && (
          <span className="ml-auto text-xs font-mono text-zinc-400">{currentDate}</span>
        )}
      </div>

      {/* Main content */}
      <div className="flex flex-1 min-h-0">
        {/* Symbol panel */}
        <div className="w-48 flex-shrink-0 border-r border-zinc-800 overflow-y-auto p-2">
          {universe === 'nifty50' && (
            <input
              type="text"
              placeholder="Search..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full px-2 py-1.5 mb-2 text-xs bg-zinc-800 border border-zinc-700 rounded text-white placeholder-zinc-500"
            />
          )}
          <div className="flex gap-2 mb-2 px-0.5">
            <button
              onClick={() => data && setActiveSymbols(new Set(data.symbols.map(s => s.symbol)))}
              className="text-xs text-zinc-400 hover:text-white"
            >
              All
            </button>
            <span className="text-zinc-700">·</span>
            <button
              onClick={() => setActiveSymbols(new Set())}
              className="text-xs text-zinc-400 hover:text-white"
            >
              None
            </button>
          </div>
          {filteredSymbols.map(s => (
            <label key={s.symbol} className="flex items-center gap-1.5 py-0.5 cursor-pointer group">
              <input
                type="checkbox"
                checked={activeSymbols.has(s.symbol)}
                onChange={() => toggleSymbol(s.symbol)}
                className="sr-only"
              />
              <span
                className="w-3 h-3 flex-shrink-0 rounded-sm border transition-colors"
                style={{
                  backgroundColor: activeSymbols.has(s.symbol) ? s.color : 'transparent',
                  borderColor: s.color,
                }}
              />
              <span className="text-xs text-zinc-300 group-hover:text-white truncate">
                {s.label}
              </span>
            </label>
          ))}
        </div>

        {/* Chart area */}
        <div className="flex-1 flex items-center justify-center p-4 overflow-hidden">
          {loading && (
            <div className="text-zinc-400 text-sm">Loading...</div>
          )}

          {!loading && !data && (
            <div className="text-zinc-500 text-sm">No data</div>
          )}

          {!loading && data && (
            <svg
              viewBox={`0 0 ${SVG_W} ${SVG_H}`}
              className="w-full h-full"
              style={{ maxWidth: SVG_W, maxHeight: SVG_H }}
            >
              {/* Quadrant fills */}
              {/* LEADING: top-right  x>100, y>100 */}
              <rect
                x={cx100} y={M.top}
                width={M.left + CW - cx100} height={cy100 - M.top}
                fill="rgba(34,197,94,0.10)"
              />
              {/* WEAKENING: bottom-right  x>100, y<100 */}
              <rect
                x={cx100} y={cy100}
                width={M.left + CW - cx100} height={M.top + CH - cy100}
                fill="rgba(234,179,8,0.10)"
              />
              {/* LAGGING: bottom-left  x<100, y<100 */}
              <rect
                x={M.left} y={cy100}
                width={cx100 - M.left} height={M.top + CH - cy100}
                fill="rgba(239,68,68,0.10)"
              />
              {/* IMPROVING: top-left  x<100, y>100 */}
              <rect
                x={M.left} y={M.top}
                width={cx100 - M.left} height={cy100 - M.top}
                fill="rgba(6,182,212,0.10)"
              />

              {/* Chart border */}
              <rect
                x={M.left} y={M.top} width={CW} height={CH}
                fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth={1}
              />

              {/* Centre axes */}
              <line
                x1={M.left} y1={cy100} x2={M.left + CW} y2={cy100}
                stroke="rgba(255,255,255,0.20)" strokeWidth={1}
              />
              <line
                x1={cx100} y1={M.top} x2={cx100} y2={M.top + CH}
                stroke="rgba(255,255,255,0.20)" strokeWidth={1}
              />

              {/* Quadrant labels */}
              <text x={M.left + CW - 6} y={M.top + 14} textAnchor="end"
                fontSize={10} fontWeight="bold" fill="rgba(34,197,94,0.65)">LEADING</text>
              <text x={M.left + CW - 6} y={M.top + CH - 6} textAnchor="end"
                fontSize={10} fontWeight="bold" fill="rgba(234,179,8,0.65)">WEAKENING</text>
              <text x={M.left + 6} y={M.top + CH - 6} textAnchor="start"
                fontSize={10} fontWeight="bold" fill="rgba(239,68,68,0.65)">LAGGING</text>
              <text x={M.left + 6} y={M.top + 14} textAnchor="start"
                fontSize={10} fontWeight="bold" fill="rgba(6,182,212,0.65)">IMPROVING</text>

              {/* Axis titles */}
              <text
                x={M.left + CW / 2} y={SVG_H - 8}
                textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.35)"
              >
                JdK RS-Ratio &#8594;
              </text>
              <text
                x={14} y={M.top + CH / 2}
                textAnchor="middle" fontSize={9} fill="rgba(255,255,255,0.35)"
                transform={`rotate(-90,14,${M.top + CH / 2})`}
              >
                &#8593; JdK RS-Momentum
              </text>

              {/* Symbol trails */}
              {data.symbols
                .filter(s => activeSymbols.has(s.symbol))
                .map(s => {
                  const start = Math.max(0, playhead - tailCount + 1);
                  const tail = s.history.slice(start, playhead + 1);
                  if (tail.length === 0) return null;

                  const head = tail[tail.length - 1];
                  const prev = tail.length > 1 ? tail[tail.length - 2] : null;
                  const hx = xS(head.rsRatio), hy = yS(head.rsMomentum);

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
                    arrow = <polygon points={`${tip} ${bl} ${br}`} fill={s.color} opacity={0.85} />;
                  }

                  return (
                    <g key={s.symbol}>
                      {/* Trail polyline */}
                      <polyline
                        points={tail.map(p => `${xS(p.rsRatio)},${yS(p.rsMomentum)}`).join(' ')}
                        fill="none"
                        stroke={s.color}
                        strokeWidth={1.5}
                        strokeOpacity={0.7}
                      />
                      {/* Fading dots along tail */}
                      {tail.map((p, i) => (
                        <circle
                          key={i}
                          cx={xS(p.rsRatio)}
                          cy={yS(p.rsMomentum)}
                          r={i === tail.length - 1 ? 5 : 2}
                          fill={s.color}
                          opacity={0.2 + 0.8 * ((i + 1) / tail.length)}
                        />
                      ))}
                      {arrow}
                      {/* Symbol label at head */}
                      <text
                        x={hx + 8} y={hy + 4}
                        fontSize={9} fill={s.color} fontWeight="bold"
                      >
                        {s.label}
                      </text>
                    </g>
                  );
                })}
            </svg>
          )}
        </div>
      </div>
    </div>
  );
}
