'use client';

import React, { useState, useMemo, useRef } from 'react';
import { cn } from '@/lib/utils';
import { Eye, EyeOff, BarChart3, Maximize2 } from 'lucide-react';

export interface Candle {
  time: string;
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface SeriesPoint {
  time: string;
  value: number;
}

export interface SpreadPoint {
  time: string;
  value: number;
  pct: number;
  positive: boolean;
}

interface CyberChartProps {
  candles: Candle[];
  ema9Series: SeriesPoint[];
  ema20Series: SeriesPoint[];
  vwapSeries: SeriesPoint[];
  spreadSeries: SpreadPoint[];
  symbol: string;
  interval: string;
}

export default function CyberChart({
  candles,
  ema9Series,
  ema20Series,
  vwapSeries,
  spreadSeries,
  symbol,
  interval,
}: CyberChartProps) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);
  const [showEma9, setShowEma9] = useState(true);
  const [showEma20, setShowEma20] = useState(true);
  const [showVwap, setShowVwap] = useState(true);
  const [showSpread, setShowSpread] = useState(true);

  const containerRef = useRef<HTMLDivElement>(null);

  // Range and scaling
  const { minPrice, maxPrice, priceRange, minSpread, maxSpread, spreadRange } = useMemo(() => {
    if (!candles || candles.length === 0) {
      return { minPrice: 0, maxPrice: 100, priceRange: 100, minSpread: -10, maxSpread: 10, spreadRange: 20 };
    }

    let minP = Infinity;
    let maxP = -Infinity;

    candles.forEach((c) => {
      if (c.low < minP) minP = c.low;
      if (c.high > maxP) maxP = c.high;
    });

    ema9Series.forEach((p) => {
      if (p.value < minP) minP = p.value;
      if (p.value > maxP) maxP = p.value;
    });

    ema20Series.forEach((p) => {
      if (p.value < minP) minP = p.value;
      if (p.value > maxP) maxP = p.value;
    });

    vwapSeries.forEach((p) => {
      if (p.value < minP) minP = p.value;
      if (p.value > maxP) maxP = p.value;
    });

    // Padding
    const pPad = (maxP - minP) * 0.08 || 5;
    minP -= pPad;
    maxP += pPad;

    // Spread range
    let maxAbsSpread = 5;
    spreadSeries.forEach((s) => {
      const abs = Math.abs(s.value);
      if (abs > maxAbsSpread) maxAbsSpread = abs;
    });
    const sPad = maxAbsSpread * 0.2;
    const maxS = maxAbsSpread + sPad;
    const minS = -maxS;

    return {
      minPrice: minP,
      maxPrice: maxP,
      priceRange: maxP - minP || 1,
      minSpread: minS,
      maxSpread: maxS,
      spreadRange: maxS * 2 || 1,
    };
  }, [candles, ema9Series, ema20Series, vwapSeries, spreadSeries]);

  // Coordinate mappers (viewBox 0 0 1000 400 for main chart, 0 0 1000 120 for spread)
  const chartWidth = 1000;
  const mainHeight = 320;
  const spreadHeight = 90;

  const count = candles.length;
  const getX = (idx: number) => {
    if (count <= 1) return chartWidth / 2;
    return 30 + (idx / (count - 1)) * (chartWidth - 60);
  };

  const getY = (val: number) => {
    return mainHeight - 20 - ((val - minPrice) / priceRange) * (mainHeight - 40);
  };

  const getSpreadY = (val: number) => {
    return spreadHeight / 2 - (val / (maxSpread || 1)) * (spreadHeight / 2 - 10);
  };

  // Build SVG path strings
  const ema9Path = useMemo(() => {
    if (!showEma9 || ema9Series.length === 0) return '';
    return ema9Series
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(pt.value).toFixed(1)}`)
      .join(' ');
  }, [ema9Series, showEma9, minPrice, priceRange, count]);

  const ema20Path = useMemo(() => {
    if (!showEma20 || ema20Series.length === 0) return '';
    return ema20Series
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(pt.value).toFixed(1)}`)
      .join(' ');
  }, [ema20Series, showEma20, minPrice, priceRange, count]);

  const vwapPath = useMemo(() => {
    if (!showVwap || vwapSeries.length === 0) return '';
    return vwapSeries
      .map((pt, i) => `${i === 0 ? 'M' : 'L'} ${getX(i).toFixed(1)} ${getY(pt.value).toFixed(1)}`)
      .join(' ');
  }, [vwapSeries, showVwap, minPrice, priceRange, count]);

  const activeIdx = hoverIndex !== null ? hoverIndex : count - 1;
  const activeCandle = candles[activeIdx];
  const activeEma9 = ema9Series[activeIdx];
  const activeEma20 = ema20Series[activeIdx];
  const activeVwap = vwapSeries[activeIdx];
  const activeSpread = spreadSeries[activeIdx];

  const handleMouseMove = (e: React.MouseEvent<SVGSVGElement>) => {
    if (!containerRef.current || count === 0) return;
    const rect = containerRef.current.getBoundingClientRect();
    const clientX = e.clientX - rect.left;
    const pct = Math.max(0, Math.min(1, clientX / rect.width));
    const idx = Math.round(pct * (count - 1));
    setHoverIndex(idx);
  };

  return (
    <div className="bg-zinc-900/60 border border-zinc-800/80 rounded-2xl p-4 lg:p-5 backdrop-blur-md flex flex-col gap-3">
      {/* Chart Title & Toggle Bar */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-1.5 font-mono text-xs font-bold text-white">
            <BarChart3 className="w-4 h-4 text-cyan-400" />
            <span>{symbol} {interval}m INTRADAY</span>
          </div>

          {activeCandle && (
            <div className="flex items-center gap-2 text-[11px] font-mono text-zinc-400">
              <span>T: <b className="text-zinc-200">{activeCandle.time}</b></span>
              <span>O: <b className="text-zinc-200">{activeCandle.open.toFixed(1)}</b></span>
              <span>H: <b className="text-zinc-200">{activeCandle.high.toFixed(1)}</b></span>
              <span>L: <b className="text-zinc-200">{activeCandle.low.toFixed(1)}</b></span>
              <span>C: <b className={activeCandle.close >= activeCandle.open ? 'text-emerald-400' : 'text-rose-400'}>{activeCandle.close.toFixed(1)}</b></span>
            </div>
          )}
        </div>

        {/* Indicator Toggles */}
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setShowEma9(!showEma9)}
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1 border transition-all',
              showEma9
                ? 'bg-cyan-500/15 border-cyan-500/40 text-cyan-300'
                : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500'
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            EMA 9 {activeEma9 && `(${activeEma9.value.toFixed(1)})`}
          </button>

          <button
            onClick={() => setShowEma20(!showEma20)}
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1 border transition-all',
              showEma20
                ? 'bg-purple-500/15 border-purple-500/40 text-purple-300'
                : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500'
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400" />
            EMA 20 {activeEma20 && `(${activeEma20.value.toFixed(1)})`}
          </button>

          <button
            onClick={() => setShowVwap(!showVwap)}
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1 border transition-all',
              showVwap
                ? 'bg-amber-500/15 border-amber-500/40 text-amber-300'
                : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500'
            )}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-amber-400" />
            VWAP {activeVwap && `(${activeVwap.value.toFixed(1)})`}
          </button>

          <button
            onClick={() => setShowSpread(!showSpread)}
            className={cn(
              'px-2 py-0.5 rounded text-[10px] font-mono font-bold flex items-center gap-1 border transition-all',
              showSpread
                ? 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'
                : 'bg-zinc-800/50 border-zinc-700/50 text-zinc-500'
            )}
          >
            <span>SPREAD</span>
            {activeSpread && (
              <span className={activeSpread.value >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                {activeSpread.value >= 0 ? '+' : ''}{activeSpread.value.toFixed(2)}
              </span>
            )}
          </button>
        </div>
      </div>

      {/* SVG Interactive Chart Canvas */}
      <div
        ref={containerRef}
        className="w-full relative select-none cursor-crosshair bg-zinc-950/80 border border-zinc-800/80 rounded-xl overflow-hidden"
      >
        <svg
          viewBox={`0 0 ${chartWidth} ${mainHeight + (showSpread ? spreadHeight + 20 : 0)}`}
          className="w-full h-[320px] lg:h-[400px] overflow-visible"
          onMouseMove={handleMouseMove}
          onMouseLeave={() => setHoverIndex(null)}
        >
          <defs>
            {/* Gradient glow for EMA9 and EMA20 */}
            <linearGradient id="cyberEma9Grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#06b6d4" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#22d3ee" stopOpacity="1" />
            </linearGradient>
            <linearGradient id="cyberEma20Grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#8b5cf6" stopOpacity="0.8" />
              <stop offset="100%" stopColor="#c084fc" stopOpacity="1" />
            </linearGradient>
          </defs>

          {/* Grid lines */}
          {[0.2, 0.4, 0.6, 0.8].map((ratio, idx) => {
            const y = mainHeight * ratio;
            const price = maxPrice - ratio * priceRange;
            return (
              <g key={`grid-${idx}`}>
                <line
                  x1="20"
                  y1={y}
                  x2={chartWidth - 20}
                  y2={y}
                  stroke="#27272a"
                  strokeDasharray="4 6"
                  strokeWidth="1"
                />
                <text
                  x={chartWidth - 15}
                  y={y + 3}
                  fill="#71717a"
                  fontSize="9"
                  fontFamily="monospace"
                  textAnchor="end"
                >
                  {price.toFixed(1)}
                </text>
              </g>
            );
          })}

          {/* Candlesticks */}
          {candles.map((c, i) => {
            const x = getX(i);
            const isGreen = c.close >= c.open;
            const candleColor = isGreen ? '#10b981' : '#f43f5e';
            const yHigh = getY(c.high);
            const yLow = getY(c.low);
            const yOpen = getY(c.open);
            const yClose = getY(c.close);
            const bodyTop = Math.min(yOpen, yClose);
            const bodyHeight = Math.max(2, Math.abs(yOpen - yClose));
            const candleWidth = Math.max(2, Math.min(6, (chartWidth / count) * 0.6));

            return (
              <g key={`c-${i}`}>
                {/* Wick */}
                <line
                  x1={x}
                  y1={yHigh}
                  x2={x}
                  y2={yLow}
                  stroke={candleColor}
                  strokeWidth="1"
                />
                {/* Body */}
                <rect
                  x={x - candleWidth / 2}
                  y={bodyTop}
                  width={candleWidth}
                  height={bodyHeight}
                  fill={candleColor}
                  rx="1"
                />
              </g>
            );
          })}

          {/* VWAP Line */}
          {showVwap && vwapPath && (
            <path
              d={vwapPath}
              fill="none"
              stroke="#eab308"
              strokeWidth="1.5"
              strokeDasharray="3 3"
              opacity="0.9"
            />
          )}

          {/* EMA 20 Line */}
          {showEma20 && ema20Path && (
            <path
              d={ema20Path}
              fill="none"
              stroke="url(#cyberEma20Grad)"
              strokeWidth="2"
            />
          )}

          {/* EMA 9 Line */}
          {showEma9 && ema9Path && (
            <path
              d={ema9Path}
              fill="none"
              stroke="url(#cyberEma9Grad)"
              strokeWidth="2"
            />
          )}

          {/* Crosshair Cursor */}
          {hoverIndex !== null && (
            <g>
              <line
                x1={getX(hoverIndex)}
                y1={10}
                x2={getX(hoverIndex)}
                y2={mainHeight + (showSpread ? spreadHeight + 10 : 0)}
                stroke="#a1a1aa"
                strokeWidth="1"
                strokeDasharray="2 4"
                opacity="0.6"
              />
              <circle
                cx={getX(hoverIndex)}
                cy={getY(candles[hoverIndex]?.close || 0)}
                r="4"
                fill="#38bdf8"
                stroke="#0284c7"
                strokeWidth="2"
              />
            </g>
          )}

          {/* Bottom Sub-Panel: Spread Histogram */}
          {showSpread && (
            <g transform={`translate(0, ${mainHeight + 10})`}>
              {/* Divider */}
              <line
                x1="20"
                y1="0"
                x2={chartWidth - 20}
                y2="0"
                stroke="#3f3f46"
                strokeWidth="1"
              />
              <text
                x="30"
                y="12"
                fill="#a1a1aa"
                fontSize="9"
                fontFamily="monospace"
                fontWeight="bold"
              >
                EMA SPREAD DELTA (9 - 20)
              </text>

              {/* Zero baseline */}
              <line
                x1="20"
                y1={spreadHeight / 2}
                x2={chartWidth - 20}
                y2={spreadHeight / 2}
                stroke="#52525b"
                strokeDasharray="2 4"
                strokeWidth="1"
              />

              {/* Spread Bars */}
              {spreadSeries.map((s, i) => {
                const x = getX(i);
                const zeroY = spreadHeight / 2;
                const barY = getSpreadY(s.value);
                const top = Math.min(zeroY, barY);
                const h = Math.max(1, Math.abs(zeroY - barY));
                const barWidth = Math.max(1.5, Math.min(5, (chartWidth / count) * 0.5));
                const barColor = s.positive ? '#06b6d4' : '#f43f5e';

                return (
                  <rect
                    key={`sp-${i}`}
                    x={x - barWidth / 2}
                    y={top}
                    width={barWidth}
                    height={h}
                    fill={barColor}
                    opacity="0.85"
                    rx="0.5"
                  />
                );
              })}
            </g>
          )}
        </svg>
      </div>
    </div>
  );
}
