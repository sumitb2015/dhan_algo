'use client';

import React from 'react';
import { PortfolioGreeks } from '@/lib/optionsMonitorMath';
import {
  Zap,
  RotateCw,
  Shield,
  Scissors,
  LogOut,
  AlertTriangle,
  Info,
  CheckCircle2,
  Activity,
} from 'lucide-react';

interface RiskGreeksMatrixProps {
  greeks: PortfolioGreeks;
  lastActionMessage: string | null;
  onRollCe: () => void;
  onRollPe: () => void;
  onDeltaHedge: () => void;
  onAddWings: () => void;
  onTrim50: () => void;
  onFlatten: () => void;
}

export default function RiskGreeksMatrix({
  greeks,
  lastActionMessage,
  onRollCe,
  onRollPe,
  onDeltaHedge,
  onAddWings,
  onTrim50,
  onFlatten,
}: RiskGreeksMatrixProps) {
  const isRupeeDeltaPositive = greeks.rupeeDelta >= 0;

  return (
    <div className="flex flex-col gap-4 font-mono select-none">
      {/* ── 1. RISK & GREEKS MATRIX ───────────────────────────────────────── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-3.5 shadow-md flex flex-col gap-3">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-indigo-400" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">
              RISK & GREEKS MATRIX
            </h3>
          </div>
          <span className="text-[10px] text-zinc-400">INSTITUTIONAL METRICS</span>
        </div>

        {/* Greeks Table matching diagram */}
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="bg-zinc-800 text-white font-bold text-xs">
                <th className="py-2 px-3 rounded-l">GREEK</th>
                <th className="py-2 px-2">VALUE</th>
                <th className="py-2 px-3 text-right rounded-r">IMPACT / RISK</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80">
              {/* Net Delta */}
              <tr className="hover:bg-zinc-850/50 transition-colors">
                <td className="py-2.5 px-3 font-semibold text-zinc-300 flex items-center gap-1.5">
                  <span className="text-indigo-400 font-bold">Δ</span>
                  <span>Net Delta</span>
                </td>
                <td className="py-2.5 px-2 font-bold text-white">
                  {greeks.netDelta >= 0 ? '+' : ''}
                  {greeks.netDelta.toFixed(2)} Δ
                </td>
                <td
                  className={`py-2.5 px-3 text-right font-bold ${
                    isRupeeDeltaPositive ? 'text-emerald-400' : 'text-rose-400'
                  }`}
                >
                  {isRupeeDeltaPositive ? '+' : ''}₹{(greeks.rupeeDelta / 1000).toFixed(2)}k / 1% move
                </td>
              </tr>

              {/* Gamma */}
              <tr className="hover:bg-zinc-850/50 transition-colors">
                <td className="py-2.5 px-3 font-semibold text-zinc-300 flex items-center gap-1.5">
                  <span className="text-amber-400 font-bold">Γ</span>
                  <span>Gamma (Γ)</span>
                </td>
                <td className="py-2.5 px-2 font-bold text-white">
                  {greeks.netGamma.toFixed(4)}
                </td>
                <td className="py-2.5 px-3 text-right">
                  <span
                    className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-bold ${
                      greeks.gammaRiskLabel === 'High Acceleration'
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-600/40'
                        : greeks.gammaRiskLabel === 'Moderate'
                        ? 'bg-amber-500/20 text-amber-300 border border-amber-600/40'
                        : 'bg-emerald-500/20 text-emerald-300 border border-emerald-600/40'
                    }`}
                  >
                    {greeks.gammaRiskLabel}
                  </span>
                </td>
              </tr>

              {/* Theta */}
              <tr className="hover:bg-zinc-850/50 transition-colors">
                <td className="py-2.5 px-3 font-semibold text-zinc-300 flex items-center gap-1.5">
                  <span className="text-emerald-400 font-bold">Θ</span>
                  <span>Theta (Θ)</span>
                </td>
                <td className="py-2.5 px-2 font-bold text-emerald-400">
                  {greeks.netTheta >= 0 ? '+' : ''}₹{greeks.netTheta.toLocaleString('en-IN')}/day
                </td>
                <td className="py-2.5 px-3 text-right font-bold text-emerald-300">
                  +{greeks.thetaPerHour >= 0 ? '₹' : '-₹'}
                  {Math.abs(greeks.thetaPerHour).toLocaleString('en-IN')}/hr decay
                </td>
              </tr>

              {/* Vega */}
              <tr className="hover:bg-zinc-850/50 transition-colors">
                <td className="py-2.5 px-3 font-semibold text-zinc-300 flex items-center gap-1.5">
                  <span className="text-cyan-400 font-bold">V</span>
                  <span>Vega (V)</span>
                </td>
                <td className="py-2.5 px-2 font-bold text-zinc-200">
                  {greeks.netVega >= 0 ? '+' : ''}₹{greeks.netVega.toLocaleString('en-IN')}
                </td>
                <td className="py-2.5 px-3 text-right text-zinc-400">
                  per +1.0% VIX
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Supplementary Risk Stats Bar */}
        <div className="grid grid-cols-2 gap-2 pt-2 border-t border-zinc-800 text-xs">
          <div className="p-2 rounded bg-zinc-950 border border-zinc-800">
            <span className="text-[10px] text-zinc-400 uppercase block">MAX PROFIT</span>
            <span className="font-black text-emerald-400">
              {typeof greeks.maxProfit === 'number'
                ? `₹${greeks.maxProfit.toLocaleString('en-IN')}`
                : greeks.maxProfit}
            </span>
          </div>

          <div className="p-2 rounded bg-zinc-950 border border-zinc-800">
            <span className="text-[10px] text-zinc-400 uppercase block">PROBABILITY OF PROFIT</span>
            <span className="font-black text-indigo-300">{greeks.popPct}% POP</span>
          </div>
        </div>
      </div>

      {/* ── 2. QUICK EXECUTION & ADJUSTMENT BAR ───────────────────────────── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-900/90 p-3.5 shadow-md flex flex-col gap-3">
        <div className="flex items-center justify-between border-b border-zinc-800 pb-2">
          <div className="flex items-center gap-2">
            <Zap className="w-4 h-4 text-amber-400" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">
              QUICK EXECUTION & ADJUSTMENT BAR
            </h3>
          </div>
          <span className="text-[10px] text-amber-400 font-bold">KEYBOARD ACTIVE</span>
        </div>

        {/* Action Grid matching the diagram */}
        <div className="grid grid-cols-2 gap-2">
          {/* Roll CE (C) */}
          <button
            onClick={onRollCe}
            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-750 hover:bg-zinc-800 hover:border-zinc-600 text-zinc-100 font-bold text-xs transition-all cursor-pointer shadow-sm group"
            title="Roll Short Call Strike further OTM [Hotkey: C]"
          >
            <div className="flex items-center gap-1.5">
              <RotateCw className="w-3.5 h-3.5 text-sky-400 group-hover:rotate-45 transition-transform" />
              <span>Roll CE</span>
            </div>
            <span className="text-[10px] bg-zinc-800 group-hover:bg-zinc-700 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300">
              C
            </span>
          </button>

          {/* Roll PE (P) */}
          <button
            onClick={onRollPe}
            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-750 hover:bg-zinc-800 hover:border-zinc-600 text-zinc-100 font-bold text-xs transition-all cursor-pointer shadow-sm group"
            title="Roll Short Put Strike further OTM [Hotkey: P]"
          >
            <div className="flex items-center gap-1.5">
              <RotateCw className="w-3.5 h-3.5 text-amber-400 group-hover:-rotate-45 transition-transform" />
              <span>Roll PE</span>
            </div>
            <span className="text-[10px] bg-zinc-800 group-hover:bg-zinc-700 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300">
              P
            </span>
          </button>

          {/* Delta Hedge (H) */}
          <button
            onClick={onDeltaHedge}
            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-indigo-950/40 border border-indigo-500/50 hover:bg-indigo-900/60 text-indigo-200 font-bold text-xs transition-all cursor-pointer shadow-sm group"
            title="Neutralize portfolio delta skew [Hotkey: H]"
          >
            <div className="flex items-center gap-1.5">
              <Zap className="w-3.5 h-3.5 text-indigo-400" />
              <span>Delta Hedge</span>
            </div>
            <span className="text-[10px] bg-indigo-900 px-1.5 py-0.5 rounded border border-indigo-700 text-indigo-200">
              H
            </span>
          </button>

          {/* Add Wings (W) */}
          <button
            onClick={onAddWings}
            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-emerald-950/40 border border-emerald-500/50 hover:bg-emerald-900/60 text-emerald-200 font-bold text-xs transition-all cursor-pointer shadow-sm group"
            title="Add protective OTM wings to convert to Iron Condor [Hotkey: W]"
          >
            <div className="flex items-center gap-1.5">
              <Shield className="w-3.5 h-3.5 text-emerald-400" />
              <span>Add Wings</span>
            </div>
            <span className="text-[10px] bg-emerald-900 px-1.5 py-0.5 rounded border border-emerald-700 text-emerald-200">
              W
            </span>
          </button>

          {/* Trim 50% (X) */}
          <button
            onClick={onTrim50}
            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-750 hover:bg-zinc-800 hover:border-zinc-600 text-zinc-100 font-bold text-xs transition-all cursor-pointer shadow-sm group"
            title="Trim 50% of position size [Hotkey: X]"
          >
            <div className="flex items-center gap-1.5">
              <Scissors className="w-3.5 h-3.5 text-amber-400" />
              <span>Trim 50%</span>
            </div>
            <span className="text-[10px] bg-zinc-800 group-hover:bg-zinc-700 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300">
              X
            </span>
          </button>

          {/* FLATTEN (ESC) */}
          <button
            onClick={onFlatten}
            className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-rose-950/70 border border-rose-600 hover:bg-rose-900 text-rose-100 font-black text-xs transition-all cursor-pointer shadow-md group"
            title="Square Off All Open Legs [Hotkey: Escape]"
          >
            <div className="flex items-center gap-1.5">
              <LogOut className="w-3.5 h-3.5 text-rose-400" />
              <span>FLATTEN</span>
            </div>
            <span className="text-[10px] bg-rose-900 px-1.5 py-0.5 rounded border border-rose-500 text-rose-200">
              ESC
            </span>
          </button>
        </div>

        {/* Action Feedback Banner */}
        {lastActionMessage && (
          <div className="mt-1 p-2 rounded-lg bg-zinc-950 border border-indigo-500/40 text-indigo-300 text-xs flex items-center gap-2 animate-in fade-in duration-200">
            <CheckCircle2 className="w-4 h-4 text-indigo-400 shrink-0" />
            <span className="truncate">{lastActionMessage}</span>
          </div>
        )}
      </div>
    </div>
  );
}
