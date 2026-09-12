'use client';

import React, { useMemo } from 'react';
import { OptionLegModel, PayoffPoint, formatShortExpiry } from '@/lib/optionsMonitorMath';
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
  Layers,
  Activity,
  SlidersHorizontal,
} from 'lucide-react';

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
  viewMode?: 'broker' | 'custom';
  currentExpiry?: string;
  onSyncBroker?: () => void;
  isBrokerLoading?: boolean;
  onAddLegClick: () => void;
  onRemoveLeg: (id: string) => void;
  onUpdateLegStrike: (id: string, newStrike: number) => void;
  onQuickShiftStrike: (id: string, steps: number) => void;
  onSelectStrategyPreset: (presetId: string) => void;
  onUpdateLegLots?: (id: string, deltaLots: number) => void;
  onUpdateAllLots?: (deltaLots: number) => void;
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
  viewMode = 'custom',
  currentExpiry,
  onSyncBroker,
  isBrokerLoading = false,
  onAddLegClick,
  onRemoveLeg,
  onUpdateLegStrike,
  onQuickShiftStrike,
  onSelectStrategyPreset,
  onUpdateLegLots,
  onUpdateAllLots,
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

  return (
    <div className="flex flex-col gap-4 font-mono select-none">
      {/* ── 1. STRATEGY & POSITIONS TERMINAL PANEL ─────────────────────────── */}
      <TerminalPanel
        title="POSITIONS & STRATEGY MONITOR"
        icon={Activity}
        badge={
          <div className="flex items-center gap-1.5 ml-2">
            <span
              className={`text-[10px] px-2 py-0.5 rounded border font-bold ${
                viewMode === 'broker'
                  ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                  : 'bg-zinc-800 text-zinc-300 border-zinc-700'
              }`}
            >
              {viewMode === 'broker' ? 'LIVE BROKER' : 'DESK WHAT-IF'}
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
                disabled={viewMode === 'broker' || totalLots <= legs.length || legs.length === 0}
                className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700 text-xs font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Decrease all legs by 1 lot"
              >
                -
              </button>
              <span className="font-mono text-xs font-bold text-amber-400 min-w-[28px] text-center tabular-nums">
                {legs.length === 2 && legs[0].lots === legs[1].lots
                  ? `${legs[0].lots}L`
                  : `${totalLots}L`}
              </span>
              <button
                type="button"
                onClick={() => onUpdateAllLots && onUpdateAllLots(1)}
                disabled={viewMode === 'broker' || legs.length === 0}
                className="w-5 h-5 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white border border-zinc-700 text-xs font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                title="Increase all legs by 1 lot"
              >
                +
              </button>
              <span className="text-zinc-500 text-[10px] ml-0.5">({totalQty} Qty)</span>
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

            {/* Quick Presets & Add Leg / Sync Broker */}
            <div className="flex items-center gap-2 flex-wrap">
              {viewMode === 'broker' ? (
                <button
                  onClick={onSyncBroker}
                  disabled={isBrokerLoading}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow transition-colors cursor-pointer"
                  title="Sync Live Positions from Dhan"
                >
                  <Layers className={`w-3.5 h-3.5 ${isBrokerLoading ? 'animate-spin' : ''}`} />
                  <span>SYNC BROKER</span>
                </button>
              ) : (
                <>
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
                    onClick={onAddLegClick}
                    className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-400 hover:bg-amber-500/20 font-bold text-xs transition-colors cursor-pointer"
                    title="Add Custom Strike Leg [A]"
                  >
                    <Plus className="w-3.5 h-3.5 text-amber-400" />
                    <span>ADD LEG</span>
                    <span className="text-[9px] bg-amber-500/20 px-1 rounded text-amber-300">[A]</span>
                  </button>
                </>
              )}
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
                  <th className="py-2.5 px-2">STRIKE (SELECT ANY)</th>
                  <th className="py-2.5 px-2 text-right">LTP</th>
                  <th className="py-2.5 px-2 text-right">ENTRY</th>
                  <th className="py-2.5 px-2 text-right">P&L</th>
                  <th className="py-2.5 px-2 text-right">DELTA</th>
                  <th className="py-2.5 px-2 text-right">IV</th>
                  <th className="py-2.5 px-3 text-center rounded-r">ACTIONS</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {legs.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="py-8 text-center text-zinc-500 italic">
                      No active option legs. Click &quot;ADD LEG&quot; or select a preset template above.
                    </td>
                  </tr>
                ) : (
                  legs.map((leg) => {
                    const isSell = leg.side === 'SELL';
                    const isCall = leg.type === 'CE';
                    const pnl = isSell
                      ? (leg.entryPrice - leg.ltp) * leg.qty
                      : (leg.ltp - leg.entryPrice) * leg.qty;
                    const isPnlPositive = pnl >= 0;
                    const shortExp = formatShortExpiry(leg.expiry || currentExpiry);

                    return (
                      <tr key={leg.id} className="hover:bg-zinc-800/40 transition-colors">
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
                              disabled={viewMode === 'broker' || leg.lots <= 1}
                              className="w-4 h-4 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[10px] font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
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
                              disabled={viewMode === 'broker'}
                              className="w-4 h-4 flex items-center justify-center rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[10px] font-bold cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                              title="Increase 1 lot"
                            >
                              +
                            </button>
                            <span className="text-[10px] text-zinc-500 font-mono ml-0.5">
                              ({leg.qty}Q)
                            </span>
                          </div>
                        </td>

                        {/* Interactive Strike Picker & Quick Shift Buttons */}
                        <td className="py-2.5 px-2 whitespace-nowrap">
                          <div className="flex items-center gap-1">
                            <select
                              value={leg.strike}
                              onChange={(e) => onUpdateLegStrike(leg.id, Number(e.target.value))}
                              disabled={viewMode === 'broker'}
                              className="bg-zinc-950 text-white font-bold px-2 py-1 rounded border border-zinc-700 text-xs cursor-pointer focus:outline-none focus:border-amber-500/60 disabled:opacity-50"
                            >
                              {strikeOptions.map((s) => (
                                <option key={s} value={s}>
                                  {s} {s === Math.round(spot / strikeStep) * strikeStep ? '(ATM)' : ''}
                                </option>
                              ))}
                            </select>

                            {/* Quick Shift Strike Buttons */}
                            <div className="flex items-center gap-0.5">
                              <button
                                onClick={() => onQuickShiftStrike(leg.id, -1)}
                                disabled={viewMode === 'broker'}
                                className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer text-[10px] disabled:opacity-40"
                                title={`Shift down by ${strikeStep} pts`}
                              >
                                -{strikeStep}
                              </button>
                              <button
                                onClick={() => onQuickShiftStrike(leg.id, 1)}
                                disabled={viewMode === 'broker'}
                                className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer text-[10px] disabled:opacity-40"
                                title={`Shift up by ${strikeStep} pts`}
                              >
                                +{strikeStep}
                              </button>
                            </div>
                          </div>
                        </td>

                        {/* LTP */}
                        <td className="py-2.5 px-2 text-right font-bold text-white tabular-nums">
                          ₹{leg.ltp.toFixed(1)}
                        </td>

                        {/* Entry Price */}
                        <td className="py-2.5 px-2 text-right text-zinc-300 tabular-nums">
                          ₹{leg.entryPrice.toFixed(1)}
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
                            {/* Roll UP Button */}
                            <button
                              type="button"
                              onClick={() => onQuickShiftStrike(leg.id, 1)}
                              disabled={viewMode === 'broker'}
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
                              disabled={viewMode === 'broker'}
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
                              disabled={viewMode === 'broker'}
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
                <CartesianGrid strokeDasharray="3 6" stroke="#27272a" vertical={false} />
                <XAxis
                  dataKey="spot"
                  stroke="#71717a"
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={(v) => `${v}`}
                />
                <YAxis
                  stroke="#71717a"
                  fontSize={10}
                  tickLine={false}
                  tickFormatter={(v) => `₹${Math.round(v / 1000)}k`}
                />
                <Tooltip
                  content={<PayoffTooltip />}
                  cursor={{ stroke: '#52525b', strokeWidth: 1, strokeDasharray: '3 3' }}
                />
                {/* Zero P&L Line */}
                <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />

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

