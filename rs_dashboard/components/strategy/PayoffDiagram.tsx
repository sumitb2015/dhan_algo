'use client';

/**
 * Payoff-at-expiry chart for the strategy builder & multi-leg terminals.
 *
 * Hand-rolled SVG with clip-path-per-sign technique:
 * - Green fill/line above zeroY, red fill/line below zeroY.
 * - Today (T+0) live mark-to-market Black-Scholes curve (blue #2d7ff9).
 * - Optional What-If time decay target curve (amber dashed #f59e0b).
 * - Leg strike pins on X-axis (peaks & kinks linked to option legs).
 * - Expected move (±1SD) shaded zone based on ATM IV.
 * - Strategy metrics strip: Max Profit (+ ROM %), Max Loss, R:R, POP.
 * - Theme-token compliant: adapts seamlessly to Dark, White, and Beige themes.
 */

import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Maximize2, Minimize2, ZoomIn, ZoomOut, RotateCcw, SlidersHorizontal } from 'lucide-react';

export interface StrikeMarker {
  strike: number;
  option?: 'CE' | 'PE';
  side?: 'B' | 'S';
  lots?: number;
}

export interface NetGreeks {
  delta: number;
  theta: number;
  vega: number;
  gamma?: number;
}

export interface PayoffDiagramProps {
  curve: { spot: number; pnl: number }[];
  currentSpot: number;
  breakevens: number[];
  /** Live mark-to-market curve — each leg priced today (Black-76/Black-Scholes
   *  at current spot, IV and time-to-expiry) rather than at intrinsic value. */
  todayCurve?: { spot: number; pnl: number }[];

  /** Projected time-decay simulation curve at T+targetDays */
  targetCurve?: { spot: number; pnl: number }[];
  targetDays?: number;
  maxDays?: number;
  onTargetDaysChange?: (days: number) => void;

  /** IV Shift simulation (% change, e.g. -5 for -5% IV) */
  ivShift?: number;
  onIvShiftChange?: (shift: number) => void;

  /** Key strategy metrics overlay (OpenAlgo institutional style) */
  maxProfit?: number | null;
  maxProfitUnlimited?: boolean;
  maxLoss?: number | null;
  maxLossUnlimited?: boolean;
  rom?: number | null; // Return on margin %
  pop?: number | null; // Probability of Profit %
  riskReward?: string | null;

  /** Net strategy Greeks overlay */
  netGreeks?: NetGreeks | null;

  /** Active leg strikes to pin on the X-axis */
  strikes?: StrikeMarker[];

  /** Expected move (±1SD band) */
  expectedMove?: {
    sd1Lo: number;
    sd1Hi: number;
  } | null;
}

const TODAY_COLOR = '#2d7ff9'; // matches Options Monitor's PAYOFF_TODAY
const TARGET_COLOR = '#f59e0b'; // amber dashed line for What-If time decay simulation

const STEP = 50;
const H = 320;
const PAD = { top: 24, right: 24, bottom: 38, left: 68 };

// Zoom multipliers for X domain. 1 = default view scaled to breakevens/spot
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
export function pnlAt(curve: { spot: number; pnl: number }[], spot: number): number | null {
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

export default function PayoffDiagram({
  curve,
  currentSpot,
  breakevens,
  todayCurve,
  targetCurve,
  targetDays,
  maxDays,
  onTargetDaysChange,
  ivShift,
  onIvShiftChange,
  maxProfit,
  maxProfitUnlimited,
  maxLoss,
  maxLossUnlimited,
  rom,
  pop,
  riskReward,
  netGreeks,
  strikes,
  expectedMove,
}: PayoffDiagramProps) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const profitClipId = `sb-clip-profit-${uid}`;
  const lossClipId = `sb-clip-loss-${uid}`;

  const svgRef = useRef<SVGSVGElement | null>(null);
  const [hoverSpot, setHoverSpot] = useState<number | null>(null);
  const [boxW, setBoxW] = useState(900);
  const [full, setFull] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [showSimulator, setShowSimulator] = useState(false);
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

    // --- Smart X domain: scaled to the breakevens & strikes ---
    const allStrikes = [
      ...curve
        .filter((_, i) => i === 0 || i === curve.length - 1 ||
          Math.abs(curve[i].pnl - curve[i - 1].pnl) > 0) // strike kinks
        .map((c) => c.spot),
      ...(strikes ? strikes.map((s) => s.strike) : []),
    ];

    const coreX = breakevens.length > 0 ? [...breakevens, currentSpot] : [currentSpot];
    if (expectedMove) {
      coreX.push(expectedMove.sd1Lo, expectedMove.sd1Hi);
    }
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
    const curveMin = curve[0].spot;
    const curveMax = curve[curve.length - 1].spot;
    const xLo = Math.max(curveMin, center - half);
    const xHi = Math.min(curveMax, center + half);
    if (xHi - xLo < 1e-4) return null;
    const atMinZoom = half <= STEP * 2 + 1e-6;
    const atMaxZoom = half >= fullHalf * 1.15 - 1e-6;

    // Exact edge interpolation so curves cleanly touch the left (xLo) and right (xHi) boundaries
    const pnlAtLo = pnlAt(curve, xLo);
    const pnlAtHi = pnlAt(curve, xHi);
    const visiblePoints = curve.filter((c) => c.spot > xLo + 1e-4 && c.spot < xHi - 1e-4);
    const visible = [
      ...(pnlAtLo !== null ? [{ spot: xLo, pnl: pnlAtLo }] : []),
      ...visiblePoints,
      ...(pnlAtHi !== null ? [{ spot: xHi, pnl: pnlAtHi }] : []),
    ];
    if (visible.length < 2) return null;

    const visibleToday = todayCurve ? (() => {
      const todayLo = pnlAt(todayCurve, xLo);
      const todayHi = pnlAt(todayCurve, xHi);
      const todayMid = todayCurve.filter((c) => c.spot > xLo + 1e-4 && c.spot < xHi - 1e-4);
      return [
        ...(todayLo !== null ? [{ spot: xLo, pnl: todayLo }] : []),
        ...todayMid,
        ...(todayHi !== null ? [{ spot: xHi, pnl: todayHi }] : []),
      ];
    })() : [];

    const visibleTarget = targetCurve ? (() => {
      const targetLo = pnlAt(targetCurve, xLo);
      const targetHi = pnlAt(targetCurve, xHi);
      const targetMid = targetCurve.filter((c) => c.spot > xLo + 1e-4 && c.spot < xHi - 1e-4);
      return [
        ...(targetLo !== null ? [{ spot: xLo, pnl: targetLo }] : []),
        ...targetMid,
        ...(targetHi !== null ? [{ spot: xHi, pnl: targetHi }] : []),
      ];
    })() : [];

    // --- Smart Y domain: clamp so zero-crossing is prominent ---
    // Undefined-risk tails clamped to 1.8x max profit to give the profit zone ~45% vertical height
    const visiblePnls = [
      ...visible.map((c) => c.pnl),
      ...visibleToday.map((c) => c.pnl),
      ...visibleTarget.map((c) => c.pnl),
    ];
    const rawYMin = Math.min(...visiblePnls);
    const rawYMax = Math.max(...visiblePnls);
    const clampedYMin = rawYMax > 0 ? Math.max(rawYMin, -rawYMax * 1.8) : rawYMin * 1.1;
    const clampedYMax = rawYMin < 0 ? Math.min(rawYMax, Math.abs(rawYMin) * 1.8) : rawYMax * 1.1;
    const yMinWithZero = Math.min(0, clampedYMin);
    const yMaxWithZero = Math.max(0, clampedYMax);
    const yPad = (yMaxWithZero - yMinWithZero) * 0.08 || 1;
    const yLo = yMinWithZero - yPad;
    const yHi = yMaxWithZero + yPad;

    const sx = (x: number) => PAD.left + ((x - xLo) / (xHi - xLo)) * (W - PAD.left - PAD.right);
    const sy = (y: number) => PAD.top + ((yHi - y) / (yHi - yLo)) * (H_ - PAD.top - PAD.bottom);

    const line = visible.map((p, i) => `${i ? 'L' : 'M'}${sx(p.spot).toFixed(1)},${sy(p.pnl).toFixed(1)}`).join('');
    const area = `${line}L${sx(xHi).toFixed(1)},${sy(0).toFixed(1)}L${sx(xLo).toFixed(1)},${sy(0).toFixed(1)}Z`;
    const todayLine = visibleToday.length >= 2
      ? visibleToday.map((p, i) => `${i ? 'L' : 'M'}${sx(p.spot).toFixed(1)},${sy(p.pnl).toFixed(1)}`).join('')
      : null;
    const targetLine = visibleTarget.length >= 2
      ? visibleTarget.map((p, i) => `${i ? 'L' : 'M'}${sx(p.spot).toFixed(1)},${sy(p.pnl).toFixed(1)}`).join('')
      : null;

    const visibleStrikes = strikes
      ? strikes.filter((s) => s.strike >= xLo && s.strike <= xHi)
      : [];

    return {
      xLo, xHi, yLo, yHi, sx, sy, line, area, todayLine, targetLine,
      zeroY: sy(0),
      xTicks: niceTicks(xLo, xHi, 6),
      yTicks: niceTicks(yLo, yHi, 7),
      visible,
      visibleToday,
      visibleTarget,
      visibleStrikes,
      atMinZoom,
      atMaxZoom,
    };
  }, [curve, todayCurve, targetCurve, currentSpot, breakevens, strikes, expectedMove, W, H_, zoom]);

  if (!model) return null;

  const { sx, sy, xLo, xHi, zeroY } = model;

  const readoutSpot = hoverSpot ?? currentSpot;
  const readoutPnl = pnlAt(model.visible, readoutSpot);
  const readoutPnlToday = model.visibleToday.length >= 2 ? pnlAt(model.visibleToday, readoutSpot) : null;
  const readoutPnlTarget = model.visibleTarget.length >= 2 ? pnlAt(model.visibleTarget, readoutSpot) : null;

  let tooltipRows = 2;
  if (readoutPnlToday !== null) tooltipRows++;
  if (readoutPnlTarget !== null) tooltipRows++;
  const tooltipHeight = 16 + tooltipRows * 14;

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
          ? 'fixed inset-0 z-50 overflow-auto bg-zinc-950 p-4 md:p-6 flex flex-col'
          : 'w-full flex flex-col'
      }
    >
      {/* Chart Header & Controls */}
      <div className="flex items-center justify-between pb-2 px-0.5 border-b border-zinc-800/80 mb-2 shrink-0 flex-wrap gap-2">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold uppercase tracking-wider text-zinc-300">
            Strategy Payoff at Expiry
          </span>
          {currentSpot > 0 && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-850 border border-zinc-700 text-sky-400 font-semibold">
              Spot: {currentSpot.toLocaleString('en-IN')}
            </span>
          )}
          {breakevens.length > 0 && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/20 text-amber-400 font-semibold">
              BE: {breakevens.map((b) => b.toFixed(0)).join(', ')}
            </span>
          )}
          {maxProfit !== undefined && maxProfit !== null && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 font-semibold">
              Max Profit: {maxProfitUnlimited ? 'Unlimited' : `+₹${Math.round(maxProfit).toLocaleString('en-IN')}`}
              {rom ? ` (${rom.toFixed(1)}% ROM)` : ''}
            </span>
          )}
          {maxLoss !== undefined && maxLoss !== null && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/20 text-rose-400 font-semibold">
              Max Loss: {maxLossUnlimited ? 'Unlimited' : `${maxLoss < 0 ? '-' : ''}₹${Math.round(Math.abs(maxLoss)).toLocaleString('en-IN')}`}
            </span>
          )}
          {riskReward && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-zinc-850 border border-zinc-700 text-zinc-300">
              R:R {riskReward}
            </span>
          )}
          {pop !== undefined && pop !== null && (
            <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 font-semibold">
              POP {pop.toFixed(0)}%
            </span>
          )}
          {netGreeks && (
            <>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/20 text-sky-400 font-semibold" title="Net Strategy Delta">
                Δ {netGreeks.delta >= 0 ? '+' : ''}{netGreeks.delta.toFixed(2)}
              </span>
              <span className={`text-[11px] font-mono px-2 py-0.5 rounded border font-semibold ${
                netGreeks.theta >= 0
                  ? 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400'
                  : 'bg-rose-500/10 border-rose-500/20 text-rose-400'
              }`} title="Net Strategy Theta (₹ decay / day)">
                θ {netGreeks.theta >= 0 ? '+' : ''}₹{Math.round(netGreeks.theta).toLocaleString('en-IN')}/d
              </span>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-purple-500/10 border border-purple-500/20 text-purple-300 font-semibold" title="Net Strategy Vega (₹ / 1% IV shift)">
                ν {netGreeks.vega >= 0 ? '+' : ''}₹{Math.round(netGreeks.vega).toLocaleString('en-IN')}/%
              </span>
            </>
          )}
        </div>

        <div className="flex items-center gap-1.5 ml-auto">
          {/* Legend */}
          <div className="hidden sm:flex items-center gap-2.5 text-[11px] font-mono text-zinc-400 mr-2">
            <span className="flex items-center gap-1">
              <span className="inline-block w-2.5 h-[2px]" style={{ backgroundColor: '#10b981' }} /> Expiry
            </span>
            {model.todayLine && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-[2px]" style={{ backgroundColor: TODAY_COLOR }} /> Today
              </span>
            )}
            {model.targetLine && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-2.5 h-[2px]" style={{ backgroundColor: TARGET_COLOR }} /> Sim
              </span>
            )}
            {expectedMove && (
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-xs bg-sky-500/20 border border-sky-500/40" /> 1-SD
              </span>
            )}
          </div>

          {/* What-If Simulation Toggle */}
          {(onTargetDaysChange || onIvShiftChange) && (
            <button
              type="button"
              onClick={() => setShowSimulator((s) => !s)}
              className={`flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-semibold cursor-pointer transition-colors ${
                showSimulator || (targetDays !== undefined && targetDays > 0) || (ivShift !== undefined && ivShift !== 0)
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                  : 'border-zinc-700 bg-zinc-850 text-zinc-300 hover:bg-zinc-750 hover:text-white'
              }`}
              title="Toggle What-If Time Decay and IV Shift Simulator"
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />
              <span>What-If</span>
            </button>
          )}

          {/* Zoom Buttons */}
          <div className="flex items-center rounded-lg border border-zinc-700 bg-zinc-850 overflow-hidden">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP))}
              disabled={model.atMinZoom}
              className="flex items-center px-2 py-1 text-zinc-300 hover:bg-zinc-750 hover:text-white transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Zoom in (narrow the price axis)"
              aria-label="Zoom in"
            >
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom(1)}
              disabled={zoom === 1}
              className="flex items-center px-2 py-1 border-x border-zinc-700 text-zinc-300 hover:bg-zinc-750 hover:text-white transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Reset zoom"
              aria-label="Reset zoom"
            >
              <RotateCcw className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP))}
              disabled={model.atMaxZoom}
              className="flex items-center px-2 py-1 text-zinc-300 hover:bg-zinc-750 hover:text-white transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:bg-transparent"
              title="Zoom out (widen the price axis toward the farthest strike)"
              aria-label="Zoom out"
            >
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
          </div>

          {/* Full Screen Button */}
          <button
            type="button"
            onClick={() => setFull((f) => !f)}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-850 text-xs font-semibold text-zinc-300 hover:bg-zinc-750 hover:text-white transition-colors cursor-pointer"
            title={full ? 'Exit full screen (Esc)' : 'Full screen'}
            aria-label={full ? 'Exit full screen' : 'Full screen'}
          >
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{full ? 'Exit Full Screen' : 'Full Screen'}</span>
          </button>
        </div>
      </div>

      {/* What-If Time Decay & IV Shift Simulation Bar */}
      {showSimulator && (onTargetDaysChange || onIvShiftChange) && (
        <div className="flex flex-col gap-2 py-2 px-3 bg-zinc-900/90 rounded-lg border border-zinc-800 text-xs mb-2.5">
          <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
            {onTargetDaysChange && (
              <div className="flex items-center gap-2.5 flex-1 min-w-[280px]">
                <div className="flex items-center gap-1.5 shrink-0">
                  <SlidersHorizontal className="w-3.5 h-3.5 text-amber-400" />
                  <span className="font-bold text-zinc-200">Time Decay (θ):</span>
                </div>
                <span className="text-amber-400 font-mono font-bold shrink-0 min-w-[85px] text-right">
                  {targetDays && targetDays > 0 ? `+${targetDays.toFixed(1)}d fwd` : 'Today (T+0)'}
                </span>
                <input
                  type="range"
                  min={0}
                  max={Math.max(1, maxDays ?? 7)}
                  step={0.5}
                  value={targetDays ?? 0}
                  onChange={(e) => onTargetDaysChange(parseFloat(e.target.value))}
                  className="w-full accent-amber-500 bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                />
                <span className="text-[10px] text-zinc-400 font-mono shrink-0">
                  Exp ({maxDays ? maxDays.toFixed(1) : 0}d)
                </span>
              </div>
            )}

            {onIvShiftChange && (
              <div className="flex items-center gap-2.5 flex-1 min-w-[260px] pl-0 sm:pl-3 border-t sm:border-t-0 sm:border-l border-zinc-800 pt-1.5 sm:pt-0">
                <div className="flex items-center gap-1.5 shrink-0">
                  <span className="font-bold text-zinc-200">IV Shift (ν):</span>
                </div>
                <span className={`font-mono font-bold shrink-0 min-w-[75px] text-right ${
                  (ivShift || 0) > 0 ? 'text-purple-400' : (ivShift || 0) < 0 ? 'text-amber-400' : 'text-zinc-400'
                }`}>
                  {(ivShift || 0) > 0 ? `+${ivShift}%` : (ivShift || 0) < 0 ? `${ivShift}%` : 'Base IV'}
                </span>
                <input
                  type="range"
                  min={-15}
                  max={15}
                  step={1}
                  value={ivShift ?? 0}
                  onChange={(e) => onIvShiftChange(parseFloat(e.target.value))}
                  className="w-full accent-purple-500 bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                />
                <span className="text-[10px] text-zinc-400 font-mono shrink-0">
                  ±15%
                </span>
              </div>
            )}

            {((targetDays !== undefined && targetDays > 0) || (ivShift !== undefined && ivShift !== 0)) && (
              <button
                type="button"
                onClick={() => {
                  onTargetDaysChange?.(0);
                  onIvShiftChange?.(0);
                }}
                className="text-[11px] text-sky-400 hover:text-sky-300 underline font-medium cursor-pointer shrink-0 ml-auto"
              >
                Reset All
              </button>
            )}
          </div>
        </div>
      )}

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
            <clipPath id={profitClipId}><rect x={0} y={0} width={W} height={zeroY} /></clipPath>
            <clipPath id={lossClipId}><rect x={0} y={zeroY} width={W} height={H_ - zeroY} /></clipPath>
          </defs>

          {/* Expected Move (±1SD) Shaded Background Area */}
          {expectedMove && (
            <g pointerEvents="none">
              <rect
                x={Math.max(PAD.left, sx(expectedMove.sd1Lo))}
                y={PAD.top}
                width={Math.max(0, Math.min(W - PAD.right, sx(expectedMove.sd1Hi)) - Math.max(PAD.left, sx(expectedMove.sd1Lo)))}
                height={H_ - PAD.top - PAD.bottom}
                fill="#0ea5e9"
                fillOpacity={0.045}
              />
              {expectedMove.sd1Lo >= xLo && expectedMove.sd1Lo <= xHi && (
                <line
                  x1={sx(expectedMove.sd1Lo)}
                  x2={sx(expectedMove.sd1Lo)}
                  y1={PAD.top}
                  y2={H_ - PAD.bottom}
                  stroke="#0ea5e9"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  strokeOpacity={0.4}
                />
              )}
              {expectedMove.sd1Hi >= xLo && expectedMove.sd1Hi <= xHi && (
                <line
                  x1={sx(expectedMove.sd1Hi)}
                  x2={sx(expectedMove.sd1Hi)}
                  y1={PAD.top}
                  y2={H_ - PAD.bottom}
                  stroke="#0ea5e9"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  strokeOpacity={0.4}
                />
              )}
              {expectedMove.sd1Lo >= xLo && expectedMove.sd1Lo <= xHi && (
                <text
                  x={sx(expectedMove.sd1Lo)}
                  y={H_ - PAD.bottom - 4}
                  textAnchor="middle"
                  fontSize={8.5}
                  fontWeight={600}
                  fill="#38bdf8"
                  fillOpacity={0.7}
                  className="font-mono"
                >
                  -1SD
                </text>
              )}
              {expectedMove.sd1Hi >= xLo && expectedMove.sd1Hi <= xHi && (
                <text
                  x={sx(expectedMove.sd1Hi)}
                  y={H_ - PAD.bottom - 4}
                  textAnchor="middle"
                  fontSize={8.5}
                  fontWeight={600}
                  fill="#38bdf8"
                  fillOpacity={0.7}
                  className="font-mono"
                >
                  +1SD
                </text>
              )}
            </g>
          )}

          {/* Y grid + rupee axis */}
          {model.yTicks.map((t) => (
            <g key={`y${t}`}>
              <line
                x1={PAD.left}
                x2={W - PAD.right}
                y1={sy(t)}
                y2={sy(t)}
                stroke="var(--chart-grid)"
                strokeWidth={1}
                strokeDasharray={t === 0 ? undefined : '3 4'}
              />
              <text
                x={PAD.left - 8}
                y={sy(t) + 3.5}
                textAnchor="end"
                fontSize={10}
                fontWeight={600}
                fill="var(--chart-tick)"
                className="font-mono"
              >
                {fmtInr(t)}
              </text>
            </g>
          ))}

          {/* X axis ticks */}
          {model.xTicks.map((t) => (
            <text
              key={`x${t}`}
              x={sx(t)}
              y={H_ - PAD.bottom + 17}
              textAnchor="middle"
              fontSize={10}
              fontWeight={600}
              fill="var(--chart-tick)"
              className="font-mono"
            >
              {t.toFixed(0)}
            </text>
          ))}

          {/* Payoff curve: green above zero, red below */}
          <g clipPath={`url(#${profitClipId})`}><path d={model.area} fill="#10b981" fillOpacity={0.18} /></g>
          <g clipPath={`url(#${lossClipId})`}><path d={model.area} fill="#ef4444" fillOpacity={0.18} /></g>
          <g clipPath={`url(#${profitClipId})`}><path d={model.line} fill="none" stroke="#10b981" strokeWidth={2} /></g>
          <g clipPath={`url(#${lossClipId})`}><path d={model.line} fill="none" stroke="#ef4444" strokeWidth={2} /></g>

          {/* T+0 curve: today's mark-to-market Black-Scholes curve */}
          {model.todayLine && (
            <path d={model.todayLine} fill="none" stroke={TODAY_COLOR} strokeWidth={2} strokeLinecap="round" />
          )}

          {/* Projected Target Curve at T+N days */}
          {model.targetLine && (
            <path d={model.targetLine} fill="none" stroke={TARGET_COLOR} strokeWidth={2} strokeDasharray="4 3" strokeLinecap="round" />
          )}

          {/* Zero Axis Line */}
          <line
            x1={PAD.left}
            x2={W - PAD.right}
            y1={zeroY}
            y2={zeroY}
            stroke="var(--chart-axis)"
            strokeWidth={1.5}
          />

          {/* Active Leg Strike Pins & Badges on X-Axis */}
          {model.visibleStrikes.map((s, idx) => {
            const legPnl = pnlAt(model.visible, s.strike);
            const isBuy = s.side === 'B';
            const color = isBuy ? '#38bdf8' : '#fb7185';
            const borderCol = isBuy ? '#0284c7' : '#e11d48';
            const label = `${s.strike} ${s.option ?? ''}`;
            const badgeW = label.length * 5.8 + 8;
            return (
              <g key={`strike-${s.strike}-${s.option ?? ''}-${idx}`}>
                <line
                  x1={sx(s.strike)}
                  x2={sx(s.strike)}
                  y1={PAD.top}
                  y2={H_ - PAD.bottom}
                  stroke="var(--chart-grid)"
                  strokeWidth={0.8}
                  strokeDasharray="2 3"
                  strokeOpacity={0.6}
                />
                {legPnl !== null && (
                  <circle
                    cx={sx(s.strike)}
                    cy={sy(legPnl)}
                    r={3}
                    fill={color}
                    stroke="var(--color-zinc-950)"
                    strokeWidth={1.5}
                  />
                )}
                <rect
                  x={sx(s.strike) - badgeW / 2}
                  y={H_ - PAD.bottom - 16}
                  width={badgeW}
                  height={14}
                  rx={3}
                  fill="var(--color-zinc-900)"
                  stroke={borderCol}
                  strokeWidth={0.9}
                />
                <text
                  x={sx(s.strike)}
                  y={H_ - PAD.bottom - 5.5}
                  textAnchor="middle"
                  fontSize={8.5}
                  fontWeight={700}
                  fill={color}
                  className="font-mono"
                >
                  {label}
                </text>
              </g>
            );
          })}

          {/* Breakevens (shielded in anti-collision badge pill) */}
          {breakevens.filter((b) => b >= xLo && b <= xHi).map((be) => {
            const pct = currentSpot > 0 ? ((be - currentSpot) / currentSpot) * 100 : null;
            const pctStr = pct !== null ? ` (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)` : '';
            const labelText = `BE ${be.toFixed(0)}${pctStr}`;
            const badgeW = labelText.length * 6.2 + 10;
            return (
              <g key={`be${be}`}>
                <circle cx={sx(be)} cy={zeroY} r={4.5} fill="#f59e0b" stroke="var(--color-zinc-950)" strokeWidth={2} />
                <rect
                  x={sx(be) - badgeW / 2}
                  y={zeroY - 24}
                  width={badgeW}
                  height={17}
                  rx={4}
                  fill="var(--color-zinc-900)"
                  fillOpacity={0.92}
                  stroke="#f59e0b"
                  strokeWidth={1}
                  strokeOpacity={0.5}
                />
                <text
                  x={sx(be)}
                  y={zeroY - 12}
                  textAnchor="middle"
                  fontSize={9.5}
                  fontWeight={700}
                  fill="#fbbf24"
                  className="font-mono"
                >
                  {labelText}
                </text>
              </g>
            );
          })}

          {/* Current spot marker with protected pill badge */}
          {currentSpot >= xLo && currentSpot <= xHi && (
            <g>
              <line
                x1={sx(currentSpot)}
                x2={sx(currentSpot)}
                y1={PAD.top}
                y2={H_ - PAD.bottom}
                stroke="#0ea5e9"
                strokeWidth={1.25}
                strokeDasharray="4 3"
                strokeOpacity={0.8}
              />
              <rect
                x={sx(currentSpot) - 24}
                y={PAD.top - 18}
                width={48}
                height={16}
                rx={3.5}
                fill="var(--color-zinc-900)"
                stroke="#0ea5e9"
                strokeWidth={1}
              />
              <text
                x={sx(currentSpot)}
                y={PAD.top - 6}
                textAnchor="middle"
                fontSize={9.5}
                fontWeight={700}
                fill="#38bdf8"
                className="font-mono"
              >
                {currentSpot.toFixed(0)}
              </text>
            </g>
          )}

          {/* Readout crosshair — follows cursor, parks on current spot otherwise */}
          {readoutSpot >= xLo && readoutSpot <= xHi && readoutPnl !== null && (
            <g pointerEvents="none">
              <line
                x1={sx(readoutSpot)}
                x2={sx(readoutSpot)}
                y1={PAD.top}
                y2={H_ - PAD.bottom}
                stroke="var(--chart-tick)"
                strokeWidth={1}
                strokeDasharray="2 3"
                strokeOpacity={0.6}
              />
              <circle
                cx={sx(readoutSpot)}
                cy={sy(readoutPnl)}
                r={4.5}
                fill={readoutPnl >= 0 ? '#10b981' : '#ef4444'}
                stroke="var(--color-zinc-950)"
                strokeWidth={2}
              />
              {readoutPnlToday !== null && (
                <circle
                  cx={sx(readoutSpot)}
                  cy={sy(readoutPnlToday)}
                  r={4}
                  fill={TODAY_COLOR}
                  stroke="var(--color-zinc-950)"
                  strokeWidth={2}
                />
              )}
              {readoutPnlTarget !== null && (
                <circle
                  cx={sx(readoutSpot)}
                  cy={sy(readoutPnlTarget)}
                  r={4}
                  fill={TARGET_COLOR}
                  stroke="var(--color-zinc-950)"
                  strokeWidth={2}
                />
              )}
              <g transform={`translate(${tooltipLeft ? sx(readoutSpot) - 130 : sx(readoutSpot) + 12}, ${PAD.top + 4})`}>
                <rect
                  width={122}
                  height={tooltipHeight}
                  rx={6}
                  fill="var(--color-zinc-900)"
                  fillOpacity={0.95}
                  stroke="var(--chart-axis)"
                  strokeWidth={1}
                />
                <text x={8} y={14} fontSize={9.5} fill="var(--chart-tick)" className="font-mono">
                  Spot {readoutSpot.toFixed(0)}
                </text>
                <text
                  x={8}
                  y={28}
                  fontSize={10.5}
                  fontWeight={700}
                  className="font-mono"
                  fill={readoutPnl >= 0 ? '#10b981' : '#ef4444'}
                >
                  Expiry {readoutPnl >= 0 ? '+' : ''}₹{readoutPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                </text>
                {readoutPnlToday !== null && (
                  <text x={8} y={42} fontSize={10} fontWeight={700} className="font-mono" fill={TODAY_COLOR}>
                    T+0 {readoutPnlToday >= 0 ? '+' : ''}₹{readoutPnlToday.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </text>
                )}
                {readoutPnlTarget !== null && (
                  <text
                    x={8}
                    y={readoutPnlToday !== null ? 56 : 42}
                    fontSize={10}
                    fontWeight={700}
                    className="font-mono"
                    fill={TARGET_COLOR}
                  >
                    Sim {readoutPnlTarget >= 0 ? '+' : ''}₹{readoutPnlTarget.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
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
