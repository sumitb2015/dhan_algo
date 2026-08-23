'use client';

/**
 * Payoff-at-expiry chart for the strategy builder.
 *
 * Hand-rolled SVG rather than recharts — recharts can't stroke a single line in two
 * colors split at y=0, so the old ComposedChart version drew a single pale line
 * regardless of profit/loss and only tinted the fill gradient underneath. This follows
 * the same clip-path-per-sign technique as components/analytics/PositionsPayoffChart.tsx
 * (the two components read as one family) so the line itself goes green above zero and
 * red below it.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

interface PayoffDiagramProps {
  curve: { spot: number; pnl: number }[];
  currentSpot: number;
  breakevens: number[];
}

const STEP = 50;
const H = 320;
const PAD = { top: 16, right: 20, bottom: 28, left: 68 };

function fmtInr(v: number): string {
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const sign = v > 0 ? '+' : '-';
  if (abs >= 1000) return `${sign}₹${(abs / 1000).toFixed(1).replace('.0', '')}k`;
  return `${sign}₹${abs.toFixed(0)}`;
}

/** "Nice" tick values covering [lo, hi] — same helper as PositionsPayoffChart. */
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

/** P&L on a piecewise-linear curve at an arbitrary spot, by interpolation. */
function pnlAt(curve: { spot: number; pnl: number }[], spot: number): number | null {
  if (curve.length < 2) return null;
  if (spot <= curve[0].spot) return curve[0].pnl;
  if (spot >= curve[curve.length - 1].spot) return curve[curve.length - 1].pnl;
  let lo = 0, hi = curve.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (curve[mid].spot <= spot) lo = mid; else hi = mid;
  }
  const a = curve[lo], b = curve[hi];
  if (b.spot === a.spot) return a.pnl;
  return a.pnl + ((spot - a.spot) / (b.spot - a.spot)) * (b.pnl - a.pnl);
}

export default function PayoffDiagram({ curve, currentSpot, breakevens }: PayoffDiagramProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverSpot, setHoverSpot] = useState<number | null>(null);
  const [boxW, setBoxW] = useState(900);
  const roRef = useRef<ResizeObserver | null>(null);

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

  const W = Math.max(480, Math.round(boxW));

  const model = useMemo(() => {
    if (curve.length === 0) return null;

    // --- Smart X domain: cover all key points with tight padding ---
    const allStrikes = curve
      .filter((_, i) => i === 0 || i === curve.length - 1 ||
        Math.abs(curve[i].pnl - curve[i - 1].pnl) > 0) // strike kinks
      .map((c) => c.spot);
    const keyX = [...breakevens, currentSpot, ...allStrikes];
    const rawMin = Math.min(...keyX);
    const rawMax = Math.max(...keyX);
    const pad = Math.max(STEP * 4, (rawMax - rawMin) * 0.12);
    const xLo = rawMin - pad;
    const xHi = rawMax + pad;

    const visible = curve.filter((c) => c.spot >= xLo && c.spot <= xHi);
    if (visible.length < 2) return null;

    // --- Smart Y domain: clamp so zero-crossing is prominent ---
    const visiblePnls = visible.map((c) => c.pnl);
    const rawYMin = Math.min(...visiblePnls);
    const rawYMax = Math.max(...visiblePnls);
    // For unlimited-loss strategies, cap the loss tail at 3x max profit so the
    // P=0 region stays in the upper ~25% of the chart instead of near the bottom.
    const clampedYMin = rawYMax > 0 ? Math.max(rawYMin, -rawYMax * 3) : rawYMin * 1.1;
    const clampedYMax = rawYMin < 0 ? Math.min(rawYMax, Math.abs(rawYMin) * 3) : rawYMax * 1.1;
    const yPad = (clampedYMax - clampedYMin) * 0.08 || 1;
    const yLo = clampedYMin - yPad;
    const yHi = clampedYMax + yPad;

    const sx = (x: number) => PAD.left + ((x - xLo) / (xHi - xLo)) * (W - PAD.left - PAD.right);
    const sy = (y: number) => PAD.top + ((yHi - y) / (yHi - yLo)) * (H - PAD.top - PAD.bottom);

    const line = visible.map((p, i) => `${i ? 'L' : 'M'}${sx(p.spot).toFixed(1)},${sy(p.pnl).toFixed(1)}`).join('');
    const area = `${line}L${sx(xHi).toFixed(1)},${sy(0).toFixed(1)}L${sx(xLo).toFixed(1)},${sy(0).toFixed(1)}Z`;

    return {
      xLo, xHi, yLo, yHi, sx, sy, line, area,
      zeroY: sy(0),
      xTicks: niceTicks(xLo, xHi, 6),
      yTicks: niceTicks(yLo, yHi, 6),
      visible,
    };
  }, [curve, currentSpot, breakevens, W]);

  if (!model) return null;

  const { sx, sy, xLo, xHi, zeroY } = model;

  const readoutSpot = hoverSpot ?? currentSpot;
  const readoutPnl = pnlAt(model.visible, readoutSpot);

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.left) / (W - PAD.left - PAD.right);
    if (frac < 0 || frac > 1) { setHoverSpot(null); return; }
    setHoverSpot(xLo + frac * (xHi - xLo));
  };

  const tooltipLeft = sx(readoutSpot) > W * 0.6;

  return (
    <div ref={boxRef} className="w-full">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H}`}
        width={W}
        height={H}
        className="block max-w-full select-none"
        role="img"
        aria-label="Strategy payoff at expiry"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverSpot(null)}
      >
        <defs>
          <clipPath id="sb-clip-profit"><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
          <clipPath id="sb-clip-loss"><rect x={0} y={zeroY} width={W} height={H - zeroY} /></clipPath>
        </defs>

        {/* Y grid + rupee axis */}
        {model.yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)}
              stroke="#27272a" strokeWidth={1} strokeDasharray={t === 0 ? undefined : '3 4'} />
            <text x={PAD.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fill="#71717a" className="font-mono">
              {fmtInr(t)}
            </text>
          </g>
        ))}

        {/* X axis */}
        {model.xTicks.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H - PAD.bottom + 17} textAnchor="middle" fontSize={10}
            fill="#71717a" className="font-mono">
            {t.toFixed(0)}
          </text>
        ))}

        {/* Payoff curve: green above zero, red below */}
        <g clipPath="url(#sb-clip-profit)"><path d={model.area} fill="#10b981" fillOpacity={0.18} /></g>
        <g clipPath="url(#sb-clip-loss)"><path d={model.area} fill="#ef4444" fillOpacity={0.18} /></g>
        <g clipPath="url(#sb-clip-profit)"><path d={model.line} fill="none" stroke="#10b981" strokeWidth={2} /></g>
        <g clipPath="url(#sb-clip-loss)"><path d={model.line} fill="none" stroke="#ef4444" strokeWidth={2} /></g>

        <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke="#52525b" strokeWidth={1.25} />

        {/* Breakevens */}
        {breakevens.filter((b) => b >= xLo && b <= xHi).map((be) => (
          <g key={`be${be}`}>
            <circle cx={sx(be)} cy={zeroY} r={4} fill="#f59e0b" stroke="#09090b" strokeWidth={2} />
            <text x={sx(be)} y={zeroY - 9} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fbbf24" className="font-mono">
              BE {be.toFixed(0)}
            </text>
          </g>
        ))}

        {/* Current spot marker */}
        {currentSpot >= xLo && currentSpot <= xHi && (
          <g>
            <line x1={sx(currentSpot)} x2={sx(currentSpot)} y1={PAD.top} y2={H - PAD.bottom}
              stroke="#0ea5e9" strokeWidth={1.25} strokeDasharray="4 3" />
            <text x={sx(currentSpot)} y={PAD.top - 5} textAnchor="middle" fontSize={10} fontWeight={700}
              fill="#38bdf8" className="font-mono">
              {currentSpot.toFixed(0)}
            </text>
          </g>
        )}

        {/* Readout crosshair — follows the cursor, parks on current spot otherwise */}
        {readoutSpot >= xLo && readoutSpot <= xHi && readoutPnl !== null && (
          <g pointerEvents="none">
            <line x1={sx(readoutSpot)} x2={sx(readoutSpot)} y1={PAD.top} y2={H - PAD.bottom}
              stroke="#a1a1aa" strokeWidth={1} strokeDasharray="2 3" />
            <circle cx={sx(readoutSpot)} cy={sy(readoutPnl)} r={4.5}
              fill={readoutPnl >= 0 ? '#10b981' : '#ef4444'} stroke="#09090b" strokeWidth={2} />
            <g transform={`translate(${tooltipLeft ? sx(readoutSpot) - 118 : sx(readoutSpot) + 10}, ${PAD.top + 4})`}>
              <rect width={108} height={34} rx={6} fill="#09090b" fillOpacity={0.9} stroke="#3f3f46" />
              <text x={8} y={13} fontSize={9.5} fill="#a1a1aa" className="font-mono">
                Spot {readoutSpot.toFixed(0)}
              </text>
              <text x={8} y={26} fontSize={11} fontWeight={700} className="font-mono"
                fill={readoutPnl >= 0 ? '#10b981' : '#ef4444'}>
                {readoutPnl >= 0 ? '+' : ''}₹{readoutPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </text>
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
