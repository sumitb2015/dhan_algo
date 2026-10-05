'use client';

/**
 * THE payoff chart. Every page that draws a strategy payoff renders this component, fed by lib/optionsPayoff.ts
 * (`buildPayoffModel`), so the maths and the look cannot drift between pages.
 *
 * Draws: the nearest-expiry curve (neutral line, green/red fill by sign), today's mark-to-market curve (T+0, blue), the what-if
 * curve (amber dashed, driven by the Time Decay / IV Shift sliders), the ±1 SD band, break-even markers, leg-strike pins and the
 * live spot. Header: spot, break-evens, max profit (+ ROM), max loss, R:R, POP and net Greeks. Controls: What-If, zoom, full screen.
 * Theme-token compliant (dark / white / beige): colours are tokens, never hex.
 */

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer,
  ReferenceLine, ReferenceArea, ReferenceDot,
} from 'recharts';
import { Maximize2, Minimize2, ZoomIn, ZoomOut, RotateCcw, SlidersHorizontal, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PayoffModel } from '@/lib/optionsPayoff';

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
  /** Live mark-to-market curve: each leg priced today at its own IV and time to expiry. */
  todayCurve?: { spot: number; pnl: number }[];

  /** What-if curve at T+targetDays and an IV shift. */
  targetCurve?: { spot: number; pnl: number }[];
  targetDays?: number;
  maxDays?: number;
  onTargetDaysChange?: (days: number) => void;

  /** IV shift in vol points (e.g. -5 = 5 points lower). */
  ivShift?: number;
  onIvShiftChange?: (shift: number) => void;

  maxProfit?: number | null;
  maxProfitUnlimited?: boolean;
  maxLoss?: number | null;
  maxLossUnlimited?: boolean;
  rom?: number | null;
  pop?: number | null;
  riskReward?: string | null;

  netGreeks?: NetGreeks | null;

  /** Leg strikes to pin on the price axis. */
  strikes?: StrikeMarker[];

  /** ±1 SD band, and optionally the ±2 SD lines. */
  expectedMove?: { sd1Lo: number; sd1Hi: number; sd2Lo?: number; sd2Hi?: number } | null;

  /** What-if overlay: the book plus hypothetical draft legs, at expiry (violet dashed). */
  draftCurve?: { spot: number; pnl: number }[] | null;

  /** Open-interest histogram on its own right-hand axis (calls rose, puts green), toggled by the page. */
  oiBars?: { strike: number; callOi: number; putOi: number }[];
  showOi?: boolean;
  onToggleOi?: () => void;

  /** A target price the user is probing (slider): drawn as a marker with the P&L of each curve at that price. */
  targetSpot?: number;

  /** Legend names, e.g. { expiry: '28 Oct', today: '+3d' }. */
  legendLabels?: { expiry?: string; today?: string; target?: string };

  /** When the page owns the price window (it regenerates the curve for a span), zoom is delegated to it. */
  externalZoom?: { onZoomIn: () => void; onZoomOut: () => void; canZoomIn: boolean; canZoomOut: boolean };

  /** A warning strip above the chart (e.g. legs priced without IV). */
  warning?: React.ReactNode;

  /** Heading (default "Strategy payoff"; pass '' when the page already has a panel title), a note under the chart, and extra header controls (e.g. a P&L Table button). */
  title?: string;
  note?: React.ReactNode;
  headerExtras?: React.ReactNode;
  /** Chart height in px when not full screen (default 340). */
  height?: number;
}

/** Everything the chart reads from a payoff model, so a page spreads this instead of repeating a long prop list. */
export function modelToDiagramProps(m: PayoffModel): Pick<
  PayoffDiagramProps,
  'curve' | 'todayCurve' | 'targetCurve' | 'breakevens' | 'maxProfit' | 'maxProfitUnlimited' | 'maxLoss' | 'maxLossUnlimited' |
  'rom' | 'pop' | 'riskReward' | 'netGreeks' | 'strikes' | 'expectedMove'
> {
  return {
    curve: m.points, todayCurve: m.today, targetCurve: m.target ?? undefined, breakevens: m.breakevens,
    maxProfit: m.maxProfit, maxProfitUnlimited: m.maxProfitUnlimited, maxLoss: m.maxLoss, maxLossUnlimited: m.maxLossUnlimited,
    rom: m.rom, pop: m.pop, riskReward: m.riskReward, netGreeks: m.netGreeks, strikes: m.strikes, expectedMove: m.expectedMove,
  };
}

const STEP = 50;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 3;
const ZOOM_STEP = 1.35;

const axisInr = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e7 ? `${(a / 1e7).toFixed(1)}Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${Math.round(a)}`;
  return v < 0 ? `−${s}` : v > 0 ? s : '0';
};

const inr = (v: number, signed = false) => {
  const s = `₹${Math.round(Math.abs(v)).toLocaleString('en-IN')}`;
  return v < 0 ? `−${s}` : signed && v > 0 ? `+${s}` : s;
};

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

function Stat({ label, value, tone, title }: { label: string; value: React.ReactNode; tone?: 'good' | 'bad' | 'warn' | 'info'; title?: string }) {
  return (
    <div className="min-w-0" title={title}>
      <p className="text-xs text-zinc-500 font-medium">{label}</p>
      <p className={cn(
        'text-sm font-bold tabular-nums tracking-tight',
        tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : tone === 'warn' ? 'text-amber-400'
          : tone === 'info' ? 'text-sky-400' : 'text-zinc-100',
      )}>
        {value}
      </p>
    </div>
  );
}

interface Row { spot: number; expiry: number; expPos: number; expNeg: number; today: number | null; target: number | null; draft: number | null }

export default function PayoffDiagram({
  curve, currentSpot, breakevens, todayCurve, targetCurve, targetDays, maxDays, onTargetDaysChange, ivShift, onIvShiftChange,
  maxProfit, maxProfitUnlimited, maxLoss, maxLossUnlimited, rom, pop, riskReward, netGreeks, strikes, expectedMove,
  title = 'Strategy payoff', note, headerExtras, height = 340,
  draftCurve, oiBars, showOi, onToggleOi, targetSpot, legendLabels, externalZoom, warning,
}: PayoffDiagramProps) {
  const [full, setFull] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [showSimulator, setShowSimulator] = useState(false);
  const [winH, setWinH] = useState(800);

  useEffect(() => {
    const on = () => setWinH(window.innerHeight);
    on();
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFull(false); };
    window.addEventListener('keydown', onKey);
    const orig = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { window.removeEventListener('keydown', onKey); document.body.style.overflow = orig; };
  }, [full]);

  const model = useMemo(() => {
    const hasDraftCurve = !!draftCurve && draftCurve.length >= 2;
    // A draft curve is the book plus hypothetical legs, so its strike set (and x-range) is always at least the book's.
    if (curve.length < 2 && !hasDraftCurve) return null;
    const domainCurve = curve.length >= 2 ? curve : draftCurve!;

    // X domain: scaled to the break-evens, strikes and spot, widened by zoom.
    const pinStrikes = strikes ? strikes.map(s => s.strike) : [];
    const coreX = [...(breakevens.length > 0 ? breakevens : []), currentSpot, ...pinStrikes];
    const coreMin = Math.min(...coreX);
    const coreMax = Math.max(...coreX);
    const coreSpan = Math.max(coreMax - coreMin, STEP * 2);
    const corePad = Math.max(STEP * 3, coreSpan * 0.35);
    const center = (coreMin + coreMax) / 2;
    const baseHalf = coreSpan / 2 + corePad;

    const dLo = hasDraftCurve ? Math.min(domainCurve[0].spot, draftCurve![0].spot) : domainCurve[0].spot;
    const dHi = hasDraftCurve ? Math.max(domainCurve[domainCurve.length - 1].spot, draftCurve![draftCurve!.length - 1].spot) : domainCurve[domainCurve.length - 1].spot;
    const fullX = [...coreX, dLo, dHi];
    if (expectedMove) fullX.push(expectedMove.sd1Lo, expectedMove.sd1Hi);
    const fullMin = Math.min(...fullX);
    const fullMax = Math.max(...fullX);
    const fullPad = Math.max(STEP * 4, (fullMax - fullMin) * 0.12);
    const fullHalf = Math.max(fullMax - center, center - fullMin, baseHalf) + fullPad;

    const z = Math.min(Math.max(zoom, MIN_ZOOM), MAX_ZOOM);
    const half = Math.min(Math.max(baseHalf * z, STEP * 2), fullHalf * 1.15);
    // When the page owns the price window it regenerates the curve for each span, so we show the curve's own extent.
    const xLo = externalZoom ? dLo : Math.max(dLo, center - half);
    const xHi = externalZoom ? dHi : Math.min(dHi, center + half);
    if (xHi - xLo < 1e-4) return null;
    const atMinZoom = half <= STEP * 2 + 1e-6;
    const atMaxZoom = half >= fullHalf * 1.15 - 1e-6;

    // One row per sample inside the window, plus exact edge rows so every line touches both borders.
    const xs = [xLo, ...domainCurve.map(c => c.spot).filter(x => x > xLo + 1e-4 && x < xHi - 1e-4), xHi];
    const rows: Row[] = xs.map(x => {
      const e = curve.length >= 2 ? (pnlAt(curve, x) ?? 0) : 0;
      return {
        spot: x, expiry: e, expPos: Math.max(e, 0), expNeg: Math.min(e, 0),
        today: todayCurve ? pnlAt(todayCurve, x) : null,
        target: targetCurve ? pnlAt(targetCurve, x) : null,
        draft: hasDraftCurve ? pnlAt(draftCurve!, x) : null,
      };
    });

    // Y domain: clamp only an explicitly unlimited tail (never a defined-risk book), keep zero in view.
    const pnls = rows.flatMap(r => [r.expiry, ...(r.today !== null ? [r.today] : []), ...(r.target !== null ? [r.target] : []), ...(r.draft !== null ? [r.draft] : [])]);
    const rawMin = Math.min(...pnls);
    const rawMax = Math.max(...pnls);
    let yMin = rawMin;
    if (maxLossUnlimited) yMin = rawMax > 0 ? Math.max(rawMin, -rawMax * 2.2) : rawMin * 1.1;
    let yMax = rawMax;
    if (maxProfitUnlimited) yMax = rawMin < 0 ? Math.min(rawMax, Math.abs(rawMin) * 2.2) : rawMax * 1.1;
    const lo0 = Math.min(0, yMin);
    const hi0 = Math.max(0, yMax);
    const pad = (hi0 - lo0) * 0.08 || 1;
    const yLo = lo0 - pad;
    const yHi = hi0 + pad;

    // OI bars share the price axis but get their own right-hand scale (max bar = ~42% of the plot height), so a 60-lakh OI never
    // dictates the rupee axis the P&L is read against.
    const visibleOi = (oiBars ?? []).filter(b => b.strike >= xLo && b.strike <= xHi);
    const maxOi = visibleOi.length ? Math.max(...visibleOi.flatMap(b => [b.callOi, b.putOi])) : 0;
    const gaps = visibleOi.slice(1).map((b, i) => b.strike - visibleOi[i].strike).filter(g => g > 0);
    const strikeGap = gaps.length ? Math.min(...gaps) : 50;

    return {
      xLo, xHi, yLo, yHi, rows, atMinZoom, atMaxZoom,
      xTicks: niceTicks(xLo, xHi, 7),
      yTicks: niceTicks(yLo, yHi, 6),
      pins: (strikes ?? []).filter(s => s.strike >= xLo && s.strike <= xHi),
      visibleOi, maxOi, oiAxisMax: maxOi > 0 ? maxOi / 0.42 : 1, barHalf: Math.max(strikeGap * 0.17, 1),
    };
  }, [curve, todayCurve, targetCurve, draftCurve, oiBars, currentSpot, breakevens, strikes, expectedMove, zoom, externalZoom, maxLossUnlimited, maxProfitUnlimited]);

  const chartH = full ? Math.max(380, winH - 230) : height;
  const hasToday = !!todayCurve && todayCurve.length >= 2;
  const hasTarget = !!targetCurve && targetCurve.length >= 2;
  const hasDraft = !!draftCurve && draftCurve.length >= 2;
  const hasExpiry = curve.length >= 2;
  const todayName = legendLabels?.today ?? 'Today';
  const expiryName = legendLabels?.expiry ? `At expiry (${legendLabels.expiry})` : 'At expiry';
  const targetName = legendLabels?.target ?? 'What-if';
  const simActive = (targetDays !== undefined && targetDays > 0) || (ivShift !== undefined && ivShift !== 0);

  // recharts' content prop is loosely typed (payload entries are unknown); the row shape is ours.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tooltipContent = useCallback(({ active, payload }: any) => {
    if (!active || !payload?.length) return null;
    const r = payload[0].payload as Row;
    return (
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-xs shadow-lg">
        <p className="font-semibold text-zinc-100 mb-1">Nifty {Math.round(r.spot).toLocaleString('en-IN')}</p>
        {hasExpiry && <p className="tabular-nums text-zinc-300">{expiryName} <span className={cn('font-semibold', r.expiry >= 0 ? 'text-emerald-400' : 'text-red-400')}>{inr(r.expiry, true)}</span></p>}
        {r.today !== null && <p className="tabular-nums text-zinc-300">{todayName} <span className="font-semibold text-sky-400">{inr(r.today, true)}</span></p>}
        {r.target !== null && <p className="tabular-nums text-zinc-300">{targetName} <span className="font-semibold text-amber-400">{inr(r.target, true)}</span></p>}
        {r.draft !== null && <p className="tabular-nums text-zinc-300">With draft <span className="font-semibold text-violet-400">{inr(r.draft, true)}</span></p>}
      </div>
    );
  }, [hasExpiry, expiryName, todayName, targetName]);

  if (!model) return null;

  const body = (
    <div className={cn(full ? 'fixed inset-0 z-50 overflow-auto bg-zinc-950 p-4 md:p-6 flex flex-col' : 'w-full flex flex-col')}>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3 pb-3 border-b border-zinc-800 mb-3">
        <div className="min-w-0">
          {title && <h3 className="text-sm font-bold text-zinc-100 tracking-tight mb-2">{title}</h3>}
          <div className="flex flex-wrap gap-x-6 gap-y-2">
            {currentSpot > 0 && <Stat label="Spot" value={currentSpot.toLocaleString('en-IN', { maximumFractionDigits: 2 })} tone="info" />}
            <Stat
              label="Break-even"
              value={breakevens.length
                ? breakevens.map(b => `${Math.round(b).toLocaleString('en-IN')}${currentSpot > 0 ? ` (${((b - currentSpot) / currentSpot * 100).toFixed(1)}%)` : ''}`).join('  ·  ')
                : 'None in range'}
              tone="warn"
            />
            {maxProfit !== undefined && maxProfit !== null && (
              <Stat
                label={rom ? `Max profit (${rom.toFixed(1)}% on margin)` : 'Max profit'}
                value={maxProfitUnlimited ? 'Unlimited' : inr(maxProfit, true)}
                tone="good"
              />
            )}
            {maxLoss !== undefined && maxLoss !== null && (
              <Stat label="Max loss" value={maxLossUnlimited ? 'Unlimited' : inr(maxLoss)} tone="bad" />
            )}
            {riskReward && <Stat label="Risk : reward" value={riskReward} />}
            {pop !== undefined && pop !== null && <Stat label="Chance of profit" value={`${pop.toFixed(0)}%`} tone="info" title="Probability of finishing above break-even, from the ATM implied volatility" />}
            {targetSpot !== undefined && targetSpot > 0 && (() => {
              const e = hasExpiry ? pnlAt(curve, targetSpot) : null;
              const t = hasToday ? pnlAt(todayCurve!, targetSpot) : null;
              const d = hasDraft ? pnlAt(draftCurve!, targetSpot) : null;
              return (
                <Stat
                  label={`At target ${Math.round(targetSpot).toLocaleString('en-IN')}`}
                  value={[
                    t !== null ? `${todayName} ${inr(t, true)}` : null,
                    e !== null ? `Expiry ${inr(e, true)}` : null,
                    d !== null ? `Draft ${inr(d, true)}` : null,
                  ].filter(Boolean).join('  ·  ') || '—'}
                  tone="info"
                  title="P&L of each curve at the target price"
                />
              );
            })()}
            {netGreeks && (
              <>
                <Stat label="Net delta" value={`${netGreeks.delta >= 0 ? '+' : '−'}${Math.abs(netGreeks.delta).toFixed(1)}`} title="Net delta in index units" />
                <Stat label="Theta per day" value={inr(netGreeks.theta, true)} tone={netGreeks.theta >= 0 ? 'good' : 'bad'} title="Net theta, ₹ per calendar day" />
                <Stat label="Vega per 1% IV" value={inr(netGreeks.vega, true)} title="Net vega, ₹ per 1 vol point" />
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 ml-auto">
          {headerExtras}
          {(onTargetDaysChange || onIvShiftChange) && (
            <button
              type="button"
              onClick={() => setShowSimulator(s => !s)}
              aria-pressed={showSimulator}
              className={cn(
                'flex items-center gap-1 px-2 py-1 rounded-lg border text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-400',
                showSimulator || simActive ? 'border-amber-500/40 bg-amber-500/15 text-amber-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800',
              )}
            >
              <SlidersHorizontal className="h-3.5 w-3.5" />What-if
            </button>
          )}
          {onToggleOi && (
            <button
              type="button"
              onClick={onToggleOi}
              aria-pressed={!!showOi}
              className={cn(
                'px-2.5 py-1 rounded-lg border text-xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400',
                showOi ? 'border-violet-500/50 bg-violet-500/15 text-violet-300' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800',
              )}
            >
              Open interest
            </button>
          )}
          <div className="flex items-center rounded-lg border border-zinc-700 bg-zinc-900 overflow-hidden">
            <button type="button" onClick={() => (externalZoom ? externalZoom.onZoomIn() : setZoom(z => Math.max(MIN_ZOOM, z / ZOOM_STEP)))} disabled={externalZoom ? !externalZoom.canZoomIn : model.atMinZoom}
              aria-label="Zoom in" title="Zoom in (narrow the price axis)"
              className="px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
              <ZoomIn className="h-3.5 w-3.5" />
            </button>
            {!externalZoom && (
              <button type="button" onClick={() => setZoom(1)} disabled={zoom === 1}
                aria-label="Reset zoom" title="Reset zoom"
                className="px-2 py-1 border-x border-zinc-700 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
            )}
            <button type="button" onClick={() => (externalZoom ? externalZoom.onZoomOut() : setZoom(z => Math.min(MAX_ZOOM, z * ZOOM_STEP)))} disabled={externalZoom ? !externalZoom.canZoomOut : model.atMaxZoom}
              aria-label="Zoom out" title="Zoom out (widen the price axis)"
              className="px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
              <ZoomOut className="h-3.5 w-3.5" />
            </button>
          </div>
          <button
            type="button"
            onClick={() => setFull(f => !f)}
            aria-label={full ? 'Exit full screen' : 'Full screen'}
            title={full ? 'Exit full screen (Esc)' : 'Full screen'}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-700 bg-zinc-900 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
          >
            {full ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            <span className="hidden sm:inline">{full ? 'Exit full screen' : 'Full screen'}</span>
          </button>
        </div>
      </div>

      {showSimulator && (onTargetDaysChange || onIvShiftChange) && (
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 py-2 px-3 bg-zinc-900 rounded-lg border border-zinc-800 text-xs mb-3">
          {onTargetDaysChange && (
            <label className="flex items-center gap-2.5 flex-1 min-w-[260px]">
              <span className="font-semibold text-zinc-200 shrink-0">Days ahead</span>
              <span className="text-amber-400 font-mono font-bold shrink-0 min-w-[84px] text-right">
                {targetDays && targetDays > 0 ? `+${targetDays.toFixed(1)}d` : 'Today'}
              </span>
              <input type="range" min={0} max={Math.max(1, maxDays ?? 7)} step={0.5} value={targetDays ?? 0}
                onChange={e => onTargetDaysChange(parseFloat(e.target.value))} className="w-full accent-amber-500" aria-label="Days ahead" />
              <span className="text-zinc-400 font-mono shrink-0">expiry {maxDays ? maxDays.toFixed(1) : 0}d</span>
            </label>
          )}
          {onIvShiftChange && (
            <label className="flex items-center gap-2.5 flex-1 min-w-[240px]">
              <span className="font-semibold text-zinc-200 shrink-0">IV shift</span>
              <span className={cn('font-mono font-bold shrink-0 min-w-[72px] text-right', (ivShift || 0) > 0 ? 'text-purple-400' : (ivShift || 0) < 0 ? 'text-amber-400' : 'text-zinc-400')}>
                {(ivShift || 0) > 0 ? `+${ivShift} pts` : (ivShift || 0) < 0 ? `${ivShift} pts` : 'Current'}
              </span>
              <input type="range" min={-15} max={15} step={1} value={ivShift ?? 0}
                onChange={e => onIvShiftChange(parseFloat(e.target.value))} className="w-full accent-purple-500" aria-label="IV shift in vol points" />
              <span className="text-zinc-400 font-mono shrink-0">±15 pts</span>
            </label>
          )}
          {simActive && (
            <button type="button" onClick={() => { onTargetDaysChange?.(0); onIvShiftChange?.(0); }}
              className="text-sky-400 hover:text-sky-300 underline font-medium shrink-0 ml-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400">
              Reset
            </button>
          )}
        </div>
      )}

      {warning && (
        <div className="mb-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-400">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{warning}</span>
        </div>
      )}

      <div style={{ height: chartH }} className="w-full" role="img" aria-label={`${title || 'Strategy payoff'}: P&L across index levels`}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={model.rows} margin={{ top: 22, right: 18, bottom: 6, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis dataKey="spot" type="number" domain={[model.xLo, model.xHi]} ticks={model.xTicks} allowDataOverflow
              tickFormatter={(v: number) => Math.round(v).toLocaleString('en-IN')} tickMargin={8} />
            <YAxis domain={[model.yLo, model.yHi]} ticks={model.yTicks} allowDataOverflow tickFormatter={axisInr} width={56} />
            {model.maxOi > 0 && (
              <YAxis yAxisId="oi" orientation="right" domain={[0, model.oiAxisMax]} hide allowDataOverflow />
            )}

            {expectedMove && (
              <ReferenceArea x1={Math.max(expectedMove.sd1Lo, model.xLo)} x2={Math.min(expectedMove.sd1Hi, model.xHi)}
                fill="var(--color-sky-400)" fillOpacity={0.07} stroke="none" />
            )}
            <ReferenceLine y={0} stroke="var(--color-zinc-500)" strokeWidth={1.5} />

            {showOi && model.maxOi > 0 && model.visibleOi.map(b => (
              <React.Fragment key={`oi-${b.strike}`}>
                <ReferenceArea yAxisId="oi" x1={b.strike - model.barHalf * 2} x2={b.strike - model.barHalf * 0.15} y1={0} y2={b.callOi}
                  fill="var(--color-red-400)" fillOpacity={0.4} stroke="none" ifOverflow="hidden" />
                <ReferenceArea yAxisId="oi" x1={b.strike + model.barHalf * 0.15} x2={b.strike + model.barHalf * 2} y1={0} y2={b.putOi}
                  fill="var(--color-emerald-400)" fillOpacity={0.4} stroke="none" ifOverflow="hidden" />
              </React.Fragment>
            ))}
            {expectedMove?.sd2Lo !== undefined && expectedMove.sd2Hi !== undefined && [expectedMove.sd2Lo, expectedMove.sd2Hi].filter(v => v > model.xLo && v < model.xHi).map(v => (
              <ReferenceLine key={`sd2-${v}`} x={v} stroke="var(--color-sky-400)" strokeOpacity={0.4} strokeDasharray="2 4"
                label={{ value: '2σ', position: 'insideTop', fontSize: 10, fill: 'var(--color-sky-400)' }} />
            ))}
            {hasExpiry && <Area type="linear" dataKey="expPos" stroke="none" fill="var(--color-emerald-400)" fillOpacity={0.14} isAnimationActive={false} legendType="none" activeDot={false} />}
            {hasExpiry && <Area type="linear" dataKey="expNeg" stroke="none" fill="var(--color-red-400)" fillOpacity={0.14} isAnimationActive={false} legendType="none" activeDot={false} />}
            {hasExpiry && <Line type="linear" dataKey="expiry" name={expiryName} stroke="var(--color-zinc-300)" strokeWidth={2} dot={false} isAnimationActive={false} />}
            {hasToday && <Line type="monotone" dataKey="today" name={todayName} stroke="var(--color-sky-400)" strokeWidth={2.5} dot={false} isAnimationActive={false} connectNulls />}
            {hasTarget && <Line type="monotone" dataKey="target" name={targetName} stroke="var(--color-amber-400)" strokeWidth={2} strokeDasharray="5 4" dot={false} isAnimationActive={false} connectNulls />}
            {hasDraft && <Line type="linear" dataKey="draft" name="With draft" stroke="var(--color-violet-400)" strokeWidth={2} strokeDasharray="5 3" dot={false} isAnimationActive={false} connectNulls />}
            {targetSpot !== undefined && targetSpot > model.xLo && targetSpot < model.xHi && Math.abs(targetSpot - currentSpot) > 1e-6 && (
              <ReferenceLine x={targetSpot} stroke="var(--color-sky-400)" strokeDasharray="4 3"
                label={{ value: `Target ${Math.round(targetSpot).toLocaleString('en-IN')}`, position: 'insideTopLeft', fontSize: 10, fill: 'var(--color-sky-400)' }} />
            )}

            {model.pins.map((s, i) => (
              <ReferenceLine key={`pin-${s.strike}-${s.option ?? ''}-${i}`} x={s.strike}
                stroke={s.side === 'S' ? 'var(--color-red-400)' : s.side === 'B' ? 'var(--color-emerald-400)' : 'var(--color-zinc-500)'}
                strokeOpacity={0.45} strokeDasharray="2 4"
                label={{ value: `${s.strike}${s.option ? ` ${s.option}` : ''}`, position: 'insideBottom', fontSize: 10,
                  fill: s.side === 'S' ? 'var(--color-red-400)' : s.side === 'B' ? 'var(--color-emerald-400)' : 'var(--color-zinc-400)', stroke: 'var(--color-zinc-950)', strokeWidth: 3, paintOrder: 'stroke' }} />
            ))}

            {breakevens.filter(b => b > model.xLo && b < model.xHi).map(b => (
              <ReferenceDot key={`be-${b}`} x={b} y={0} r={5} fill="var(--color-zinc-900)" stroke="var(--color-amber-400)" strokeWidth={2} ifOverflow="visible"
                label={{ value: `BE ${Math.round(b).toLocaleString('en-IN')}`, position: 'top', fontSize: 10, fill: 'var(--color-amber-400)', stroke: 'var(--color-zinc-950)', strokeWidth: 3, paintOrder: 'stroke' }} />
            ))}

            {currentSpot >= model.xLo && currentSpot <= model.xHi && (
              <ReferenceLine x={currentSpot} stroke="var(--color-amber-400)" strokeWidth={1.5}
                label={{ value: `Spot ${Math.round(currentSpot).toLocaleString('en-IN')}`, position: 'top', fontSize: 11, fill: 'var(--color-amber-400)' }} />
            )}

            <RTooltip cursor={{ stroke: 'var(--chart-cursor-line)' }} content={tooltipContent} isAnimationActive={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 pt-2 text-xs text-zinc-400">
        {hasExpiry && <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-zinc-300" />{expiryName}</span>}
        {hasToday && <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-sky-400" />{todayName}</span>}
        {hasTarget && <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-amber-400" />{targetName}</span>}
        {hasDraft && <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-violet-400" />With draft</span>}
        {showOi && model.maxOi > 0 && <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-red-400/40" />Call OI<span className="h-3 w-3 rounded-sm bg-emerald-400/40 ml-1" />Put OI</span>}
        {expectedMove && <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-sky-400/20" />Expected 1σ range</span>}
      </div>
      {note && <div className="pt-1.5 text-xs text-zinc-500">{note}</div>}
    </div>
  );

  // A card ancestor with backdrop-blur (or any filter) is a containing block for `position: fixed`, which would trap the full-screen overlay
  // inside that card. Portaling to <body> escapes it whatever the ancestor applies.
  if (full && typeof document !== 'undefined') return createPortal(body, document.body);
  return body;
}
