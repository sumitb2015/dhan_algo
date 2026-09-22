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
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';

interface PayoffDiagramProps {
  curve: { spot: number; pnl: number }[];
  currentSpot: number;
  breakevens: number[];
  /** Live mark-to-market curve — each leg priced today (Black-76/Black-Scholes
   *  at current spot, IV and time-to-expiry) rather than at intrinsic value.
   *  Optional: a caller with no IV/time-to-expiry data yet (or that fails to
   *  price a leg) simply omits it and only the expiry curve renders — this
   *  component never blocks on it. dhan-payoff-diagrams mandates plotting
   *  this whenever a per-leg IV is available, so every payoff diagram in the
   *  dashboard shows both "at expiry" and "right now" on the same axes,
   *  matching the Options Monitor's T+0 line. */
  todayCurve?: { spot: number; pnl: number }[];
}

const TODAY_COLOR = '#2d7ff9'; // matches Options Monitor's PAYOFF_TODAY

const STEP = 50;
const H = 320;
const PAD = { top: 16, right: 20, bottom: 28, left: 68 };

// Zoom multiplies the breakeven-scaled half-width of the X domain. 1 = the
// default "scaled to breakevens" view; > 1 widens back out (capped at the
// full all-strikes extent, so Zoom Out never over-shoots into empty axis);
// < 1 narrows further for a very tight cluster of breakevens.
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.35;

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

export default function PayoffDiagram({ curve, currentSpot, breakevens, todayCurve }: PayoffDiagramProps) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverSpot, setHoverSpot] = useState<number | null>(null);
  const [boxW, setBoxW] = useState(900);
  const [full, setFull] = useState(false);
  const [zoom, setZoom] = useState(1);
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
    if (curve.length === 0) return null;

    // --- Smart X domain: scaled to the breakevens, not the full strike range ---
    // A wide wing/hedge strike far from the breakevens used to dominate the
    // domain and squeeze the actual profit/loss transition into a sliver in
    // the middle of the chart. The default (zoom = 1) view instead sizes
    // itself off the breakeven cluster (falling back to currentSpot alone
    // when there are none, e.g. a naked single-leg curve with no crossing).
    // Zoom widens back out toward — and, at the top of the range, slightly
    // past — the full all-strikes extent so far wings stay reachable.
    const allStrikes = curve
      .filter((_, i) => i === 0 || i === curve.length - 1 ||
        Math.abs(curve[i].pnl - curve[i - 1].pnl) > 0) // strike kinks
      .map((c) => c.spot);

    const coreX = breakevens.length > 0 ? [...breakevens, currentSpot] : [currentSpot];
    const coreMin = Math.min(...coreX);
    const coreMax = Math.max(...coreX);
    const coreSpan = Math.max(coreMax - coreMin, STEP * 2);
    const corePad = Math.max(STEP * 3, coreSpan * 0.35);
    const center = (coreMin + coreMax) / 2;
    const baseHalf = coreSpan / 2 + corePad;

    const fullX = [...coreX, ...allStrikes];
    const fullMin = Math.min(...fullX);
    const fullMax = Math.max(...fullX);
    const fullPad = Math.max(STEP * 4, (fullMax - fullMin) * 0.12);
    const fullHalf = Math.max(fullMax - center, center - fullMin, baseHalf) + fullPad;

    const clampedZoom = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    const half = Math.min(Math.max(baseHalf * clampedZoom, STEP * 2), fullHalf * 1.15);
    const xLo = center - half;
    const xHi = center + half;
    const atMinZoom = half <= STEP * 2 + 1e-6;
    const atMaxZoom = half >= fullHalf * 1.15 - 1e-6;

    const visible = curve.filter((c) => c.spot >= xLo && c.spot <= xHi);
    if (visible.length < 2) return null;

    const visibleToday = todayCurve ? todayCurve.filter((c) => c.spot >= xLo && c.spot <= xHi) : [];

    // --- Smart Y domain: clamp so zero-crossing is prominent ---
    // Folds the T+0 curve's values in too (when present) — its swings near
    // the current spot are usually smaller than the expiry curve's (time
    // value cushions both wings), but it must never silently clip outside
    // the plotted area just because only the expiry curve sized the domain.
    const visiblePnls = [...visible.map((c) => c.pnl), ...visibleToday.map((c) => c.pnl)];
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
    const sy = (y: number) => PAD.top + ((yHi - y) / (yHi - yLo)) * (H_ - PAD.top - PAD.bottom);

    const line = visible.map((p, i) => `${i ? 'L' : 'M'}${sx(p.spot).toFixed(1)},${sy(p.pnl).toFixed(1)}`).join('');
    const area = `${line}L${sx(xHi).toFixed(1)},${sy(0).toFixed(1)}L${sx(xLo).toFixed(1)},${sy(0).toFixed(1)}Z`;
    const todayLine = visibleToday.length >= 2
      ? visibleToday.map((p, i) => `${i ? 'L' : 'M'}${sx(p.spot).toFixed(1)},${sy(p.pnl).toFixed(1)}`).join('')
      : null;

    return {
      xLo, xHi, yLo, yHi, sx, sy, line, area, todayLine,
      zeroY: sy(0),
      xTicks: niceTicks(xLo, xHi, 6),
      yTicks: niceTicks(yLo, yHi, 6),
      visible,
      visibleToday,
      atMinZoom,
      atMaxZoom,
    };
  }, [curve, todayCurve, currentSpot, breakevens, W, H_, zoom]);

  if (!model) return null;

  const { sx, sy, xLo, xHi, zeroY } = model;

  const readoutSpot = hoverSpot ?? currentSpot;
  const readoutPnl = pnlAt(model.visible, readoutSpot);
  const readoutPnlToday = model.visibleToday.length >= 2 ? pnlAt(model.visibleToday, readoutSpot) : null;

  const onMove = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = svgRef.current?.getBoundingClientRect();
    if (!rect) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const frac = (px - PAD.left) / (W - PAD.left - PAD.right);
    if (frac < 0 || frac > 1) { setHoverSpot(null); return; }
    setHoverSpot(xLo + frac * (xHi - xLo));
  };

  const tooltipLeft = sx(readoutSpot) > W * 0.6;

  const chart = (
    <div
      ref={boxRef}
      className={
        full
          ? 'fixed inset-0 z-50 overflow-auto bg-black p-4 md:p-6 flex flex-col'
          : 'w-full flex flex-col'
      }
    >
      {/* Chart Header & Controls */}
      <div className="flex items-center justify-between pb-1.5 px-0.5 border-b border-zinc-800/80 mb-2 shrink-0">
        <div className="flex items-center gap-2.5 flex-wrap">
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
            Strategy Payoff at Expiry
          </span>
          {currentSpot > 0 && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800 text-sky-400">
              Spot: {currentSpot.toLocaleString('en-IN')}
            </span>
          )}
          {breakevens.length > 0 && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400">
              BE: {breakevens.map((b) => b.toFixed(0)).join(', ')}
            </span>
          )}
          {model.todayLine && (
            <span className="flex items-center gap-1.5 text-[11px] font-mono text-zinc-400">
              <span className="inline-block w-3 h-[2px]" style={{ backgroundColor: '#10b981' }} /> At Expiry
              <span className="inline-block w-3 h-[2px] ml-1.5" style={{ backgroundColor: TODAY_COLOR }} /> Today (T+0)
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <div className="flex items-center rounded-lg border border-zinc-750 bg-zinc-900 overflow-hidden">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
              disabled={model.atMinZoom}
              className="flex items-center px-2 py-1 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Zoom in (narrow the price axis)"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              disabled={zoom === 1}
              className="flex items-center px-2 py-1 border-x border-zinc-800 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Reset zoom"
              aria-label="Reset zoom"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
              disabled={model.atMaxZoom}
              className="flex items-center px-2 py-1 text-zinc-300 hover:bg-zinc-800 hover:text-white transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Zoom out (widen the price axis toward the farthest strike)"
              aria-label="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
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
      </div>

      <div className="flex-1 flex items-center justify-center min-h-0">
        <svg
          ref={svgRef}
          viewBox={`0 0 ${W} ${H_}`}
          width={W}
          height={H_}
          className="block max-w-full select-none"
          role="img"
          aria-label="Strategy payoff at expiry"
          onMouseMove={onMove}
          onMouseLeave={() => setHoverSpot(null)}
        >
          <defs>
            <clipPath id="sb-clip-profit"><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
            <clipPath id="sb-clip-loss"><rect x={0} y={zeroY} width={W} height={H_ - zeroY} /></clipPath>
          </defs>

          {/* Y grid + rupee axis */}
          {model.yTicks.map((t) => (
            <g key={`y${t}`}>
              <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)}
                stroke="var(--chart-grid)" strokeWidth={1} strokeDasharray={t === 0 ? undefined : '3 4'} />
              <text x={PAD.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10} fontWeight={600} fill="var(--chart-tick)" className="font-mono">
                {fmtInr(t)}
              </text>
            </g>
          ))}

          {/* X axis */}
          {model.xTicks.map((t) => (
            <text key={`x${t}`} x={sx(t)} y={H_ - PAD.bottom + 17} textAnchor="middle" fontSize={10}
              fontWeight={600} fill="var(--chart-tick)" className="font-mono">
              {t.toFixed(0)}
            </text>
          ))}

          {/* Payoff curve: green above zero, red below */}
          <g clipPath="url(#sb-clip-profit)"><path d={model.area} fill="#10b981" fillOpacity={0.18} /></g>
          <g clipPath="url(#sb-clip-loss)"><path d={model.area} fill="#ef4444" fillOpacity={0.18} /></g>
          <g clipPath="url(#sb-clip-profit)"><path d={model.line} fill="none" stroke="#10b981" strokeWidth={2} /></g>
          <g clipPath="url(#sb-clip-loss)"><path d={model.line} fill="none" stroke="#ef4444" strokeWidth={2} /></g>

          {/* T+0 curve: today's mark-to-market value (Black-76/Black-Scholes at
             current spot, IV and time-to-expiry) — a single smooth blue line,
             not sign-split, since "today" P&L isn't the same all-or-nothing
             intrinsic-value shape the expiry curve is. */}
          {model.todayLine && (
            <path d={model.todayLine} fill="none" stroke={TODAY_COLOR} strokeWidth={2} strokeLinecap="round" />
          )}

          <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke="var(--chart-axis)" strokeWidth={1.25} />

          {/* Breakevens */}
          {breakevens.filter((b) => b >= xLo && b <= xHi).map((be) => {
            const pct = currentSpot > 0 ? ((be - currentSpot) / currentSpot) * 100 : null;
            const pctStr = pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '';
            return (
              <g key={`be${be}`}>
                <circle cx={sx(be)} cy={zeroY} r={4} fill="#f59e0b" stroke="#09090b" strokeWidth={2} />
                <text x={sx(be)} y={zeroY - 9} textAnchor="middle" fontSize={9.5} fontWeight={700} fill="#fbbf24" className="font-mono">
                  BE {be.toFixed(0)}{pctStr}
                </text>
              </g>
            );
          })}

          {/* Current spot marker */}
          {currentSpot >= xLo && currentSpot <= xHi && (
            <g>
              <line x1={sx(currentSpot)} x2={sx(currentSpot)} y1={PAD.top} y2={H_ - PAD.bottom}
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
              <line x1={sx(readoutSpot)} x2={sx(readoutSpot)} y1={PAD.top} y2={H_ - PAD.bottom}
                stroke="#a1a1aa" strokeWidth={1} strokeDasharray="2 3" />
              <circle cx={sx(readoutSpot)} cy={sy(readoutPnl)} r={4.5}
                fill={readoutPnl >= 0 ? '#10b981' : '#ef4444'} stroke="#09090b" strokeWidth={2} />
              {readoutPnlToday !== null && (
                <circle cx={sx(readoutSpot)} cy={sy(readoutPnlToday)} r={4} fill={TODAY_COLOR} stroke="#09090b" strokeWidth={2} />
              )}
              <g transform={`translate(${tooltipLeft ? sx(readoutSpot) - 118 : sx(readoutSpot) + 10}, ${PAD.top + 4})`}>
                <rect width={108} height={readoutPnlToday !== null ? 47 : 34} rx={6} fill="#09090b" fillOpacity={0.9} stroke="#3f3f46" />
                <text x={8} y={13} fontSize={9.5} fill="#a1a1aa" className="font-mono">
                  Spot {readoutSpot.toFixed(0)}
                </text>
                <text x={8} y={26} fontSize={11} fontWeight={700} className="font-mono"
                  fill={readoutPnl >= 0 ? '#10b981' : '#ef4444'}>
                  {readoutPnl >= 0 ? '+' : ''}₹{readoutPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </text>
                {readoutPnlToday !== null && (
                  <text x={8} y={39} fontSize={10} fontWeight={700} className="font-mono" fill={TODAY_COLOR}>
                    T+0 {readoutPnlToday >= 0 ? '+' : ''}₹{readoutPnlToday.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </text>
                )}
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
