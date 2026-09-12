'use client';

import React, { useMemo } from 'react';
import { OptionLegModel, PayoffPoint } from '@/lib/optionsMonitorMath';
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
  TrendingDown,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  Shield,
  ChevronsUp,
  ChevronsDown,
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
  onAddLegClick: () => void;
  onRemoveLeg: (id: string) => void;
  onUpdateLegStrike: (id: string, newStrike: number) => void;
  onQuickShiftStrike: (id: string, steps: number) => void;
  onSelectStrategyPreset: (presetId: string) => void;
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
  onAddLegClick,
  onRemoveLeg,
  onUpdateLegStrike,
  onQuickShiftStrike,
  onSelectStrategyPreset,
}: PositionsStrategyMonitorProps) {
  // Identify key strikes for clearance calculation
  const shortCeLeg = legs.find((l) => l.type === 'CE' && l.side === 'SELL');
  const shortPeLeg = legs.find((l) => l.type === 'PE' && l.side === 'SELL');

  const ceClearancePts = shortCeLeg ? Math.round(shortCeLeg.strike - spot) : null;
  const peClearancePts = shortPeLeg ? Math.round(spot - shortPeLeg.strike) : null;

  // Available strikes for dropdown (from spot - 15 steps to spot + 15 steps)
  const strikeOptions = useMemo(() => {
    const base = Math.round(spot / strikeStep) * strikeStep;
    const opts: number[] = [];
    for (let i = -16; i <= 16; i++) {
      opts.push(base + i * strikeStep);
    }
    return opts;
  }, [spot, strikeStep]);

  return (
    <div className="flex flex-col gap-4 font-mono select-none">
      {/* ── 1. STRATEGY TITLE & PRESET SELECTOR ───────────────────────────── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-3.5 shadow-md">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-zinc-800 pb-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold uppercase text-indigo-400 tracking-wider">
                POSITIONS & STRATEGY MONITOR
              </span>
              <span className="text-[10px] bg-zinc-800 text-zinc-400 px-2 py-0.5 rounded border border-zinc-700">
                {legs.length} ACTIVE {legs.length === 1 ? 'LEG' : 'LEGS'}
              </span>
            </div>
            <h2 className="text-base font-black text-white mt-0.5">
              {strategyName} (
              {legs.length === 2 && legs[0].lots === legs[1].lots
                ? `${legs[0].lots} Lots / ${legs[0].qty} Qty`
                : `${totalLots} Lots / ${totalQty} Qty`}
              )
            </h2>
          </div>

          {/* Quick Presets & Add Leg */}
          <div className="flex items-center gap-2 flex-wrap">
            <select
              onChange={(e) => {
                if (e.target.value) onSelectStrategyPreset(e.target.value);
              }}
              defaultValue=""
              className="bg-zinc-800 hover:bg-zinc-750 text-zinc-200 text-xs font-bold px-2.5 py-1.5 rounded-lg border border-zinc-700 cursor-pointer focus:outline-none"
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
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold text-xs shadow transition-colors cursor-pointer"
              title="Add Custom Strike Leg [A]"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>ADD LEG</span>
              <span className="text-[9px] bg-indigo-700 px-1 rounded text-indigo-200">[A]</span>
            </button>
          </div>
        </div>

        {/* ── 2. ACTIVE LEGS TABLE ────────────────────────────────────────── */}
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-zinc-800 text-white font-bold text-xs">
                <th className="py-2 px-3 rounded-l">LEG</th>
                <th className="py-2 px-2">STRIKE (SELECT ANY)</th>
                <th className="py-2 px-2 text-right">LTP</th>
                <th className="py-2 px-2 text-right">ENTRY</th>
                <th className="py-2 px-2 text-right">P&L</th>
                <th className="py-2 px-2 text-right">DELTA</th>
                <th className="py-2 px-2 text-right">IV</th>
                <th className="py-2 px-3 text-center rounded-r">ACTIONS</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {legs.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-8 text-center text-zinc-500 italic">
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

                  return (
                    <tr key={leg.id} className="hover:bg-zinc-850/60 transition-colors">
                      {/* Leg Type Badge */}
                      <td className="py-2.5 px-3">
                        <span
                          className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-black tracking-wide border ${
                            isSell
                              ? isCall
                                ? 'bg-rose-950/60 text-rose-300 border-rose-600/40'
                                : 'bg-amber-950/60 text-amber-300 border-amber-600/40'
                              : isCall
                              ? 'bg-sky-950/60 text-sky-300 border-sky-600/40'
                              : 'bg-emerald-950/60 text-emerald-300 border-emerald-600/40'
                          }`}
                        >
                          {leg.side} {leg.type}
                        </span>
                        <span className="text-[10px] text-zinc-400 ml-1.5">
                          ({leg.lots}L)
                        </span>
                      </td>

                      {/* Interactive Strike Picker & Quick Shift Buttons */}
                      <td className="py-2.5 px-2">
                        <div className="flex items-center gap-1">
                          <select
                            value={leg.strike}
                            onChange={(e) => onUpdateLegStrike(leg.id, Number(e.target.value))}
                            className="bg-zinc-950 text-white font-bold px-2 py-1 rounded border border-zinc-700 text-xs cursor-pointer focus:outline-none focus:border-indigo-500"
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
                              className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer text-[10px]"
                              title={`Shift down by ${strikeStep} pts`}
                            >
                              -{strikeStep}
                            </button>
                            <button
                              onClick={() => onQuickShiftStrike(leg.id, 1)}
                              className="p-1 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white transition-colors cursor-pointer text-[10px]"
                              title={`Shift up by ${strikeStep} pts`}
                            >
                              +{strikeStep}
                            </button>
                          </div>
                        </div>
                      </td>

                      {/* LTP */}
                      <td className="py-2.5 px-2 text-right font-bold text-white">
                        ₹{leg.ltp.toFixed(1)}
                      </td>

                      {/* Entry Price */}
                      <td className="py-2.5 px-2 text-right text-zinc-300">
                        ₹{leg.entryPrice.toFixed(1)}
                      </td>

                      {/* P&L */}
                      <td
                        className={`py-2.5 px-2 text-right font-black ${
                          isPnlPositive ? 'text-emerald-400' : 'text-rose-400'
                        }`}
                      >
                        {isPnlPositive ? '+' : ''}₹{Math.round(pnl).toLocaleString('en-IN')}
                      </td>

                      {/* Delta */}
                      <td className="py-2.5 px-2 text-right text-zinc-300">
                        {leg.delta >= 0 ? '+' : ''}
                        {leg.delta.toFixed(2)}
                      </td>

                      {/* IV */}
                      <td className="py-2.5 px-2 text-right text-zinc-400">
                        {(leg.iv * 100).toFixed(1)}%
                      </td>

                      {/* Actions (Roll / Remove) */}
                      <td className="py-2.5 px-3 text-center">
                        <div className="flex items-center justify-center gap-1.5">
                          <button
                            onClick={() => onQuickShiftStrike(leg.id, isCall ? 1 : -1)}
                            className="px-2 py-0.5 rounded bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 text-[10px] font-bold transition-colors cursor-pointer"
                            title={isCall ? 'Roll CE up (further OTM)' : 'Roll PE down (further OTM)'}
                          >
                            Roll {isCall ? '▲' : '▼'}
                          </button>
                          <button
                            onClick={() => onRemoveLeg(leg.id)}
                            className="p-1 rounded text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition-colors cursor-pointer"
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

      {/* ── 3. PAYOFF / STRIKE CLEARANCE GRAPH ────────────────────────────── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-3.5 shadow-md flex flex-col gap-3">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
          <div className="flex items-center gap-2">
            <TrendingUp className="w-4 h-4 text-emerald-400" />
            <span className="text-xs font-bold text-white uppercase tracking-wider">
              PAYOFF & STRIKE CLEARANCE GRAPH
            </span>
          </div>

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
        </div>

        {/* 2D Recharts Payoff Chart */}
        <div className="h-60 w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={payoffPoints} margin={{ top: 10, right: 20, left: 0, bottom: 0 }}>
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
                contentStyle={{
                  backgroundColor: 'rgba(9, 9, 11, 0.95)',
                  borderColor: '#3f3f46',
                  borderRadius: '0.75rem',
                  fontSize: '11px',
                  fontFamily: 'monospace',
                  color: '#f4f4f5',
                }}
                formatter={(val: any) => [`₹${Number(val).toLocaleString('en-IN')}`, '']}
                labelFormatter={(label) => `Spot Price: ${label}`}
              />
              {/* Zero P&L Line */}
              <ReferenceLine y={0} stroke="#52525b" strokeWidth={1} />

              {/* NIFTY Spot Marker Line */}
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
                  stroke="#f43f5e"
                  strokeDasharray="3 3"
                  label={{
                    value: `PE ${shortPeLeg.strike}`,
                    fill: '#f43f5e',
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
                    position: 'bottom',
                  }}
                />
              ))}

              <Line
                type="monotone"
                dataKey="pnlToday"
                stroke="#fbbf24"
                strokeWidth={1.5}
                dot={false}
                strokeDasharray="3 3"
                name="Today (T+0)"
              />
              <Line
                type="monotone"
                dataKey="pnlExpiry"
                stroke="#38bdf8"
                strokeWidth={2}
                dot={false}
                name="At Expiry"
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* ── STRIKE CLEARANCE & BREAKEVEN BANNER ──────────────────────────── */}
        {/* Exactly matches diagram: PE Strike: 24650 (-162 pts) | CE Strike: 24950 (+138 pts) */}
        <div className="flex flex-wrap items-center justify-between gap-2 p-2.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs">
          <div className="flex items-center gap-4 flex-wrap">
            {/* PE Clearance */}
            <div className="flex items-center gap-1.5">
              <span className="text-zinc-400 font-semibold">PE Strike:</span>
              <span className="font-bold text-white">
                {shortPeLeg ? shortPeLeg.strike : 'None'}
              </span>
              {peClearancePts !== null && (
                <span
                  className={`font-black px-1.5 py-0.2 rounded text-[11px] ${
                    peClearancePts > 100
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : peClearancePts > 50
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-rose-500/20 text-rose-400 animate-pulse'
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
                  className={`font-black px-1.5 py-0.2 rounded text-[11px] ${
                    ceClearancePts > 100
                      ? 'bg-emerald-500/20 text-emerald-400'
                      : ceClearancePts > 50
                      ? 'bg-amber-500/20 text-amber-400'
                      : 'bg-rose-500/20 text-rose-400 animate-pulse'
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
              <span className="text-[10px] text-indigo-400 font-bold">
                ({breakevens[1] - breakevens[0]} pts width)
              </span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
