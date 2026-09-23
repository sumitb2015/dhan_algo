'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ReferenceArea,
  ReferenceDot,
} from 'recharts';
import { Maximize2, Minimize2, TrendingUp } from 'lucide-react';
import TerminalPanel from '@/components/options-monitor/TerminalPanel';
import {
  OptionLegModel,
  PayoffPoint,
  generatePayoffCurve,
  computeExpiryPnlAtSpot,
  formatShortExpiry,
  calculateTimeToExpiryYears,
} from '@/lib/optionsMonitorMath';

export interface BasketPayoffChartProps {
  legs?: OptionLegModel[];
  spot: number;
  strikeStep?: number;
  lotSize?: number;
  currentExpiry?: string;
  futurePrice?: number | null;
  futureBasis?: number | null;
  futureExpiry?: string | null;
  baseIv?: number;
  underlying?: string;
  emptyReason?: string;
  // Legacy props for backward compatibility
  points?: { x: number; y: number }[];
  breakevens?: number[];
  rightWing?: 'profit' | 'loss' | null;
  leftWing?: 'loss' | null;
}

const PAYOFF_PROFIT = '#16a34a';
const PAYOFF_LOSS = '#e5484d';
const PAYOFF_TODAY = '#2d7ff9';
const PAYOFF_EXPIRY = '#e0533d';
const PAYOFF_SPOT = '#e5484d';

function PayoffTooltip({ active, payload, label }: any) {
  if (!active || !payload || !payload.length) return null;
  const spotPrice = Number(label);
  const expItem = payload.find((p: any) => p.dataKey === 'pnlExpiry');
  const todayItem = payload.find((p: any) => p.dataKey === 'pnlToday');
  const expVal = expItem?.value;
  const todayVal = todayItem?.value;

  return (
    <div className="bg-zinc-950/98 border border-zinc-700/80 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur min-w-[210px] font-mono select-none">
      <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5 mb-2">
        <span className="text-[11px] text-zinc-400 font-semibold uppercase tracking-wider">Spot Price</span>
        <span className="font-black text-white text-sm">₹{spotPrice.toLocaleString('en-IN')}</span>
      </div>

      <div className="space-y-1.5 text-xs">
        {todayVal != null && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-semibold" style={{ color: PAYOFF_TODAY }}>
              <span className="w-2.5 h-0.5 inline-block" style={{ backgroundColor: PAYOFF_TODAY }} />
              Today (T+0):
            </span>
            <span className={`font-bold ${todayVal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {todayVal >= 0 ? '+' : ''}₹{Math.round(todayVal).toLocaleString('en-IN')}
            </span>
          </div>
        )}

        {expVal != null && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 font-semibold" style={{ color: PAYOFF_EXPIRY }}>
              <span className="w-2.5 h-0.5 inline-block" style={{ backgroundColor: PAYOFF_EXPIRY }} />
              At Expiry:
            </span>
            <span className={`font-black ${expVal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {expVal >= 0 ? '+' : ''}₹{Math.round(expVal).toLocaleString('en-IN')}
            </span>
          </div>
        )}
      </div>

      {todayVal != null && expVal != null && (
        <div className="pt-2 mt-2 border-t border-zinc-800 flex items-center justify-between text-[11px]">
          <span className="text-zinc-400 font-medium">Theta Left:</span>
          <span className="text-zinc-200 font-bold">
            ₹{Math.max(0, Math.round(expVal - todayVal)).toLocaleString('en-IN')}
          </span>
        </div>
      )}
    </div>
  );
}

function formatTargetDateDisplay(daysRemaining: number, expiryDateStr?: string): string {
  if (!expiryDateStr) return `${daysRemaining.toFixed(1)}d`;
  try {
    const [y, m, d] = expiryDateStr.split('-').map(Number);
    const expTime = new Date(Date.UTC(y, m - 1, d, 10, 0, 0)).getTime();
    const targetMs = expTime - (daysRemaining * 24 * 3600 * 1000);
    const dt = new Date(targetMs);
    const daysOfWeek = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dow = daysOfWeek[dt.getDay()];
    const day = dt.getDate();
    const mon = months[dt.getMonth()];
    return `${dow}, ${day} ${mon}`;
  } catch {
    return `${daysRemaining.toFixed(1)}d`;
  }
}

export default function BasketPayoffChart({
  legs = [],
  spot,
  strikeStep = 50,
  lotSize = 75,
  currentExpiry = '',
  futurePrice = null,
  futureBasis = null,
  futureExpiry = null,
  baseIv = 0.1313,
  underlying = 'NIFTY',
  emptyReason,
  points: legacyPoints,
  breakevens: legacyBreakevens,
}: BasketPayoffChartProps) {
  const [isPayoffFullscreen, setIsPayoffFullscreen] = useState(false);
  const [targetSpot, setTargetSpot] = useState<number | null>(null);
  const [targetDays, setTargetDays] = useState<number | null>(null);

  // Real remaining time on the selected expiry. Never floored to an arbitrary constant — a
  // same-day/next-day expiry must cap the target-date slider (and thus the T+0 Black-76 eval
  // time and SD bands) at its own remaining time, not a wider weekly-expiry assumption. Uses
  // the same calculateTimeToExpiryYears as the Options Monitor page and PositionsStrategyMonitor
  // so both pages render an identical payoff curve for the same legs.
  const maxDays = Math.max(0.05, (currentExpiry ? calculateTimeToExpiryYears(currentExpiry) * 365 : 4.0));

  const effectiveTargetSpot = targetSpot ?? spot;
  // Default (untouched slider) is "today", i.e. the full remaining time to the real expiry.
  const effectiveTargetDays = Math.min(targetDays ?? maxDays, maxDays);
  const targetSpotChangePct = spot > 0 ? ((effectiveTargetSpot - spot) / spot) * 100 : 0;

  // Esc key & body scroll lock in full screen
  useEffect(() => {
    if (!isPayoffFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setIsPayoffFullscreen(false);
    };
    window.addEventListener('keydown', onKey);
    const orig = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = orig;
    };
  }, [isPayoffFullscreen]);

  // Identify key nearest short strikes for accurate clearance calculation
  const shortCeLeg = useMemo(() => {
    return legs
      .filter((l) => l.type === 'CE' && l.side === 'SELL')
      .sort((a, b) => a.strike - b.strike)[0];
  }, [legs]);

  const shortPeLeg = useMemo(() => {
    return legs
      .filter((l) => l.type === 'PE' && l.side === 'SELL')
      .sort((a, b) => b.strike - a.strike)[0];
  }, [legs]);

  const ceClearancePts = shortCeLeg && spot > 0 ? Math.round(shortCeLeg.strike - spot) : null;
  const peClearancePts = shortPeLeg && spot > 0 ? Math.round(spot - shortPeLeg.strike) : null;

  // Compute 2D payoff curve, breakevens & 1SD/2SD expected-move bands
  const { points: payoffPoints, breakevens, sdLevels } = useMemo(() => {
    if (legs.length > 0 && spot > 0) {
      const evalTimeYears = Math.max(0.0001, effectiveTargetDays / 365);
      return generatePayoffCurve(
        legs,
        spot,
        lotSize,
        evalTimeYears,
        baseIv,
        strikeStep,
        futurePrice ?? undefined,
        evalTimeYears
      );
    }
    if (legacyPoints && legacyPoints.length > 1) {
      const pts: PayoffPoint[] = legacyPoints.map((p) => ({
        spot: p.x,
        pnlExpiry: Math.round(p.y),
        pnlToday: Math.round(p.y),
      }));
      return {
        points: pts,
        minPnl: Math.min(...pts.map((p) => p.pnlExpiry)),
        maxPnl: Math.max(...pts.map((p) => p.pnlExpiry)),
        breakevens: legacyBreakevens ?? [],
        sdLevels: null,
      };
    }
    return { points: [], minPnl: 0, maxPnl: 0, breakevens: [], sdLevels: null };
  }, [legs, spot, lotSize, baseIv, strikeStep, futurePrice, effectiveTargetDays, legacyPoints, legacyBreakevens]);

  // Numeric spot domain for Recharts
  const spotDomain = useMemo<[number, number] | null>(() => {
    if (payoffPoints.length === 0) return null;
    return [payoffPoints[0].spot, payoffPoints[payoffPoints.length - 1].spot];
  }, [payoffPoints]);

  // Round-number strike ticks
  const spotTicks = useMemo(() => {
    if (!spotDomain) return [];
    const [lo, hi] = spotDomain;
    const span = hi - lo;
    if (span <= 0) return [];
    const rawStep = span / 6;
    const power = Math.pow(10, Math.floor(Math.log10(rawStep)));
    const frac = rawStep / power;
    const step = (frac < 1.5 ? 1 : frac < 3.5 ? 2 : frac < 7.5 ? 5 : 10) * power;
    const first = Math.ceil(lo / step) * step;
    const ticks: number[] = [];
    for (let t = first; t <= hi; t += step) ticks.push(t);
    return ticks;
  }, [spotDomain]);

  // Profit / loss zones for diagonal hatching
  const payoffZones = useMemo(() => {
    if (!spotDomain || legs.length === 0) return [];
    const [lo, hi] = spotDomain;
    const pts = [lo, ...breakevens.filter((b) => b > lo && b < hi), hi].sort((a, b) => a - b);
    const zones: { x1: number; x2: number; positive: boolean }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = (pts[i] + pts[i + 1]) / 2;
      const pnlAtMid = computeExpiryPnlAtSpot(legs, mid, lotSize);
      zones.push({
        x1: pts[i],
        x2: pts[i + 1],
        positive: pnlAtMid >= 0,
      });
    }
    return zones;
  }, [breakevens, spotDomain, legs, lotSize]);

  // SD reference line markers on numeric spot axis (Sensibull parity)
  const sdMarkers = useMemo(() => {
    if (!sdLevels || !spotDomain) return [];
    return [
      { x: sdLevels.exactLo2, label: '-2SD' },
      { x: sdLevels.exactLo1, label: '-1SD' },
      { x: sdLevels.exactHi1, label: '1SD' },
      { x: sdLevels.exactHi2, label: '2SD' },
    ];
  }, [sdLevels, spotDomain]);

  // Projected P&L at target spot on target date (Sensibull's bottom projected badge)
  const projectedPnl = useMemo(() => {
    if (payoffPoints.length === 0) return null;
    let best = payoffPoints[0];
    for (const p of payoffPoints) {
      if (Math.abs(p.spot - effectiveTargetSpot) < Math.abs(best.spot - effectiveTargetSpot)) best = p;
    }
    return best.pnlToday;
  }, [payoffPoints, effectiveTargetSpot]);

  if (payoffPoints.length < 2) {
    return (
      <TerminalPanel
        title="PAYOFF & STRIKE CLEARANCE GRAPH"
        icon={TrendingUp}
        meta={
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1.5 font-semibold" style={{ color: PAYOFF_EXPIRY }}>
              <span className="w-3 h-0.5 inline-block" style={{ backgroundColor: PAYOFF_EXPIRY }} />
              On Expiry
            </span>
            <span className="flex items-center gap-1.5 font-semibold" style={{ color: PAYOFF_TODAY }}>
              <span className="w-3 h-0.5 inline-block" style={{ backgroundColor: PAYOFF_TODAY }} />
              On Target Date (T+0)
            </span>
          </div>
        }
      >
        <div className="flex flex-col items-center justify-center h-80 gap-1.5 text-zinc-500 font-mono">
          <p className="text-sm font-semibold text-zinc-400">No payoff to show yet</p>
          <p className="text-xs">{emptyReason ?? 'Pick a strategy or add legs with valid prices'}</p>
        </div>
      </TerminalPanel>
    );
  }

  const payoffPanel = (
    <div
      className={
        isPayoffFullscreen
          ? 'fixed inset-0 z-50 overflow-y-auto bg-zinc-950 p-4 md:p-6 flex flex-col font-mono select-none'
          : 'w-full font-mono select-none'
      }
    >
      <TerminalPanel
        title="PAYOFF & STRIKE CLEARANCE GRAPH"
        icon={TrendingUp}
        action={
          <button
            type="button"
            onClick={() => setIsPayoffFullscreen((f) => !f)}
            className="p-1 text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 rounded transition-colors cursor-pointer"
            title={isPayoffFullscreen ? 'Exit full screen (Esc)' : 'Full screen'}
            aria-label={isPayoffFullscreen ? 'Exit full screen' : 'Full screen'}
          >
            {isPayoffFullscreen ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
        }
        meta={
          <div className="flex items-center gap-3 text-[11px]">
            <span className="flex items-center gap-1.5 font-semibold" style={{ color: PAYOFF_EXPIRY }}>
              <span className="w-3 h-0.5 inline-block" style={{ backgroundColor: PAYOFF_EXPIRY }} />
              On Expiry
            </span>
            <span className="flex items-center gap-1.5 font-semibold" style={{ color: PAYOFF_TODAY }}>
              <span className="w-3 h-0.5 inline-block" style={{ backgroundColor: PAYOFF_TODAY }} />
              On Target Date (T+0)
            </span>
          </div>
        }
      >
        <div className="p-3.5 flex flex-col gap-3 flex-1 min-h-0">
          {/* 2D Recharts Payoff Chart */}
          <div className={isPayoffFullscreen ? 'h-[52vh] min-h-[380px] w-full' : 'h-72 w-full'}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={payoffPoints} margin={{ top: 28, right: 28, left: 14, bottom: 46 }}>
                {/* Diagonal hatch fills for profit / loss zones */}
                <defs>
                  <pattern
                    id="payoffHatchProfit"
                    patternUnits="userSpaceOnUse"
                    width="7"
                    height="7"
                    patternTransform="rotate(45)"
                  >
                    <rect width="7" height="7" fill={PAYOFF_PROFIT} fillOpacity={0.05} />
                    <line x1="0" y1="0" x2="0" y2="7" stroke={PAYOFF_PROFIT} strokeOpacity={0.13} strokeWidth={1} />
                  </pattern>
                  <pattern
                    id="payoffHatchLoss"
                    patternUnits="userSpaceOnUse"
                    width="7"
                    height="7"
                    patternTransform="rotate(45)"
                  >
                    <rect width="7" height="7" fill={PAYOFF_LOSS} fillOpacity={0.045} />
                    <line x1="0" y1="0" x2="0" y2="7" stroke={PAYOFF_LOSS} strokeOpacity={0.12} strokeWidth={1} />
                  </pattern>
                </defs>

                <CartesianGrid strokeDasharray="3 6" stroke="var(--chart-grid)" vertical={false} />
                <XAxis
                  dataKey="spot"
                  type="number"
                  domain={spotDomain ?? ['dataMin', 'dataMax']}
                  ticks={spotTicks.length > 0 ? spotTicks : undefined}
                  allowDataOverflow={false}
                  stroke="var(--chart-axis)"
                  fontSize={10}
                  tickLine={false}
                  tick={{ fill: 'var(--chart-tick)', fontSize: 10, fontWeight: 600 }}
                  tickFormatter={(v) => Number(v).toLocaleString('en-IN')}
                />
                <YAxis
                  stroke="var(--chart-axis)"
                  fontSize={10}
                  tickLine={false}
                  tick={{ fill: 'var(--chart-tick)', fontSize: 10, fontWeight: 600 }}
                  width={62}
                  tickFormatter={(v) => Number(v).toLocaleString('en-IN')}
                  label={{
                    value: 'Profit / loss',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fill: 'var(--chart-tick)', fontSize: 10, fontWeight: 600, textAnchor: 'middle' },
                  }}
                />
                <Tooltip
                  content={<PayoffTooltip />}
                  cursor={{ stroke: 'var(--chart-tick)', strokeWidth: 1, strokeDasharray: '3 3' }}
                />

                {/* Profit / Loss background zones */}
                {payoffZones.map((zone) => (
                  <ReferenceArea
                    key={`${zone.x1}-${zone.x2}`}
                    x1={zone.x1}
                    x2={zone.x2}
                    fill={zone.positive ? 'url(#payoffHatchProfit)' : 'url(#payoffHatchLoss)'}
                    fillOpacity={1}
                  />
                ))}

                {/* Zero P&L Line */}
                <ReferenceLine y={0} stroke="var(--chart-axis)" strokeWidth={1.5} />

                {/* 1SD Range Shading (Sensibull Parity: 68% probability zone) */}
                {sdLevels && (
                  <ReferenceArea
                    x1={sdLevels.exactLo1}
                    x2={sdLevels.exactHi1}
                    fill="var(--chart-tick)"
                    fillOpacity={0.04}
                  />
                )}

                {/* 1SD / 2SD Expected Move Markers */}
                {sdMarkers.map((m) => (
                  <ReferenceLine
                    key={m.label}
                    x={m.x}
                    stroke="var(--chart-tick)"
                    strokeDasharray="5 4"
                    strokeWidth={1}
                    strokeOpacity={0.65}
                    label={{
                      value: m.label,
                      fill: 'var(--chart-tick)',
                      fontSize: 10,
                      fontWeight: 600,
                      position: 'insideTop',
                    }}
                  />
                ))}

                {/* Short PE / CE strike markers */}
                {shortPeLeg && (
                  <ReferenceLine
                    x={shortPeLeg.strike}
                    stroke="var(--chart-tick)"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                    strokeOpacity={0.4}
                  />
                )}
                {shortCeLeg && (
                  <ReferenceLine
                    x={shortCeLeg.strike}
                    stroke="var(--chart-tick)"
                    strokeDasharray="3 3"
                    strokeWidth={1}
                    strokeOpacity={0.4}
                  />
                )}

                {/* Underlying Spot Marker Line, with a "Current price" pill */}
                <ReferenceLine
                  x={spot}
                  stroke={PAYOFF_SPOT}
                  strokeWidth={1.5}
                  label={(props: any) => {
                    const { viewBox } = props;
                    const text = `Current price: ${spot.toFixed(2)}`;
                    const boxWidth = text.length * 5.8 + 16;
                    const boxHeight = 18;
                    const cx = viewBox.x;
                    const y = viewBox.y - boxHeight - 3;
                    return (
                      <g>
                        <rect
                          x={cx - boxWidth / 2}
                          y={y}
                          width={boxWidth}
                          height={boxHeight}
                          rx={4}
                          fill="var(--chart-tooltip-bg)"
                          stroke="var(--chart-tooltip-border)"
                          strokeWidth={1}
                        />
                        <text
                          x={cx}
                          y={y + boxHeight / 2 + 3.5}
                          textAnchor="middle"
                          fontSize={10}
                          fontWeight={600}
                          fill="var(--chart-tooltip-text)"
                        >
                          {text}
                        </text>
                      </g>
                    );
                  }}
                />

                {/* Target Spot Marker Line (if shifted from current spot) */}
                {effectiveTargetSpot !== spot && (
                  <ReferenceLine
                    x={effectiveTargetSpot}
                    stroke="#2d7ff9"
                    strokeDasharray="3 3"
                    strokeWidth={1.5}
                    label={(props: any) => {
                      const { viewBox } = props;
                      const text = `Target: ${effectiveTargetSpot.toFixed(2)}`;
                      const boxWidth = text.length * 5.8 + 16;
                      const boxHeight = 18;
                      const cx = viewBox.x;
                      const y = viewBox.y - boxHeight - 3;
                      return (
                        <g>
                          <rect
                            x={cx - boxWidth / 2}
                            y={y}
                            width={boxWidth}
                            height={boxHeight}
                            rx={4}
                            fill="#1e3a8a"
                            stroke="#3b82f6"
                            strokeWidth={1}
                          />
                          <text
                            x={cx}
                            y={y + boxHeight / 2 + 3.5}
                            textAnchor="middle"
                            fontSize={10}
                            fontWeight={600}
                            fill="#93c5fd"
                          >
                            {text}
                          </text>
                        </g>
                      );
                    }}
                  />
                )}

                {/* Projected P&L at the target spot. Evaluated on Target Date (T+0). */}
                {projectedPnl != null && (
                  <ReferenceLine
                    x={effectiveTargetSpot}
                    stroke="transparent"
                    label={(props: any) => {
                      const { viewBox } = props;
                      const positive = projectedPnl >= 0;
                      const text = `${positive ? 'Projected profit' : 'Projected loss'}: ${positive ? '+' : ''}₹${Math.round(projectedPnl).toLocaleString('en-IN')}`;
                      const boxWidth = text.length * 5.8 + 16;
                      const boxHeight = 18;
                      const cx = viewBox.x;
                      // Clear the x-axis tick labels, which recharts draws just under the plot.
                      const y = viewBox.y + viewBox.height + 20;
                      return (
                        <g>
                          <rect
                            x={cx - boxWidth / 2}
                            y={y}
                            width={boxWidth}
                            height={boxHeight}
                            rx={4}
                            fill={positive ? PAYOFF_PROFIT : PAYOFF_LOSS}
                          />
                          <text
                            x={cx}
                            y={y + boxHeight / 2 + 3.5}
                            textAnchor="middle"
                            fontSize={10}
                            fontWeight={700}
                            fill="#ffffff"
                          >
                            {text}
                          </text>
                        </g>
                      );
                    }}
                  />
                )}

                {/* On Target Date (T+0): smooth Black-Scholes theoretical-price curve.
                    Animation is disabled: `payoffPoints` is recomputed on every live quote/WS
                    tick, so a new `data` array reaches <LineChart> before Recharts' mount/update
                    clip-path animation can finish — it keeps restarting from width 0 and the
                    curve never becomes visible. */}
                <Line
                  type="monotone"
                  dataKey="pnlToday"
                  stroke={PAYOFF_TODAY}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  name="On Target Date (T+0)"
                  isAnimationActive={false}
                />
                {/* On Expiry: exact piecewise-linear intrinsic payoff with crisp strike corners */}
                <Line
                  type="linear"
                  dataKey="pnlExpiry"
                  stroke={PAYOFF_EXPIRY}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  name="On Expiry"
                  isAnimationActive={false}
                />

                {/* Breakeven markers: where the On Expiry curve crosses zero P&L */}
                {breakevens
                  .filter((b) => spotDomain && b > spotDomain[0] && b < spotDomain[1])
                  .map((b) => (
                    <ReferenceDot
                      key={`be-${b}`}
                      x={b}
                      y={0}
                      r={4}
                      fill="var(--color-zinc-900)"
                      stroke={PAYOFF_EXPIRY}
                      strokeWidth={2}
                    />
                  ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* ── INTERACTIVE TARGET SPOT & TARGET DATE CONTROLS (Sensibull Parity) ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
            {/* Left: Target Spot Slider */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-zinc-200">{underlying} Target</span>
                  <span className={`text-[11px] font-bold tabular-nums ${targetSpotChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {targetSpotChangePct >= 0 ? '+' : ''}{targetSpotChangePct.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center border border-zinc-700 bg-zinc-900 rounded px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => setTargetSpot(Math.round((effectiveTargetSpot - strikeStep / 2) * 10) / 10)}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold cursor-pointer"
                      title="Decrease target spot"
                    >
                      -
                    </button>
                    <span className="px-2 font-mono font-bold text-zinc-100 tabular-nums text-xs">
                      {effectiveTargetSpot.toFixed(1)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setTargetSpot(Math.round((effectiveTargetSpot + strikeStep / 2) * 10) / 10)}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold cursor-pointer"
                      title="Increase target spot"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTargetSpot(spot)}
                    className="text-[11px] text-sky-400 hover:text-sky-300 underline font-medium cursor-pointer ml-1"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {/* Slider for Target Spot */}
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={Math.round(spot * 0.94)}
                  max={Math.round(spot * 1.06)}
                  step={strikeStep / 10}
                  value={effectiveTargetSpot}
                  onChange={(e) => setTargetSpot(parseFloat(e.target.value))}
                  className="w-full accent-sky-500 bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-500 tabular-nums">
                <span>-6% ({(spot * 0.94).toFixed(0)})</span>
                <span className="text-zinc-400 font-medium">Current: {spot.toFixed(1)}</span>
                <span>+6% ({(spot * 1.06).toFixed(0)})</span>
              </div>
            </div>

            {/* Right: Target Date Slider */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-zinc-200">Date:</span>
                  <span className="text-amber-400 font-bold tabular-nums text-xs">
                    {effectiveTargetDays.toFixed(1)}D to expiry
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center border border-zinc-700 bg-zinc-900 rounded px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => setTargetDays(Math.min(maxDays, effectiveTargetDays + 0.5))}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold cursor-pointer"
                      title="Earlier date (more days to expiry)"
                    >
                      &lt;
                    </button>
                    <span className="px-2 font-mono font-medium text-zinc-200 tabular-nums text-xs">
                      {formatTargetDateDisplay(effectiveTargetDays, currentExpiry)}
                    </span>
                    <button
                      type="button"
                      onClick={() => setTargetDays(Math.max(0.05, effectiveTargetDays - 0.5))}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold cursor-pointer"
                      title="Later date (fewer days to expiry)"
                    >
                      &gt;
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setTargetDays(null)}
                    className="text-[11px] text-sky-400 hover:text-sky-300 underline font-medium cursor-pointer ml-1"
                  >
                    Reset
                  </button>
                </div>
              </div>

              {/* Slider for Target Date */}
              <div className="flex items-center gap-2">
                <input
                  type="range"
                  min={0.05}
                  max={maxDays}
                  step={0.1}
                  value={effectiveTargetDays}
                  onChange={(e) => setTargetDays(parseFloat(e.target.value))}
                  className="w-full accent-amber-500 bg-zinc-800 h-1.5 rounded-lg cursor-pointer"
                />
              </div>
              <div className="flex justify-between text-[10px] text-zinc-500 tabular-nums">
                <span>At Expiry (0D)</span>
                <span className="text-zinc-400 font-medium">Target: {effectiveTargetDays.toFixed(1)}d</span>
                <span>Inception ({maxDays.toFixed(1)}D)</span>
              </div>
            </div>
          </div>

          {/* ── SENSIBULL PARITY METRICS: TARGET DAY FUTURES & STANDARD DEVIATION ── */}
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
            {/* Target Day Futures Card */}
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs flex flex-col justify-between">
              <div className="flex items-center justify-between pb-1 mb-1 border-b border-zinc-800/80">
                <span className="text-zinc-400 font-bold uppercase tracking-wider text-[11px]">
                  Target Day Futures Prices
                </span>
                <span className="text-[10px] text-zinc-500">Black-76 Base</span>
              </div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-zinc-300 font-semibold">
                  {formatShortExpiry(currentExpiry)} FUT
                </span>
                <span className="font-bold text-white tabular-nums text-sm">
                  ₹{futurePrice != null && futurePrice > 0
                    ? futurePrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
                    : (spot + (futureBasis || 0)).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
              </div>
              {futureBasis != null && (
                <div className="flex items-center justify-between text-[11px] text-zinc-400 mt-1 pt-1 border-t border-zinc-900">
                  <span>Futures Basis:</span>
                  <span className={`font-bold tabular-nums ${futureBasis >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {futureBasis >= 0 ? '+' : ''}{futureBasis.toFixed(2)} pts
                  </span>
                </div>
              )}
            </div>

            {/* Standard Deviation Table (Sensibull Parity: 1SD and 2SD bands) */}
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
              <div className="flex items-center justify-between pb-1 mb-1 border-b border-zinc-800/80">
                <span className="text-zinc-400 font-bold uppercase tracking-wider text-[11px]">
                  Standard Deviation
                </span>
                <span className="text-[10px] text-zinc-500 font-mono">
                  {sdLevels ? `${(sdLevels.vol * 100).toFixed(1)}% IV · ${sdLevels.days.toFixed(1)}d` : ''}
                </span>
              </div>
              {sdLevels ? (
                <div className="mt-1 font-mono text-[11px]">
                  <div className="grid grid-cols-3 text-zinc-500 pb-1 border-b border-zinc-900 text-[10px] font-semibold">
                    <span>SD</span>
                    <span className="text-center">Points</span>
                    <span className="text-right">Price</span>
                  </div>
                  <div className="grid grid-cols-3 py-1 items-start border-b border-zinc-900/50">
                    <span className="text-zinc-400 font-medium">1 SD</span>
                    <span className="text-center text-zinc-400 tabular-nums">
                      {sdLevels.points1.toFixed(1)} ({((sdLevels.points1 / spot) * 100).toFixed(1)}%)
                    </span>
                    <div className="text-right flex flex-col font-bold text-zinc-200 tabular-nums">
                      <span>{sdLevels.exactLo1.toFixed(1)}</span>
                      <span>{sdLevels.exactHi1.toFixed(1)}</span>
                    </div>
                  </div>
                  <div className="grid grid-cols-3 py-1 items-start">
                    <span className="text-zinc-400 font-medium">2 SD</span>
                    <span className="text-center text-zinc-400 tabular-nums">
                      {sdLevels.points2.toFixed(1)} ({((sdLevels.points2 / spot) * 100).toFixed(1)}%)
                    </span>
                    <div className="text-right flex flex-col font-bold text-zinc-200 tabular-nums">
                      <span>{sdLevels.exactLo2.toFixed(1)}</span>
                      <span>{sdLevels.exactHi2.toFixed(1)}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <span className="text-zinc-500 text-[11px]">Calculating SD levels...</span>
              )}
            </div>

            {/* Breakeven & Clearance Summary */}
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs flex flex-col justify-between">
              <div className="flex items-center justify-between pb-1 mb-1 border-b border-zinc-800/80">
                <span className="text-zinc-400 font-bold uppercase tracking-wider text-[11px]">
                  Clearance & Range
                </span>
                <span className="text-[10px] text-zinc-500">Intraday Safety</span>
              </div>
              <div className="flex items-center justify-between mt-1 text-[11px]">
                <span className="text-zinc-400">PE {shortPeLeg ? shortPeLeg.strike : '—'}:</span>
                <span className={`font-bold tabular-nums ${peClearancePts != null && peClearancePts > 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {peClearancePts != null ? `-${peClearancePts} pts` : '—'}
                </span>
              </div>
              <div className="flex items-center justify-between text-[11px]">
                <span className="text-zinc-400">CE {shortCeLeg ? shortCeLeg.strike : '—'}:</span>
                <span className={`font-bold tabular-nums ${ceClearancePts != null && ceClearancePts > 50 ? 'text-emerald-400' : 'text-amber-400'}`}>
                  {ceClearancePts != null ? `+${ceClearancePts} pts` : '—'}
                </span>
              </div>
              {breakevens.length >= 2 && (
                <div className="flex items-center justify-between text-[11px] pt-1 mt-1 border-t border-zinc-900">
                  <span className="text-zinc-400">BE Width:</span>
                  <span className="font-bold text-amber-400 tabular-nums">
                    {breakevens[1] - breakevens[0]} pts
                  </span>
                </div>
              )}
            </div>
          </div>

          {/* ── EXPECTED MOVE (SD) READOUT ── */}
          {sdLevels && (
            <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
              <div className="flex items-center gap-4 flex-wrap">
                <span className="text-zinc-400 font-semibold">Expected Move:</span>
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500">1SD</span>
                  <span className="text-zinc-200 font-bold tabular-nums">
                    {sdLevels.lo1.toLocaleString('en-IN')} &mdash; {sdLevels.hi1.toLocaleString('en-IN')}
                  </span>
                  <span className="text-[10px] text-zinc-500 font-bold tabular-nums">
                    (&plusmn;{sdLevels.points1.toLocaleString('en-IN')} pts / {((sdLevels.points1 / spot) * 100).toFixed(1)}%)
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-zinc-500">2SD</span>
                  <span className="text-zinc-200 font-bold tabular-nums">
                    {sdLevels.lo2.toLocaleString('en-IN')} &mdash; {sdLevels.hi2.toLocaleString('en-IN')}
                  </span>
                  <span className="text-[10px] text-zinc-500 font-bold tabular-nums">
                    (&plusmn;{sdLevels.points2.toLocaleString('en-IN')} pts / {((sdLevels.points2 / spot) * 100).toFixed(1)}%)
                  </span>
                </div>
              </div>
              <div className="flex items-center gap-1.5 text-zinc-500 text-[11px]">
                <span>from</span>
                <span className="text-zinc-300 font-bold tabular-nums">
                  {(sdLevels.vol * 100).toFixed(1)}% IV
                </span>
                <span>over</span>
                <span className="text-zinc-300 font-bold tabular-nums">
                  {sdLevels.days.toFixed(2)}d
                </span>
                <span>t</span>
              </div>
            </div>
          )}
        </div>
      </TerminalPanel>
    </div>
  );

  if (isPayoffFullscreen && typeof document !== 'undefined') {
    return (
      <>
        <div className="w-full h-72 rounded-xl border border-dashed border-zinc-800 flex items-center justify-center text-xs text-zinc-600">
          Payoff graph opened in full screen (Press Esc to restore)
        </div>
        {createPortal(payoffPanel, document.body)}
      </>
    );
  }

  return payoffPanel;
}
