'use client';

import React, { useMemo, useRef, useState } from 'react';
import { useChartChrome } from '@/lib/chartTheme';

interface BasketPayoffChartProps {
  points: { x: number; y: number }[];   // expiry P&L curve
  breakevens: number[];
  spot: number;
  rightWing?: 'profit' | 'loss' | null;
  emptyReason?: string;
}

const W = 760;
const H = 344;
const PAD = { top: 28, right: 20, bottom: 40, left: 64 };

function fmtInr(n: number): string {
  const abs = Math.abs(n);
  const s = abs >= 1000
    ? abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })
    : abs.toLocaleString('en-IN', { maximumFractionDigits: 1 });
  return `${n < 0 ? '-' : ''}₹${s}`;
}

/** "Nice" tick values covering [lo, hi]. */
function niceTicks(lo: number, hi: number, count: number): number[] {
  const span = hi - lo;
  if (span <= 0) return [lo];
  const raw = span / count;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1) * mag;
  const ticks: number[] = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) ticks.push(v);
  return ticks;
}

export default function BasketPayoffChart({ points, breakevens, spot, rightWing = null, emptyReason }: BasketPayoffChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const chrome = useChartChrome();

  const model = useMemo(() => {
    if (points.length < 2) return null;
    const xLo = points[0].x;
    const xHi = points[points.length - 1].x;
    let yLo = Math.min(0, ...points.map(p => p.y));
    let yHi = Math.max(0, ...points.map(p => p.y));
    if (yHi === yLo) { yHi += 1; yLo -= 1; }
    const yPadding = (yHi - yLo) * 0.08;
    yLo -= yPadding; yHi += yPadding;

    const sx = (x: number) => PAD.left + ((x - xLo) / (xHi - xLo)) * (W - PAD.left - PAD.right);
    const sy = (y: number) => PAD.top + ((yHi - y) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

    const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    const area = `${line}L${sx(xHi).toFixed(1)},${sy(0).toFixed(1)}L${sx(xLo).toFixed(1)},${sy(0).toFixed(1)}Z`;

    return {
      xLo, xHi, yLo, yHi, sx, sy, line, area,
      zeroY: sy(0),
      xTicks: niceTicks(xLo, xHi, 6),
      yTicks: niceTicks(yLo, yHi, 5),
    };
  }, [points]);

  if (!model) {
    return (
      <div className="flex flex-col items-center justify-center h-80 gap-1.5 text-zinc-500">
        <p className="text-sm font-semibold text-zinc-400">No payoff to show yet</p>
        <p className="text-xs">{emptyReason ?? 'Pick a strategy or add legs with valid prices'}</p>
      </div>
    );
  }

  const { sx, sy, xLo, xHi, zeroY } = model;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.left) / (W - PAD.left - PAD.right);
    if (frac < 0 || frac > 1) { setHover(null); return; }
    const x = xLo + frac * (xHi - xLo);

    let lo = 0, hi = points.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (points[mid].x < x) lo = mid + 1; else hi = mid;
    }
    if (lo > 0 && Math.abs(points[lo - 1].x - x) < Math.abs(points[lo].x - x)) lo -= 1;
    setHover(points[lo]);
  };

  const hoverLeft = hover ? sx(hover.x) > W * 0.62 : false;
  const rightEdgePoint = points[points.length - 1];
  const continuationColor = rightWing === 'profit' ? '#34d399' : '#fb7185';
  const continuationY = Math.max(PAD.top + 12, Math.min(H - PAD.bottom - 8, sy(rightEdgePoint.y)));

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      className="w-full h-auto select-none"
      role="img"
      aria-label="Strategy payoff at expiry"
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <defs>
        <clipPath id="basket-clip-profit"><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
        <clipPath id="basket-clip-loss"><rect x={0} y={zeroY} width={W} height={H - zeroY} /></clipPath>
      </defs>

      {model.yTicks.map(t => (
        <g key={`y${t}`}>
          <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)} stroke={chrome.gridline} strokeWidth={1} />
          <text x={PAD.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={11} fill={chrome.textMuted} className="font-mono">
            {Math.abs(t) >= 1000 ? `${(t / 1000).toFixed(t % 1000 === 0 ? 0 : 1)}k` : t.toFixed(0)}
          </text>
        </g>
      ))}
      {model.xTicks.map(t => (
        <text key={`x${t}`} x={sx(t)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize={11} fill={chrome.textMuted} className="font-mono">
          {t.toLocaleString('en-IN')}
        </text>
      ))}

      <g clipPath="url(#basket-clip-profit)">
        <path d={model.area} fill="#34d399" fillOpacity={0.22} />
      </g>
      <g clipPath="url(#basket-clip-loss)">
        <path d={model.area} fill="#fb7185" fillOpacity={0.22} />
      </g>
      <g clipPath="url(#basket-clip-profit)">
        <path d={model.line} fill="none" stroke="#34d399" strokeWidth={2} />
      </g>
      <g clipPath="url(#basket-clip-loss)">
        <path d={model.line} fill="none" stroke="#fb7185" strokeWidth={2} />
      </g>

      <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke={chrome.baseline} strokeWidth={1.25} />

      {rightWing && (
        <g aria-label={`Right-side ${rightWing} continues beyond the displayed range`}>
          <path d={`M${W - PAD.right - 18},${continuationY} L${W - PAD.right - 3},${continuationY} M${W - PAD.right - 8},${continuationY - 5} L${W - PAD.right - 3},${continuationY} L${W - PAD.right - 8},${continuationY + 5}`}
            fill="none" stroke={continuationColor} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          <text x={W - PAD.right - 5} y={Math.max(PAD.top + 9, continuationY - 8)} textAnchor="end" fontSize={9.5} fill={continuationColor} className="font-mono font-bold">
            unlimited {rightWing}
          </text>
        </g>
      )}

      {spot >= xLo && spot <= xHi && (
        <g>
          <line x1={sx(spot)} x2={sx(spot)} y1={PAD.top} y2={H - PAD.bottom} stroke="#38bdf8" strokeWidth={1} strokeDasharray="4 3" />
          <text x={sx(spot)} y={PAD.top - 8} textAnchor="middle" fontSize={10} fill="#38bdf8" className="font-mono font-bold">
            {spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
          </text>
        </g>
      )}

      {breakevens.map(be => (
        <g key={be}>
          <circle cx={sx(be)} cy={zeroY} r={4} fill="#fbbf24" stroke={chrome.surface} strokeWidth={2} />
          <text x={sx(be)} y={zeroY - 8} textAnchor="middle" fontSize={9.5} fill="#fbbf24" className="font-mono">
            {be.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </text>
        </g>
      ))}

      {hover && (
        <g pointerEvents="none">
          <line x1={sx(hover.x)} x2={sx(hover.x)} y1={PAD.top} y2={H - PAD.bottom} stroke={chrome.textSecondary} strokeWidth={1} strokeDasharray="2 3" />
          <circle cx={sx(hover.x)} cy={sy(hover.y)} r={4.5}
            fill={hover.y >= 0 ? '#34d399' : '#fb7185'} stroke={chrome.surface} strokeWidth={2} />
          <g transform={`translate(${hoverLeft ? sx(hover.x) - 148 : sx(hover.x) + 10}, ${PAD.top + 4})`}>
            <rect width={138} height={44} rx={8} fill={chrome.surface} stroke={chrome.baseline} />
            <text x={10} y={17} fontSize={10} fill={chrome.textSecondary} className="font-mono">
              At {hover.x.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </text>
            <text x={10} y={33} fontSize={12} fontWeight={700} className="font-mono"
              fill={hover.y >= 0 ? '#34d399' : '#fb7185'}>
              {fmtInr(hover.y)}
            </text>
          </g>
        </g>
      )}
    </svg>
  );
}
