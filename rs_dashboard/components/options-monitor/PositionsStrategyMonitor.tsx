'use client';

import React, { useMemo, useState, useRef } from 'react';
import { OptionLegModel, PayoffPoint, PositionGuard, SdLevels, formatShortExpiry, computeExpiryPnlAtSpot } from '@/lib/optionsMonitorMath';
import TerminalPanel from './TerminalPanel';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
  ReferenceArea,
} from 'recharts';
import {
  Plus,
  Trash2,
  TrendingUp,
  Activity,
  SlidersHorizontal,
  Zap,
  Lock,
  Unlock,
  Table2,
} from 'lucide-react';

const GUARD_PRESET_PCTS = [10, 20, 30, 50];

// Payoff-chart data colours. These are the CLAUDE.md "saturated data colour" exception —
// deliberately fixed hex in both themes so the chart reads the same way as the industry-
// standard payoff diagram it mirrors: the kinked at-expiry curve is red/vermillion, the
// smooth pre-expiry (T+0) curve is blue, profit green / loss red for the shaded zones.
const PAYOFF_EXPIRY = '#e0533d';
const PAYOFF_TODAY = '#2d7ff9';
const PAYOFF_PROFIT = '#16a34a';
const PAYOFF_LOSS = '#e5484d';
const PAYOFF_SPOT = '#e5484d';

function GuardStepper({
  value,
  onChange,
  colorCls,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  colorCls: string;
  disabled?: boolean;
}) {
  const step = (delta: number) => {
    const cur = parseFloat(value) || 0;
    const next = Math.max(0, cur + delta);
    onChange((Math.round(next * 20) / 20).toFixed(2));
  };
  return (
    <div className="flex flex-col">
      <button
        type="button"
        onClick={() => step(0.5)}
        tabIndex={-1}
        disabled={disabled}
        aria-label="Increase by 0.5"
        className={`leading-none text-[8px] px-1 py-0.5 rounded-t border border-b-0 border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${colorCls}`}
      >
        ▲
      </button>
      <button
        type="button"
        onClick={() => step(-0.5)}
        tabIndex={-1}
        disabled={disabled}
        aria-label="Decrease by 0.5"
        className={`leading-none text-[8px] px-1 py-0.5 rounded-b border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer ${colorCls}`}
      >
        ▼
      </button>
    </div>
  );
}

function GuardInput({
  value,
  onCommit,
  colorCls,
  focusBorderCls,
  disabled,
}: {
  value: string;
  onCommit: (v: string) => void;
  colorCls: string;
  focusBorderCls: string;
  disabled?: boolean;
}) {
  const [draft, setDraftState] = useState<string | null>(null);
  const focusedRef = useRef(false);

  const shown = draft ?? value;
  const dirty = draft !== null && draft !== value;

  const commit = (next: string) => {
    const trimmed = next.trim();
    if (trimmed !== value) onCommit(trimmed);
    setDraftState(null);
  };

  return (
    <div className="flex items-center gap-1">
      <input
        type="number"
        step="0.05"
        min="0"
        value={shown}
        onFocus={() => {
          focusedRef.current = true;
        }}
        onChange={(e) => setDraftState(e.target.value)}
        onBlur={(e) => {
          focusedRef.current = false;
          commit(e.currentTarget.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit((e.target as HTMLInputElement).value);
            (e.target as HTMLInputElement).blur();
          } else if (e.key === 'Escape') {
            setDraftState(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="—"
        disabled={disabled}
        title="Press Enter or click away to apply"
        className={`w-16 bg-zinc-950 border text-xs font-mono rounded px-1.5 py-1 focus:outline-none tabular-nums text-right placeholder:text-zinc-600 disabled:opacity-40 ${colorCls} ${
          dirty ? 'border-amber-400' : `border-zinc-700 ${focusBorderCls}`
        }`}
      />
      <GuardStepper
        value={shown}
        onChange={(v) => {
          setDraftState(null);
          onCommit(v);
        }}
        colorCls={colorCls}
        disabled={disabled}
      />
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

interface PositionsStrategyMonitorProps {
  strategyName: string;
  totalLots: number;
  totalQty: number;
  legs: OptionLegModel[];
  spot: number;
  strikeStep: number;
  payoffPoints: PayoffPoint[];
  breakevens: number[];
  sdLevels?: SdLevels | null;
  chainStrikes?: number[];
  currentExpiry?: string;
  futurePrice?: number | null;
  futureBasis?: number;
  futureExpiry?: string;
  targetSpot?: number;
  onTargetSpotChange?: (spot: number) => void;
  targetDays?: number;
  onTargetDaysChange?: (days: number) => void;
  initialDays?: number;
  guards?: Record<string, PositionGuard>;
  onGuardChange?: (legId: string, field: 'target' | 'sl', value: string) => void;
  onTrailToggle?: (legId: string) => void;
  onAddLegClick: () => void;
  onRemoveLeg: (id: string) => void;
  onUpdateLegStrike: (id: string, newStrike: number) => void;
  onQuickShiftStrike: (id: string, steps: number) => void;
  onSelectStrategyPreset: (presetId: string) => void;
  onUpdateLegLots?: (id: string, deltaLots: number) => void;
  onUpdateAllLots?: (deltaLots: number) => void;
  onOpenTradeBasket?: () => void;
  onOpenSingleLegTrade?: (leg: OptionLegModel) => void;
  onCloseSingleLeg?: (leg: OptionLegModel) => void;
  onToggleLegEntered?: (id: string) => void;
  onOpenOptionChain?: () => void;
}

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

export default function PositionsStrategyMonitor({
  strategyName,
  totalLots,
  totalQty,
  legs,
  spot,
  strikeStep,
  payoffPoints,
  breakevens,
  sdLevels,
  chainStrikes,
  currentExpiry,
  futurePrice,
  futureBasis,
  futureExpiry,
  targetSpot,
  onTargetSpotChange,
  targetDays,
  onTargetDaysChange,
  initialDays,
  guards,
  onGuardChange,
  onTrailToggle,
  onAddLegClick,
  onRemoveLeg,
  onUpdateLegStrike,
  onQuickShiftStrike,
  onSelectStrategyPreset,
  onUpdateLegLots,
  onUpdateAllLots,
  onOpenTradeBasket,
  onOpenSingleLegTrade,
  onCloseSingleLeg,
  onToggleLegEntered,
  onOpenOptionChain,
}: PositionsStrategyMonitorProps) {
  const effectiveTargetSpot = targetSpot ?? spot;
  const effectiveTargetDays = targetDays ?? 4.0;
  const maxDays = Math.max(4.0, initialDays ?? 4.0);
  const targetSpotChangePct = spot > 0 ? ((effectiveTargetSpot - spot) / spot) * 100 : 0;

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

  const ceClearancePts = shortCeLeg ? Math.round(shortCeLeg.strike - spot) : null;
  const peClearancePts = shortPeLeg ? Math.round(spot - shortPeLeg.strike) : null;

  // Available strikes for dropdown
  const strikeOptions = useMemo(() => {
    if (chainStrikes && chainStrikes.length > 0) {
      return chainStrikes;
    }
    const base = Math.round(spot / strikeStep) * strikeStep;
    const opts: number[] = [];
    for (let i = -16; i <= 16; i++) {
      opts.push(base + i * strikeStep);
    }
    return opts;
  }, [spot, strikeStep, chainStrikes]);

  // Strategy lot multiplier (for symmetric strategies it matches all legs, otherwise minimum leg lots)
  const lotMultiplier = useMemo(() => {
    if (legs.length === 0) return 1;
    const firstLots = legs[0].lots;
    const allSame = legs.every((l) => l.lots === firstLots);
    if (allSame) return firstLots;
    return Math.min(...legs.map((l) => l.lots));
  }, [legs]);

  // Profit/loss background zones for the payoff chart — the spot axis carved into
  // segments by the breakevens, each shaded green (profit) or red (loss) at expiry.
  // Sign is checked via the exact intrinsic payoff at a point inside the zone, not
  // just the nearest sampled curve point, so a zone too narrow to catch a sample
  // still shades correctly.
  // Plotted spot domain. The x-axis is a NUMERIC axis (type="number"), so every reference
  // line/area below positions itself off the real scale — values are used exactly as
  // computed, never snapped to a sample point.
  const spotDomain = useMemo<[number, number] | null>(() => {
    if (payoffPoints.length === 0) return null;
    return [payoffPoints[0].spot, payoffPoints[payoffPoints.length - 1].spot];
  }, [payoffPoints]);

  // Round-number x ticks (1/2/5 x power of ten), so the axis reads "22,500 / 23,000 / ..."
  // instead of one label per irregular sample.
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

  const payoffZones = useMemo(() => {
    if (!spotDomain || legs.length === 0) return [];
    const [lo, hi] = spotDomain;
    const pts = [lo, ...breakevens.filter((b) => b > lo && b < hi), hi].sort((a, b) => a - b);
    const zones: { x1: number; x2: number; positive: boolean }[] = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const mid = (pts[i] + pts[i + 1]) / 2;
      const pnlAtMid = computeExpiryPnlAtSpot(legs, mid, 1);
      zones.push({
        x1: pts[i],
        x2: pts[i + 1],
        positive: pnlAtMid >= 0,
      });
    }
    return zones;
  }, [breakevens, spotDomain, legs]);

  // SD reference line markers on the numeric spot axis (Sensibull parity)
  const sdMarkers = useMemo(() => {
    if (!sdLevels || !spotDomain) return [];
    return [
      { x: sdLevels.exactLo2, label: '-2SD' },
      { x: sdLevels.exactLo1, label: '-1SD' },
      { x: sdLevels.exactHi1, label: '1SD' },
      { x: sdLevels.exactHi2, label: '2SD' },
    ];
  }, [sdLevels, spotDomain]);

  // P&L at target spot on target date, shown as Sensibull's bottom "projected" badge.
  const projectedPnl = useMemo(() => {
    if (payoffPoints.length === 0) return null;
    let best = payoffPoints[0];
    for (const p of payoffPoints) {
      if (Math.abs(p.spot - effectiveTargetSpot) < Math.abs(best.spot - effectiveTargetSpot)) best = p;
    }
    return best.pnlToday;
  }, [payoffPoints, effectiveTargetSpot]);

  return (
    <div className="flex flex-col gap-4 font-mono select-none">
      {/* ── 1. STRATEGY & POSITIONS TERMINAL PANEL ─────────────────────────── */}
      <TerminalPanel
        title="INTRADAY STRATEGY & POSITIONS"
        icon={Activity}
        badge={
          <div className="flex items-center gap-1.5 ml-2">
            <span
              className="text-[10px] px-2 py-0.5 rounded border font-bold bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
            >
              INTRADAY (DHAN)
            </span>
            <span className="text-[10px] bg-zinc-950 text-zinc-400 px-2 py-0.5 rounded border border-zinc-800">
              {legs.length} {legs.length === 1 ? 'LEG' : 'LEGS'}
            </span>
          </div>
        }
        meta={
          <div className="flex items-center gap-2">
            {/* Global +/- Lots Stepper */}
            <div className="flex items-center gap-1.5 bg-zinc-950 px-2 py-1 rounded-lg border border-zinc-800">
              <span className="text-[10px] font-bold uppercase text-zinc-400">LOTS:</span>
              <button
                type="button"
                onClick={() => onUpdateAllLots && onUpdateAllLots(-1)}
                disabled={lotMultiplier <= 1 || legs.length === 0}
                className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700 text-xs font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Decrease multiplier (all legs by 1 lot)"
              >
                -
              </button>
              <span className="font-mono text-xs font-bold text-amber-400 min-w-[28px] text-center tabular-nums">
                {`${lotMultiplier}L`}
              </span>
              <button
                type="button"
                onClick={() => onUpdateAllLots && onUpdateAllLots(1)}
                disabled={legs.length === 0}
                className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700 text-xs font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Increase multiplier (all legs by 1 lot)"
              >
                +
              </button>
              <span className="text-zinc-500 text-[10px] ml-0.5">({totalQty})</span>
            </div>
          </div>
        }
      >
        <div className="p-3.5 flex flex-col gap-3">
          {/* Top Controls: Strategy Name & Presets */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-400">
                ACTIVE STRATEGY STRUCTURE
              </span>
              <h2 className="text-base font-bold text-white tracking-wide mt-0.5">
                {strategyName}
              </h2>
            </div>

            {/* Quick Presets & Add Leg / Sync Broker / Place Trades */}
            <div className="flex items-center gap-2 flex-wrap">
              <select
                onChange={(e) => {
                  if (e.target.value) onSelectStrategyPreset(e.target.value);
                }}
                defaultValue=""
                className="bg-zinc-950 hover:bg-zinc-800 text-zinc-200 text-xs font-bold px-2.5 py-1.5 rounded-lg border border-zinc-800 cursor-pointer focus:outline-none focus:border-amber-500/50"
              >
                <option value="" disabled>
                  Load Preset Template...
                </option>
                <option value="short_strangle">Short Strangle (OTM CE + PE)</option>
                <option value="short_straddle">Short Straddle (ATM CE + PE)</option>
                <option value="iron_condor">Iron Condor (4 Legs Defined)</option>
                <option value="bull_put_spread">Bull Put Spread (Sell PE + Buy PE)</option>
                <option value="bear_call_spread">Bear Call Spread (Sell CE + Buy CE)</option>
                <option value="clear">Clear All Legs</option>
              </select>

              <button
                type="button"
                onClick={onAddLegClick}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 font-bold text-xs transition-colors cursor-pointer"
                title="Add Custom Strike Leg [A]"
              >
                <Plus className="w-3.5 h-3.5 text-amber-400" />
                <span>ADD LEG</span>
                <span className="text-[9px] bg-amber-500/20 px-1 rounded text-amber-300">[A]</span>
              </button>

              {/* OPTION CHAIN BUTTON */}
              {onOpenOptionChain && (
                <button
                  type="button"
                  onClick={onOpenOptionChain}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-sky-500/40 bg-sky-500/10 text-sky-400 hover:bg-sky-500/20 font-bold text-xs transition-colors cursor-pointer"
                  title="Open Interactive Option Chain Window"
                >
                  <Table2 className="w-3.5 h-3.5 text-sky-400" />
                  <span>OPTION CHAIN</span>
                </button>
              )}

              {/* EXECUTE BASKET BUTTON */}
              <button
                type="button"
                onClick={onOpenTradeBasket}
                disabled={legs.length === 0}
                className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                title="Place Live Multi-Leg Order on DHAN [F5]"
              >
                <Zap className="w-3.5 h-3.5 fill-current" />
                <span>EXECUTE BASKET</span>
                <span className="text-[9px] bg-emerald-700/60 px-1.5 py-0.2 rounded font-mono">
                  {legs.length} {legs.length === 1 ? 'LEG' : 'LEGS'}
                </span>
                <span className="text-[9px] bg-emerald-700/60 px-1 py-0.2 rounded font-mono">[F5]</span>
              </button>
            </div>
          </div>

          {/* ── 2. ACTIVE LEGS TABLE WITH SHORT-FORM EXPIRY, LOT ADJUSTER & DUAL ROLLS ── */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-zinc-800 text-white font-bold text-xs">
                  <th className="py-2.5 px-3 rounded-l">LEG</th>
                  <th className="py-2.5 px-2">EXPIRY</th>
                  <th className="py-2.5 px-2">LOTS</th>
                  <th className="py-2.5 px-2">STRIKE</th>
                  <th className="py-2.5 px-2 text-right">LTP</th>
                  <th className="py-2.5 px-2 text-right">ENTRY</th>
                  <th className="py-2.5 px-2 text-center">TARGET (₹)</th>
                  <th className="py-2.5 px-2 text-center">STOP LOSS (₹)</th>
                  <th className="py-2.5 px-2 text-center">TRAIL</th>
                  <th className="py-2.5 px-2 text-right">P&L</th>
                  <th className="py-2.5 px-2 text-right">DELTA</th>
                  <th className="py-2.5 px-2 text-right">IV</th>
                  <th className="py-2.5 px-3 text-center rounded-r">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {legs.length === 0 ? (
                  <tr>
                    <td colSpan={13} className="py-8 text-center text-zinc-500 italic">
                      No active option legs. Click &quot;ADD LEG&quot; or select a preset template above.
                    </td>
                  </tr>
                ) : (
                  legs.map((leg) => {
                    const guard = guards?.[leg.id] ?? leg.guard;
                    const isSell = leg.side === 'SELL';
                    const isLong = leg.side === 'BUY';
                    const isCall = leg.type === 'CE';
                    const pnl = isSell
                      ? (leg.entryPrice - leg.ltp) * leg.qty
                      : (leg.ltp - leg.entryPrice) * leg.qty;
                    const isPnlPositive = pnl >= 0;
                    const shortExp = formatShortExpiry(leg.expiry || currentExpiry);

                    const targetNum = parseFloat(guard?.target ?? '');
                    const slNum = parseFloat(guard?.sl ?? '');
                    const initialRisk = (leg.entryPrice > 0 && !isNaN(slNum) && slNum > 0) ? Math.abs(slNum - leg.entryPrice) : 0;
                    const trailBest = (guard?.bestPrice && guard.bestPrice > 0) ? guard.bestPrice : leg.ltp;
                    const rawTrail = isLong ? trailBest - initialRisk : trailBest + initialRisk;
                    const effectiveTrailSL = (guard?.trailEnabled && !isNaN(slNum) && slNum > 0 && initialRisk > 0)
                      ? (isLong ? Math.max(slNum, rawTrail) : Math.min(slNum, rawTrail))
                      : null;

                    return (
                      <tr
                        key={leg.id}
                        className={`hover:bg-zinc-800/40 transition-colors ${
                          guard?.triggered ? 'bg-rose-950/20 border-l-2 border-rose-500' : ''
                        }`}
                      >
                        {/* Leg Type Badge */}
                        <td className="py-2.5 px-3 whitespace-nowrap">
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${
                              isSell
                                ? 'bg-red-500/10 text-red-400 border-red-500/30'
                                : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                            }`}
                          >
                            {leg.side}
                          </span>
                          <span
                            className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ml-1 ${
                              isCall
                                ? 'bg-sky-500/10 text-sky-400 border-sky-500/30'
                                : 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                            }`}
                          >
                            {leg.type}
                          </span>
                          {guard?.triggered && (
                            <button
                              type="button"
                              onClick={() => onGuardChange && onGuardChange(leg.id, 'target', guard.target)}
                              className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[9px] font-black uppercase tracking-wider bg-rose-500/20 text-rose-300 border border-rose-500/40 hover:bg-rose-500/30 transition-colors animate-pulse ml-1 cursor-pointer"
                              title={`Guard Alert: ${guard.triggerReason || 'Triggered'} (Click to dismiss alert)`}
                            >
                              <span>{guard.triggerReason || 'TRIGGERED'}</span>
                              <span className="text-[8px] text-rose-400 font-normal">✕</span>
                            </button>
                          )}
                        </td>

                        {/* Short-form Expiry */}
                        <td className="py-2.5 px-2 whitespace-nowrap">
                          <span className="font-mono text-[10px] font-bold px-1.5 py-0.5 rounded border border-amber-500/30 bg-amber-500/10 text-amber-400">
                            {shortExp}
                          </span>
                        </td>

                        {/* Dedicated Lots +/- Stepper */}
                        <td className="py-2.5 px-2 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => onUpdateLegLots && onUpdateLegLots(leg.id, -1)}
                              disabled={leg.lots <= 1}
                              className="w-4 h-4 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700 text-[10px] font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                              title="Decrease 1 lot"
                            >
                              -
                            </button>
                            <span className="font-mono text-xs font-bold text-white min-w-[22px] text-center tabular-nums">
                              {leg.lots}L
                            </span>
                            <button
                              type="button"
                              onClick={() => onUpdateLegLots && onUpdateLegLots(leg.id, 1)}
                              className="w-4 h-4 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700 text-[10px] font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                              title="Increase 1 lot"
                            >
                              +
                            </button>
                            <span className="text-[10px] text-zinc-500 font-mono ml-0.5">
                              ({leg.qty})
                            </span>
                          </div>
                        </td>

                        {/* Interactive Strike Picker / Freeze when entered */}
                        <td className="py-2.5 px-2 whitespace-nowrap">
                          {(() => {
                            const isStrikeLocked = Boolean(leg.isEntered);
                            const isAtm = leg.strike === Math.round(spot / strikeStep) * strikeStep;

                            if (isStrikeLocked) {
                              return (
                                <div className="flex items-center gap-1.5">
                                  <span
                                    className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded bg-zinc-900 border border-amber-500/40 text-xs font-bold text-white font-mono shadow-sm"
                                    title="Trade Entered: Strike locked. Use Roll ▲ or Roll ▼ in Actions to adjust, or click unlock to edit."
                                  >
                                    <Lock className="w-3 h-3 text-amber-400 shrink-0" />
                                    <span>{leg.strike}</span>
                                    {isAtm && (
                                      <span className="text-[10px] text-zinc-400 font-normal">(ATM)</span>
                                    )}
                                  </span>
                                  {onToggleLegEntered && (
                                    <button
                                      type="button"
                                      onClick={() => onToggleLegEntered(leg.id)}
                                      className="p-1 rounded hover:bg-zinc-800 text-zinc-400 hover:text-zinc-200 border border-zinc-700/60 transition-colors"
                                      title="Unlock strike to select another contract (draft mode)"
                                    >
                                      <Unlock className="w-3 h-3" />
                                    </button>
                                  )}
                                </div>
                              );
                            }

                            return (
                              <div className="flex items-center gap-1.5">
                                <select
                                  value={leg.strike}
                                  onChange={(e) => onUpdateLegStrike(leg.id, Number(e.target.value))}
                                  className="bg-zinc-950 text-white font-bold px-2.5 py-1 rounded border border-zinc-700 text-xs cursor-pointer focus:outline-none focus:border-amber-500/60"
                                >
                                  {strikeOptions.map((s) => (
                                    <option key={s} value={s}>
                                      {s} {s === Math.round(spot / strikeStep) * strikeStep ? '(ATM)' : ''}
                                    </option>
                                  ))}
                                </select>
                                {onToggleLegEntered && (
                                  <button
                                    type="button"
                                    onClick={() => onToggleLegEntered(leg.id)}
                                    className="p-1 rounded hover:bg-zinc-800 text-zinc-500 hover:text-amber-400 border border-zinc-800 hover:border-zinc-700 transition-colors"
                                    title="Lock strike (mark as entered)"
                                  >
                                    <Lock className="w-3 h-3" />
                                  </button>
                                )}
                              </div>
                            );
                          })()}
                        </td>

                        {/* LTP */}
                        <td className="py-2.5 px-2 text-right font-bold text-white tabular-nums">
                          ₹{leg.ltp.toFixed(1)}
                        </td>

                        {/* Entry Price */}
                        <td className="py-2.5 px-2 text-right text-zinc-300 tabular-nums">
                          ₹{leg.entryPrice.toFixed(1)}
                        </td>

                        {/* Target (₹) input & quick presets */}
                        <td className="py-2 px-2 whitespace-nowrap">
                          <div className="flex flex-col items-center gap-1">
                            <GuardInput
                              value={guard?.target ?? ''}
                              onCommit={(v) => onGuardChange && onGuardChange(leg.id, 'target', v)}
                              colorCls="text-emerald-300"
                              focusBorderCls="focus:border-emerald-500"
                            />
                            {/* Preset Chips */}
                            <div className="flex items-center gap-0.5 font-mono">
                              {GUARD_PRESET_PCTS.map((pct) => (
                                <button
                                  key={pct}
                                  type="button"
                                  disabled={leg.entryPrice <= 0}
                                  onClick={() => {
                                    if (leg.entryPrice <= 0 || !onGuardChange) return;
                                    const calculated = isLong
                                      ? leg.entryPrice * (1 + pct / 100)
                                      : leg.entryPrice * (1 - pct / 100);
                                    const snapped = (Math.round(calculated * 20) / 20).toFixed(2);
                                    if (calculated > 0) onGuardChange(leg.id, 'target', snapped);
                                  }}
                                  className="px-1 py-0.5 rounded bg-emerald-950/80 border border-emerald-800/60 text-emerald-400 hover:bg-emerald-800 hover:text-white transition-all disabled:opacity-30 cursor-pointer text-[9px] font-bold"
                                  title={`Set Target ${pct}% in profit from entry ₹${leg.entryPrice.toFixed(2)}`}
                                >
                                  +{pct}%
                                </button>
                              ))}
                            </div>
                            {/* Target P&L Subtext */}
                            {!isNaN(targetNum) && targetNum > 0 && leg.entryPrice > 0 && (() => {
                              const diff = isLong ? targetNum - leg.entryPrice : leg.entryPrice - targetNum;
                              const pctVal = (diff / leg.entryPrice) * 100;
                              const rupeeVal = diff * leg.qty;
                              const isProfit = diff >= 0;
                              return (
                                <span
                                  className={`text-[9px] font-mono tabular-nums whitespace-nowrap ${
                                    isProfit ? 'text-emerald-400' : 'text-red-400'
                                  }`}
                                >
                                  {isProfit ? '+' : ''}{pctVal.toFixed(1)}% ({isProfit ? '+' : ''}₹{Math.round(rupeeVal).toLocaleString('en-IN')})
                                </span>
                              );
                            })()}
                          </div>
                        </td>

                        {/* Stop Loss (₹) input & quick presets */}
                        <td className="py-2 px-2 whitespace-nowrap">
                          <div className="flex flex-col items-center gap-1">
                            <GuardInput
                              value={guard?.sl ?? ''}
                              onCommit={(v) => onGuardChange && onGuardChange(leg.id, 'sl', v)}
                              colorCls="text-red-300"
                              focusBorderCls="focus:border-red-500"
                            />
                            {/* Preset Chips */}
                            <div className="flex items-center gap-0.5 font-mono">
                              {GUARD_PRESET_PCTS.map((pct) => (
                                <button
                                  key={pct}
                                  type="button"
                                  disabled={leg.entryPrice <= 0}
                                  onClick={() => {
                                    if (leg.entryPrice <= 0 || !onGuardChange) return;
                                    const calculated = isLong
                                      ? leg.entryPrice * (1 - pct / 100)
                                      : leg.entryPrice * (1 + pct / 100);
                                    const snapped = (Math.round(calculated * 20) / 20).toFixed(2);
                                    if (calculated > 0) onGuardChange(leg.id, 'sl', snapped);
                                  }}
                                  className="px-1 py-0.5 rounded bg-red-950/80 border border-red-800/60 text-red-400 hover:bg-red-800 hover:text-white transition-all disabled:opacity-30 cursor-pointer text-[9px] font-bold"
                                  title={`Set SL ${pct}% in loss from entry ₹${leg.entryPrice.toFixed(2)}`}
                                >
                                  -{pct}%
                                </button>
                              ))}
                            </div>
                            {/* SL Loss Subtext */}
                            {!isNaN(slNum) && slNum > 0 && leg.entryPrice > 0 && (() => {
                              const diff = isLong ? leg.entryPrice - slNum : slNum - leg.entryPrice;
                              const pctVal = (diff / leg.entryPrice) * 100;
                              const rupeeVal = diff * leg.qty;
                              const isLoss = diff >= 0;
                              return (
                                <span
                                  className={`text-[9px] font-mono tabular-nums whitespace-nowrap ${
                                    isLoss ? 'text-red-400' : 'text-emerald-400'
                                  }`}
                                >
                                  {isLoss ? '-' : '+'}{pctVal.toFixed(1)}% ({isLoss ? '-' : '+'}₹{Math.round(Math.abs(rupeeVal)).toLocaleString('en-IN')})
                                </span>
                              );
                            })()}
                          </div>
                        </td>

                        {/* Trailing SL checkbox + effective SL price when active */}
                        <td className="py-2.5 px-2 text-center whitespace-nowrap">
                          <div className="flex flex-col items-center gap-0.5">
                            <input
                              type="checkbox"
                              checked={guard?.trailEnabled ?? false}
                              onChange={() => onTrailToggle && onTrailToggle(leg.id)}
                              disabled={!guard?.sl}
                              title={guard?.sl ? 'Trail SL 1:1 with profit' : 'Set Stop Loss first'}
                              className="w-4 h-4 accent-amber-400 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                            />
                            {effectiveTrailSL !== null && (
                              <span className="text-[10px] font-mono text-amber-400 font-bold tabular-nums">
                                @{effectiveTrailSL.toFixed(1)}
                              </span>
                            )}
                          </div>
                        </td>

                        {/* P&L */}
                        <td
                          className={`py-2.5 px-2 text-right font-bold tabular-nums ${
                            isPnlPositive ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {isPnlPositive ? '+' : ''}₹{Math.round(pnl).toLocaleString('en-IN')}
                        </td>

                        {/* Delta */}
                        <td className="py-2.5 px-2 text-right text-zinc-300 tabular-nums">
                          {leg.delta >= 0 ? '+' : ''}
                          {leg.delta.toFixed(2)}
                        </td>

                        {/* IV */}
                        <td className="py-2.5 px-2 text-right text-zinc-400 tabular-nums">
                          {(leg.iv * 100).toFixed(1)}%
                        </td>

                        {/* Actions (Dual Roll Up / Roll Down + Remove) */}
                        <td className="py-2.5 px-3 text-center whitespace-nowrap">
                          <div className="flex items-center justify-center gap-1">
                            {/* Single Leg Trade Button */}
                            {onOpenSingleLegTrade && (
                              <button
                                type="button"
                                onClick={() => onOpenSingleLegTrade(leg)}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold transition-colors cursor-pointer"
                                title={`Place Order for ${leg.side} ${leg.strike} ${leg.type} on DHAN`}
                              >
                                <Zap className="w-2.5 h-2.5 fill-current" />
                                <span>Trade</span>
                              </button>
                            )}

                            {/* Single Leg Close / Square Off Button */}
                            {onCloseSingleLeg && (leg.isEntered || guard?.triggered) && (
                              <button
                                type="button"
                                onClick={() => onCloseSingleLeg(leg)}
                                className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-rose-500/10 hover:bg-rose-500/20 text-rose-400 border border-rose-500/30 text-[10px] font-bold transition-colors cursor-pointer"
                                title={`Square Off ${leg.side} ${leg.strike} ${leg.type} on DHAN (opposite action: ${leg.side === 'BUY' ? 'SELL' : 'BUY'})`}
                              >
                                <span>Close</span>
                              </button>
                            )}

                            {/* Roll UP Button */}
                            <button
                              type="button"
                              onClick={() => onQuickShiftStrike(leg.id, 1)}
                              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              title={`Roll ${leg.type} UP (+${strikeStep} pts)`}
                            >
                              <span>Roll</span>
                              <span className="text-emerald-400">▲</span>
                            </button>

                            {/* Roll DOWN Button */}
                            <button
                              type="button"
                              onClick={() => onQuickShiftStrike(leg.id, -1)}
                              className="flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[10px] font-bold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
                              title={`Roll ${leg.type} DOWN (-${strikeStep} pts)`}
                            >
                              <span>Roll</span>
                              <span className="text-red-400">▼</span>
                            </button>

                            {/* Remove Leg Button */}
                            <button
                              type="button"
                              onClick={() => onRemoveLeg(leg.id)}
                              className="p-1 rounded text-zinc-400 hover:text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ml-0.5"
                              title="Remove Leg"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </TerminalPanel>

      {/* ── 3. PAYOFF / STRIKE CLEARANCE TERMINAL PANEL ───────────────────── */}
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
        <div className="p-3.5 flex flex-col gap-3">
          {/* 2D Recharts Payoff Chart */}
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={payoffPoints} margin={{ top: 28, right: 28, left: 14, bottom: 46 }}>
                {/* Diagonal hatch fills for the profit / loss zones */}
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
                  tickFormatter={(v) => Number(v).toLocaleString('en-IN')}
                />
                <YAxis
                  stroke="var(--chart-axis)"
                  fontSize={10}
                  tickLine={false}
                  width={62}
                  tickFormatter={(v) => Number(v).toLocaleString('en-IN')}
                  label={{
                    value: 'Profit / loss',
                    angle: -90,
                    position: 'insideLeft',
                    style: { fill: 'var(--chart-tick)', fontSize: 10, textAnchor: 'middle' },
                  }}
                />
                <Tooltip
                  content={<PayoffTooltip />}
                  cursor={{ stroke: 'var(--chart-tick)', strokeWidth: 1, strokeDasharray: '3 3' }}
                />
                {/* Profit / Loss background zones, carved by the expiry breakevens */}
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
                <ReferenceLine y={0} stroke="var(--chart-grid)" strokeWidth={1} />

                {/* 1SD Range Shading (Sensibull Parity: 68% probability zone) */}
                {sdLevels && (
                  <ReferenceArea
                    x1={sdLevels.exactLo1}
                    x2={sdLevels.exactHi1}
                    fill="var(--chart-tick)"
                    fillOpacity={0.04}
                  />
                )}

                {/* 1SD / 2SD expected-move bands, from the same lognormal model as POP */}
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

                {/* Short Put / Short Call strike markers. Deliberately unlabelled — the
                    strike-clearance banner directly below the chart names both strikes, and
                    in-chart text collides with the SD labels and the projected-P&L badge. */}
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

                {/* On Target Date (T+0): smooth Black-Scholes theoretical-price curve */}
                <Line
                  type="monotone"
                  dataKey="pnlToday"
                  stroke={PAYOFF_TODAY}
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, strokeWidth: 0 }}
                  name="On Target Date (T+0)"
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
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* ── INTERACTIVE TARGET SPOT & TARGET DATE CONTROLS (Sensibull Parity) ── */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
            {/* Left: Target Spot Slider */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-bold text-zinc-200">NIFTY Target</span>
                  <span className={`text-[11px] font-bold tabular-nums ${targetSpotChangePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                    {targetSpotChangePct >= 0 ? '+' : ''}{targetSpotChangePct.toFixed(1)}%
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="flex items-center border border-zinc-700 bg-zinc-900 rounded px-1 py-0.5">
                    <button
                      type="button"
                      onClick={() => onTargetSpotChange?.(Math.round((effectiveTargetSpot - strikeStep / 2) * 10) / 10)}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold"
                      title="Decrease target spot"
                    >
                      -
                    </button>
                    <span className="px-2 font-mono font-bold text-zinc-100 tabular-nums text-xs">
                      {effectiveTargetSpot.toFixed(1)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onTargetSpotChange?.(Math.round((effectiveTargetSpot + strikeStep / 2) * 10) / 10)}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold"
                      title="Increase target spot"
                    >
                      +
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => onTargetSpotChange?.(spot)}
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
                  onChange={(e) => onTargetSpotChange?.(parseFloat(e.target.value))}
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
                      onClick={() => onTargetDaysChange?.(Math.min(maxDays, effectiveTargetDays + 0.5))}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold"
                      title="Earlier date (more days to expiry)"
                    >
                      &lt;
                    </button>
                    <span className="px-2 font-mono font-medium text-zinc-200 tabular-nums text-xs">
                      {formatTargetDateDisplay(effectiveTargetDays, currentExpiry)}
                    </span>
                    <button
                      type="button"
                      onClick={() => onTargetDaysChange?.(Math.max(0.05, effectiveTargetDays - 0.5))}
                      className="px-1.5 py-0.5 text-zinc-400 hover:text-white hover:bg-zinc-800 rounded text-xs font-bold"
                      title="Later date (fewer days to expiry)"
                    >
                      &gt;
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => onTargetDaysChange?.(initialDays ?? 4.0)}
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
                  onChange={(e) => onTargetDaysChange?.(parseFloat(e.target.value))}
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

          {/* ── EXPECTED MOVE (SD) READOUT ─────────────────────────────────
              The chart's SD gridlines are just `spot x vol x sqrt(t)`, so they shift with
              the underlying's vol and the days left. Printing the levels AND the two inputs
              that produced them is what makes a band that looks off against another tool
              diagnosable at a glance instead of a mystery. */}
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
                <span className="text-zinc-300 font-bold tabular-nums">{(sdLevels.vol * 100).toFixed(1)}% IV</span>
                <span>over</span>
                <span className="text-zinc-300 font-bold tabular-nums">{sdLevels.days.toFixed(2)}d</span>
                <span>to expiry</span>
              </div>
            </div>
          )}
        </div>
      </TerminalPanel>
    </div>
  );
}

