'use client';

import React, { useMemo, useState, useRef } from 'react';
import { OptionLegModel, PayoffPoint, PositionGuard, formatShortExpiry } from '@/lib/optionsMonitorMath';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
  ReferenceLine,
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

interface PositionsStrategyMonitorProps {
  strategyName: string;
  totalLots: number;
  totalQty: number;
  legs: OptionLegModel[];
  spot: number;
  strikeStep: number;
  payoffPoints: PayoffPoint[];
  breakevens: number[];
  chainStrikes?: number[];
  currentExpiry?: string;
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

function TerminalPanel({
  title,
  icon: Icon,
  meta,
  badge,
  children,
  className = '',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-3.5 py-2.5">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400">
            <Icon className="h-3.5 w-3.5 text-amber-400" />
            {title}
          </span>
          {badge}
        </div>
        {meta ? <div className="font-mono text-[11px] text-zinc-400">{meta}</div> : null}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
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
            <span className="flex items-center gap-1.5 text-amber-400 font-semibold">
              <span className="w-2.5 h-0.5 bg-amber-400 inline-block border-t border-dashed" />
              Today (T+0):
            </span>
            <span className={`font-bold ${todayVal >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
              {todayVal >= 0 ? '+' : ''}₹{Math.round(todayVal).toLocaleString('en-IN')}
            </span>
          </div>
        )}

        {expVal != null && (
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-1.5 text-sky-400 font-semibold">
              <span className="w-2.5 h-0.5 bg-sky-400 inline-block" />
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
  chainStrikes,
  currentExpiry,
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
            <span className="flex items-center gap-1.5 text-sky-400 font-semibold">
              <span className="w-2.5 h-0.5 bg-sky-400 inline-block" />
              Payoff at Expiry
            </span>
            <span className="flex items-center gap-1.5 text-amber-400 font-semibold">
              <span className="w-2.5 h-0.5 bg-amber-400 inline-block border-t border-dashed" />
              Today (T+0)
            </span>
          </div>
        }
      >
        <div className="p-3.5 flex flex-col gap-3">
          {/* 2D Recharts Payoff Chart */}
          <div className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={payoffPoints} margin={{ top: 16, right: 24, left: 6, bottom: 16 }}>
                <CartesianGrid strokeDasharray="3 6" stroke="var(--chart-grid)" vertical={false} />
                <XAxis
                  dataKey="spot"
                  stroke="var(--chart-axis)"
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={(v) => `${v}`}
                />
                <YAxis
                  stroke="var(--chart-axis)"
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={(v) => `₹${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  content={<PayoffTooltip />}
                  cursor={{ stroke: 'var(--chart-axis)', strokeWidth: 1, strokeDasharray: '3 3' }}
                />
                {/* Zero P&L Line */}
                <ReferenceLine y={0} stroke="var(--chart-grid)" strokeWidth={1} />

                {/* Underlying Spot Marker Line */}
                <ReferenceLine
                  x={Math.round(spot)}
                  stroke="#facc15"
                  strokeWidth={1.5}
                  strokeDasharray="2 2"
                  label={{
                    value: `Spot: ${Math.round(spot)}`,
                    fill: '#facc15',
                    fontSize: 10,
                    position: 'top',
                  }}
                />

                {/* Short Call Strike Line */}
                {shortCeLeg && (
                  <ReferenceLine
                    x={shortCeLeg.strike}
                    stroke="#38bdf8"
                    strokeDasharray="3 3"
                    label={{
                      value: `CE ${shortCeLeg.strike}`,
                      fill: '#38bdf8',
                      fontSize: 10,
                      position: 'insideTopRight',
                    }}
                  />
                )}

                {/* Short Put Strike Line */}
                {shortPeLeg && (
                  <ReferenceLine
                    x={shortPeLeg.strike}
                    stroke="#f87171"
                    strokeDasharray="3 3"
                    label={{
                      value: `PE ${shortPeLeg.strike}`,
                      fill: '#f87171',
                      fontSize: 10,
                      position: 'insideTopLeft',
                    }}
                  />
                )}

                {/* Breakeven lines */}
                {breakevens.map((be) => (
                  <ReferenceLine
                    key={be}
                    x={be}
                    stroke="#34d399"
                    strokeDasharray="2 4"
                    label={{
                      value: `BE ${be}`,
                      fill: '#34d399',
                      fontSize: 9,
                      position: 'insideBottom',
                    }}
                  />
                ))}

                {/* Today (T+0): Smooth Gaussian BS curve */}
                <Line
                  type="monotone"
                  dataKey="pnlToday"
                  stroke="#fbbf24"
                  strokeWidth={1.8}
                  dot={false}
                  strokeDasharray="3 3"
                  name="Today (T+0)"
                />
                {/* At Expiry: Exact piecewise-linear intrinsic payoff with crisp strike corners */}
                <Line
                  type="linear"
                  dataKey="pnlExpiry"
                  stroke="#38bdf8"
                  strokeWidth={2.2}
                  dot={false}
                  name="At Expiry"
                />
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* ── STRIKE CLEARANCE & BREAKEVEN BANNER ────────────────────────── */}
          <div className="flex flex-wrap items-center justify-between gap-2 p-3 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
            <div className="flex items-center gap-4 flex-wrap">
              {/* PE Clearance */}
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 font-semibold">PE Strike:</span>
                <span className="font-bold text-white">
                  {shortPeLeg ? shortPeLeg.strike : 'None'}
                </span>
                {peClearancePts !== null && (
                  <span
                    className={`font-bold px-1.5 py-0.5 rounded text-[11px] ${
                      peClearancePts > 100
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : peClearancePts > 50
                        ? 'bg-amber-500/20 text-amber-400'
                        : 'bg-red-500/20 text-red-400 animate-pulse'
                    }`}
                  >
                    -{peClearancePts} pts
                  </span>
                )}
              </div>

              {/* CE Clearance */}
              <div className="flex items-center gap-1.5">
                <span className="text-zinc-400 font-semibold">CE Strike:</span>
                <span className="font-bold text-white">
                  {shortCeLeg ? shortCeLeg.strike : 'None'}
                </span>
                {ceClearancePts !== null && (
                  <span
                    className={`font-bold px-1.5 py-0.5 rounded text-[11px] ${
                      ceClearancePts > 100
                        ? 'bg-emerald-500/20 text-emerald-400'
                        : ceClearancePts > 50
                        ? 'bg-amber-500/20 text-amber-400'
                        : 'bg-red-500/20 text-red-400 animate-pulse'
                    }`}
                  >
                    +{ceClearancePts} pts
                  </span>
                )}
              </div>
            </div>

            {/* Breakeven Range */}
            {breakevens.length >= 2 && (
              <div className="flex items-center gap-1.5 text-zinc-400">
                <span>BE Corridor:</span>
                <span className="text-zinc-200 font-bold">
                  {breakevens[0]} &mdash; {breakevens[1]}
                </span>
                <span className="text-[10px] text-amber-400 font-bold">
                  ({breakevens[1] - breakevens[0]} pts width)
                </span>
              </div>
            )}
          </div>
        </div>
      </TerminalPanel>
    </div>
  );
}

