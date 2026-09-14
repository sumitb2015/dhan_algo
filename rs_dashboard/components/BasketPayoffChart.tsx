'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2 } from 'lucide-react';
import { useChartChrome } from '@/lib/chartTheme';

interface BasketPayoffChartProps {
  points: { x: number; y: number }[];   // expiry P&L curve
  breakevens: number[];
  spot: number;
  rightWing?: 'profit' | 'loss' | null;
  leftWing?: 'loss' | null;
  emptyReason?: string;
}

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

export default function BasketPayoffChart({ points, breakevens, spot, rightWing = null, leftWing = null, emptyReason }: BasketPayoffChartProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hover, setHover] = useState<{ x: number; y: number } | null>(null);
  const [boxW, setBoxW] = useState(760);
  const [full, setFull] = useState(false);
  const roRef = useRef<ResizeObserver | null>(null);
  const chrome = useChartChrome();

  const boxRef = useCallback((el: HTMLDivElement | null) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setBoxW(entry.contentRect.width));
    ro.observe(el);
    roRef.current = ro;
    setBoxW(el.clientWidth);
  }, []);

  useEffect(() => () => roRef.current?.disconnect(), []);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFull(false);
    };
    window.addEventListener('keydown', onKey);
    const origOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = origOverflow;
    };
  }, [full]);

  const W = Math.max(480, Math.round(boxW));
  const H_ = full ? Math.max(540, typeof window !== 'undefined' ? window.innerHeight - 150 : 540) : H;

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
    const sy = (y: number) => PAD.top + ((yHi - y) / (yHi - yLo)) * (H_ - PAD.top - PAD.bottom);

    const line = points.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    const area = `${line}L${sx(xHi).toFixed(1)},${sy(0).toFixed(1)}L${sx(xLo).toFixed(1)},${sy(0).toFixed(1)}Z`;

    return {
      xLo, xHi, yLo, yHi, sx, sy, line, area,
      zeroY: sy(0),
      xTicks: niceTicks(xLo, xHi, 6),
      yTicks: niceTicks(yLo, yHi, 5),
    };
  }, [points, W, H_]);

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
  const continuationY = Math.max(PAD.top + 12, Math.min(H_ - PAD.bottom - 8, sy(rightEdgePoint.y)));

  // leftWing is always 'loss' (never 'profit' — the underlying's floor at 0 caps
  // a net long put's profit, so there's no downside-unlimited-profit case).
  const leftEdgePoint = points[0];
  const leftContinuationY = Math.max(PAD.top + 12, Math.min(H_ - PAD.bottom - 8, sy(leftEdgePoint.y)));

  const chart = (
    <div
      ref={boxRef}
      className={
        full
          ? 'fixed inset-0 z-50 overflow-auto bg-zinc-950 p-4 md:p-6 flex flex-col'
          : 'w-full flex flex-col'
      }
    >
      {/* Header with spot, breakevens, and fullscreen toggle */}
      <div className="flex items-center justify-between pb-1.5 px-0.5 border-b border-zinc-800/80 mb-2 shrink-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
            Basket Payoff at Expiry
          </span>
          {spot > 0 && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-sky-400">
              Spot: {spot.toLocaleString('en-IN')}
            </span>
          )}
          {breakevens.length > 0 && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
              BE: {breakevens.map((b) => b.toFixed(0)).join(', ')}
            </span>
          )}
        </div>

        <button
          type="button"
          onClick={() => setFull((f) => !f)}
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-750 bg-zinc-900 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer"
          title={full ? 'Exit full screen (Esc)' : 'Full screen'}
          aria-label={full ? 'Exit full screen' : 'Full screen'}
        >
          {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          <span>{full ? 'Exit Full Screen' : 'Full Screen'}</span>
        </button>
      </div>

      <div className="flex-1 flex items-center justify-center min-h-0">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H_}`}
          width={W}
          height={H_}
          className="w-full h-auto select-none"
          role="img"
          aria-label="Strategy payoff at expiry"
          onMouseMove={onMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <clipPath id="basket-clip-profit"><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
            <clipPath id="basket-clip-loss"><rect x={0} y={zeroY} width={W} height={H_ - zeroY} /></clipPath>
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
            <text key={`x${t}`} x={sx(t)} y={H_ - PAD.bottom + 18} textAnchor="middle" fontSize={11} fill={chrome.textMuted} className="font-mono">
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

          {leftWing && (
            <g aria-label={`Left-side ${leftWing} continues beyond the displayed range`}>
              <path d={`M${PAD.left + 18},${leftContinuationY} L${PAD.left + 3},${leftContinuationY} M${PAD.left + 8},${leftContinuationY - 5} L${PAD.left + 3},${leftContinuationY} L${PAD.left + 8},${leftContinuationY + 5}`}
                fill="none" stroke="#fb7185" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
              <text x={PAD.left + 5} y={Math.max(PAD.top + 9, leftContinuationY - 8)} textAnchor="start" fontSize={9.5} fill="#fb7185" className="font-mono font-bold">
                unlimited {leftWing}
              </text>
            </g>
          )}

          {spot >= xLo && spot <= xHi && (
            <g>
              <line x1={sx(spot)} x2={sx(spot)} y1={PAD.top} y2={H_ - PAD.bottom} stroke="#38bdf8" strokeWidth={1} strokeDasharray="4 3" />
              <text x={sx(spot)} y={PAD.top - 8} textAnchor="middle" fontSize={10} fill="#38bdf8" className="font-mono font-bold">
                {spot.toLocaleString('en-IN', { maximumFractionDigits: 1 })}
              </text>
            </g>
          )}

          {breakevens.map(be => {
            const pct = spot > 0 ? ((be - spot) / spot) * 100 : null;
            const pctStr = pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '';
            return (
              <g key={be}>
                <circle cx={sx(be)} cy={zeroY} r={4} fill="#fbbf24" stroke={chrome.surface} strokeWidth={2} />
                <text x={sx(be)} y={zeroY - 8} textAnchor="middle" fontSize={9.5} fill="#fbbf24" className="font-mono">
                  {be.toLocaleString('en-IN', { maximumFractionDigits: 0 })}{pctStr}
                </text>
              </g>
            );
          })}

          {hover && (
            <g pointerEvents="none">
              <line x1={sx(hover.x)} x2={sx(hover.x)} y1={PAD.top} y2={H_ - PAD.bottom} stroke={chrome.textSecondary} strokeWidth={1} strokeDasharray="2 3" />
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
      </div>
    </div>
  );

  if (full && typeof document !== 'undefined') return createPortal(chart, document.body);
  return chart;
}
