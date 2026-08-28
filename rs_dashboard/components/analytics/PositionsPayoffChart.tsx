'use client';

/**
 * Combined payoff diagram for an open positions book.
 *
 * Hand-rolled SVG rather than recharts (which the rest of the dashboard uses for
 * simpler charts) because this needs two overlaid curves, a background OI
 * histogram on its own right-hand axis, breakeven markers and a shared hover
 * crosshair — all of which fight recharts' ComposedChart axis model. The
 * scaffolding (niceTicks, clipped profit/loss fills, hover readout) follows
 * components/BasketPayoffChart.tsx so the two read as one family.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ZoomIn, ZoomOut, Maximize2, Minimize2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface CurvePoint { spot: number; pnl: number }
export interface OiBar { strike: number; callOi: number; putOi: number }

interface Props {
  expiryCurve: CurvePoint[];
  /** Pre-expiry curve at the target date. Omit when no leg has usable IV. */
  targetCurve?: CurvePoint[] | null;
  /**
   * Real book + draft legs combined, at expiry — a "what if I added this"
   * overlay. Its x-range is always >= expiryCurve's (drafts only ever widen
   * the strike set), so it doubles as the domain source whenever present.
   */
  draftCurve?: CurvePoint[] | null;
  breakevens: number[];
  spot: number;
  /** Where the "projected" readout is taken — the target-price slider value. */
  targetSpot: number;
  expiryLabel: string;
  targetLabel: string;
  oiBars?: OiBar[];
  showOi: boolean;
  onToggleOi: () => void;
  onZoomIn: () => void;
  onZoomOut: () => void;
  canZoomIn: boolean;
  canZoomOut: boolean;
  /** Plot height in px. Fixed, not derived from width — see the note on H below. */
  height?: number;
  /** Rendered as a warning strip: legs priced intrinsically for want of IV. */
  ivWarning?: string | null;
  emptyReason?: string;
}

// The SVG is drawn at the container's true pixel size rather than scaled up from a fixed
// viewBox — at `w-full` on a wide monitor a 900x280 viewBox scaled to ~1500px wide, dragging
// the height to ~470px and pushing the chart past the fold. Drawing 1:1 keeps the height put
// no matter how wide the screen is; only the x-axis gets more room.
const H = 280;
const H_FULL = 560;
const W_MIN = 560;
const PAD = { top: 30, right: 64, bottom: 38, left: 74 };

function fmtInrCompact(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 10_000_000) return `${sign}₹${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${sign}₹${(abs / 100_000).toFixed(1)}L`;
  if (abs >= 1_000) return `${sign}₹${(abs / 1_000).toFixed(1)}K`;
  return `${sign}₹${abs.toFixed(0)}`;
}

function fmtOiCompact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(abs / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${(abs / 100_000).toFixed(2)}L`;
  if (abs >= 1_000) return `${(abs / 1_000).toFixed(1)}K`;
  return abs.toFixed(0);
}

/** "Nice" tick values covering [lo, hi] — same helper as BasketPayoffChart. */
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
export function pnlAt(curve: CurvePoint[], spot: number): number | null {
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

export default function PositionsPayoffChart({
  expiryCurve, targetCurve, draftCurve, breakevens, spot, targetSpot,
  expiryLabel, targetLabel, oiBars, showOi, onToggleOi,
  onZoomIn, onZoomOut, canZoomIn, canZoomOut, height, ivWarning, emptyReason,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverSpot, setHoverSpot] = useState<number | null>(null);
  const [full, setFull] = useState(false);
  const [boxW, setBoxW] = useState(900);
  const roRef = useRef<ResizeObserver | null>(null);

  // Callback ref, not useRef + useEffect: the component early-returns a placeholder while the
  // curve is still loading, so an effect keyed on [] would run before this div ever mounts and
  // never attach the observer — leaving the chart pinned at its 900px default width.
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

  const W = Math.max(W_MIN, Math.round(boxW));
  const H_ = full ? H_FULL : (height ?? H);

  const model = useMemo(() => {
    const hasExpiry = expiryCurve.length >= 2;
    const hasDraft = !!draftCurve && draftCurve.length >= 2;
    if (!hasExpiry && !hasDraft) return null;

    // draftCurve is built from the real book PLUS draft legs, so its strike
    // set (and therefore its sampled x-range) is always >= expiryCurve's —
    // use it as the domain source whenever present, falling back to
    // expiryCurve when there's no draft (unchanged behavior for everyone
    // without an active draft).
    const domainCurve = hasDraft ? draftCurve! : expiryCurve;
    const xLo = domainCurve[0].spot;
    const xHi = domainCurve[domainCurve.length - 1].spot;

    const allPnl = [
      ...expiryCurve.map((p) => p.pnl),
      ...(targetCurve ?? []).map((p) => p.pnl),
      ...(draftCurve ?? []).map((p) => p.pnl),
      0,
    ];
    let yLo = Math.min(...allPnl);
    let yHi = Math.max(...allPnl);
    if (yHi === yLo) { yHi += 1; yLo -= 1; }
    const yPad = (yHi - yLo) * 0.08;
    yLo -= yPad; yHi += yPad;

    const sx = (x: number) => PAD.left + ((x - xLo) / (xHi - xLo)) * (W - PAD.left - PAD.right);
    const sy = (y: number) => PAD.top + ((yHi - y) / (yHi - yLo)) * (H_ - PAD.top - PAD.bottom);

    const path = (c: CurvePoint[]) =>
      c.map((p, i) => `${i ? 'L' : 'M'}${sx(p.spot).toFixed(1)},${sy(p.pnl).toFixed(1)}`).join('');

    const line = hasExpiry ? path(expiryCurve) : null;
    const area = hasExpiry
      ? `${line}L${sx(xHi).toFixed(1)},${sy(0).toFixed(1)}L${sx(xLo).toFixed(1)},${sy(0).toFixed(1)}Z`
      : null;

    // OI bars share the x scale but get their own right-hand axis, so a 60-lakh
    // OI never dictates the rupee axis the P&L curve is read against.
    const visibleOi = (oiBars ?? []).filter((b) => b.strike >= xLo && b.strike <= xHi);
    const maxOi = visibleOi.length ? Math.max(...visibleOi.flatMap((b) => [b.callOi, b.putOi])) : 0;
    const oiH = (H_ - PAD.top - PAD.bottom) * 0.42;
    const syOi = (v: number) => (maxOi > 0 ? (v / maxOi) * oiH : 0);

    return {
      xLo, xHi, yLo, yHi, sx, sy, line, area,
      targetLine: targetCurve && targetCurve.length > 1 ? path(targetCurve) : null,
      draftLine: hasDraft ? path(draftCurve!) : null,
      zeroY: sy(0),
      xTicks: niceTicks(xLo, xHi, 6),
      yTicks: niceTicks(yLo, yHi, 6),
      visibleOi, maxOi, syOi,
      oiTicks: maxOi > 0 ? niceTicks(0, maxOi, 3) : [],
      barW: visibleOi.length > 1
        ? Math.max(2, ((W - PAD.left - PAD.right) / visibleOi.length) * 0.34)
        : 4,
    };
  }, [expiryCurve, targetCurve, draftCurve, oiBars, W, H_]);

  if (!model) {
    return (
      <div className="flex h-80 flex-col items-center justify-center gap-1.5 text-zinc-500">
        <p className="text-sm font-semibold text-zinc-400">No payoff to show</p>
        <p className="text-xs text-zinc-500">{emptyReason ?? 'No open option positions for this underlying'}</p>
      </div>
    );
  }

  const { sx, sy, xLo, xHi, zeroY } = model;

  const readoutSpot = hoverSpot ?? targetSpot;
  const expiryPnl = pnlAt(expiryCurve, readoutSpot);
  const targetPnl = targetCurve ? pnlAt(targetCurve, readoutSpot) : null;
  const draftPnl = draftCurve ? pnlAt(draftCurve, readoutSpot) : null;

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
    <div ref={boxRef} className={cn('w-full', full && 'fixed inset-0 z-50 overflow-auto bg-zinc-950 p-6')}>
      {/* Legend + controls */}
      <div className="mb-2 flex flex-wrap items-center gap-3">
        {model.maxOi > 0 && (
          <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">
            OI at {Math.round(spot).toLocaleString('en-IN')}
          </span>
        )}
        <div className="ml-auto flex items-center gap-3">
          {model.line && (
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-300">
              <span className="inline-block h-0.5 w-4 bg-emerald-400" /> On Expiry ({expiryLabel})
            </span>
          )}
          {model.targetLine && (
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-300">
              <span className="inline-block h-0.5 w-4 bg-sky-400" /> On {targetLabel}
            </span>
          )}
          {model.draftLine && (
            <span className="flex items-center gap-1.5 text-[11px] text-zinc-300">
              <span className="inline-block h-0.5 w-4 border-t-2 border-dashed border-violet-400" /> With Draft
            </span>
          )}
          <button
            type="button"
            onClick={onToggleOi}
            className={cn(
              'rounded border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider transition-colors',
              showOi
                ? 'border-violet-500 bg-violet-500/15 text-violet-300 hover:bg-violet-500/25'
                : 'border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-zinc-200',
            )}
          >
            Open Interest
          </button>
          <button type="button" onClick={onZoomOut} disabled={!canZoomOut} title="Zoom out"
            className="rounded border border-zinc-700 bg-zinc-900 p-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-40">
            <ZoomOut className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={onZoomIn} disabled={!canZoomIn} title="Zoom in"
            className="rounded border border-zinc-700 bg-zinc-900 p-1 text-zinc-400 hover:text-zinc-200 disabled:opacity-40">
            <ZoomIn className="h-3.5 w-3.5" />
          </button>
          <button type="button" onClick={() => setFull((f) => !f)} title={full ? 'Exit full screen' : 'Full screen'}
            className="rounded border border-zinc-700 bg-zinc-900 p-1 text-zinc-400 hover:text-zinc-200">
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        </div>
      </div>

      {ivWarning && (
        <div className="mb-2 flex items-start gap-2 rounded border border-amber-800 bg-amber-950 px-2.5 py-1.5 text-[11px] text-amber-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>{ivWarning}</span>
        </div>
      )}

      <svg
        ref={svgRef}
        viewBox={`0 0 ${W} ${H_}`}
        width={W}
        height={H_}
        className="block max-w-full select-none"
        role="img"
        aria-label="Combined payoff for open positions"
        onMouseMove={onMove}
        onMouseLeave={() => setHoverSpot(null)}
      >
        <defs>
          <clipPath id="pa-clip-profit"><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
          <clipPath id="pa-clip-loss"><rect x={0} y={zeroY} width={W} height={H_ - zeroY} /></clipPath>
        </defs>

        {/* Y grid + rupee axis */}
        {model.yTicks.map((t) => (
          <g key={`y${t}`}>
            <line x1={PAD.left} x2={W - PAD.right} y1={sy(t)} y2={sy(t)}
              stroke="#27272a" strokeWidth={1} strokeDasharray={t === 0 ? undefined : '3 4'} />
            <text x={PAD.left - 8} y={sy(t) + 3.5} textAnchor="end" fontSize={10.5} fill="#a1a1aa" className="font-mono">
              {fmtInrCompact(t)}
            </text>
          </g>
        ))}

        {/* OI histogram, behind everything, on its own right axis */}
        {showOi && model.maxOi > 0 && (
          <g opacity={0.55}>
            {model.visibleOi.map((b) => (
              <g key={`oi${b.strike}`}>
                <rect x={sx(b.strike) - model.barW - 0.5} width={model.barW}
                  y={H_ - PAD.bottom - model.syOi(b.callOi)} height={model.syOi(b.callOi)} fill="#f43f5e" />
                <rect x={sx(b.strike) + 0.5} width={model.barW}
                  y={H_ - PAD.bottom - model.syOi(b.putOi)} height={model.syOi(b.putOi)} fill="#10b981" />
              </g>
            ))}
            {model.oiTicks.map((t) => (
              <text key={`oit${t}`} x={W - PAD.right + 8} y={H_ - PAD.bottom - model.syOi(t) + 3.5}
                fontSize={9.5} fill="#71717a" className="font-mono">
                {fmtOiCompact(t)}
              </text>
            ))}
          </g>
        )}

        {/* X axis */}
        {model.xTicks.map((t) => (
          <text key={`x${t}`} x={sx(t)} y={H_ - PAD.bottom + 17} textAnchor="middle" fontSize={10.5}
            fill="#a1a1aa" className="font-mono">
            {t.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
          </text>
        ))}

        {/* Expiry curve: green above zero, red below */}
        {model.line && model.area && (
          <>
            <g clipPath="url(#pa-clip-profit)"><path d={model.area} fill="#10b981" fillOpacity={0.18} /></g>
            <g clipPath="url(#pa-clip-loss)"><path d={model.area} fill="#ef4444" fillOpacity={0.18} /></g>
            <g clipPath="url(#pa-clip-profit)"><path d={model.line} fill="none" stroke="#10b981" strokeWidth={2} /></g>
            <g clipPath="url(#pa-clip-loss)"><path d={model.line} fill="none" stroke="#ef4444" strokeWidth={2} /></g>
          </>
        )}

        {/* Target-date curve */}
        {model.targetLine && (
          <path d={model.targetLine} fill="none" stroke="#38bdf8" strokeWidth={1.75} />
        )}

        {/* Draft overlay: real book + hypothetical draft legs, at expiry */}
        {model.draftLine && (
          <path d={model.draftLine} fill="none" stroke="#a78bfa" strokeWidth={1.75} strokeDasharray="5 3" />
        )}

        <line x1={PAD.left} x2={W - PAD.right} y1={zeroY} y2={zeroY} stroke="#52525b" strokeWidth={1.25} />

        {/* Breakevens */}
        {breakevens.filter((b) => b >= xLo && b <= xHi).map((be) => (
          <g key={`be${be}`}>
            <circle cx={sx(be)} cy={zeroY} r={4} fill="#f59e0b" stroke="#18181b" strokeWidth={2} />
            <text x={sx(be)} y={zeroY - 9} textAnchor="middle" fontSize={9.5} fill="#f59e0b" className="font-mono">
              {be.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </text>
          </g>
        ))}

        {/* Current price */}
        {spot >= xLo && spot <= xHi && (
          <g>
            <line x1={sx(spot)} x2={sx(spot)} y1={PAD.top} y2={H_ - PAD.bottom} stroke="#ef4444" strokeWidth={1.25} />
            <text x={sx(spot)} y={PAD.top - 9} textAnchor="middle" fontSize={10} fill="#ef4444" className="font-mono font-bold">
              {spot.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
            </text>
          </g>
        )}

        {/* Readout crosshair — follows the cursor, parks on the target price otherwise */}
        {readoutSpot >= xLo && readoutSpot <= xHi && (expiryPnl !== null || draftPnl !== null) && (
          <g pointerEvents="none">
            <line x1={sx(readoutSpot)} x2={sx(readoutSpot)} y1={PAD.top} y2={H_ - PAD.bottom}
              stroke="#a1a1aa" strokeWidth={1} strokeDasharray="2 3" />
            {expiryPnl !== null && (
              <circle cx={sx(readoutSpot)} cy={sy(expiryPnl)} r={4.5}
                fill={expiryPnl >= 0 ? '#10b981' : '#ef4444'} stroke="#18181b" strokeWidth={2} />
            )}
            {targetPnl !== null && (
              <circle cx={sx(readoutSpot)} cy={sy(targetPnl)} r={4} fill="#38bdf8" stroke="#18181b" strokeWidth={2} />
            )}
            {draftPnl !== null && (
              <circle cx={sx(readoutSpot)} cy={sy(draftPnl)} r={4} fill="#a78bfa" stroke="#18181b" strokeWidth={2} />
            )}
            <g transform={`translate(${tooltipLeft ? sx(readoutSpot) - 140 : sx(readoutSpot) + 10}, ${PAD.top + 4})`}>
              <rect width={130}
                height={26 + (expiryPnl !== null ? 16 : 0) + (targetPnl !== null ? 16 : 0) + (draftPnl !== null ? 16 : 0)}
                rx={6} fill="#ffffff" fillOpacity={0.12} stroke="#3f3f46" strokeOpacity={0.7} />
              <text x={9} y={15} fontSize={10} fill="#000000" className="font-mono">
                At {readoutSpot.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
              </text>
              {expiryPnl !== null && (
                <text x={9} y={30} fontSize={12} fontWeight={700} className="font-mono"
                  fill={expiryPnl >= 0 ? '#10b981' : '#ef4444'}>
                  Expiry {fmtInrCompact(expiryPnl)}
                </text>
              )}
              {targetPnl !== null && (
                <text x={9} y={30 + (expiryPnl !== null ? 16 : 0)} fontSize={12} fontWeight={700} className="font-mono" fill="#38bdf8">
                  {targetLabel} {fmtInrCompact(targetPnl)}
                </text>
              )}
              {draftPnl !== null && (
                <text x={9} y={30 + (expiryPnl !== null ? 16 : 0) + (targetPnl !== null ? 16 : 0)} fontSize={12} fontWeight={700} className="font-mono" fill="#a78bfa">
                  Draft {fmtInrCompact(draftPnl)}
                </text>
              )}
            </g>
          </g>
        )}
      </svg>
    </div>
  );
}
