'use client';

import React from 'react';
import { PortfolioGreeks } from '@/lib/optionsMonitorMath';
import {
  Zap,
  RotateCw,
  Shield,
  Scissors,
  LogOut,
  CheckCircle2,
  Activity,
} from 'lucide-react';

interface RiskGreeksMatrixProps {
  greeks: PortfolioGreeks;
  lastActionMessage: string | null;
  onRollCe?: () => void;
  onRollPe?: () => void;
  onRollCeUp?: () => void;
  onRollCeDown?: () => void;
  onRollPeUp?: () => void;
  onRollPeDown?: () => void;
  onDeltaHedge: () => void;
  onAddWings: () => void;
  onTrim50: () => void;
  onFlatten: () => void;
}

function TerminalPanel({
  title,
  icon: Icon,
  meta,
  children,
  className = '',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  meta?: React.ReactNode;
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
        </div>
        {meta ? <div className="font-mono text-[11px] text-zinc-400">{meta}</div> : null}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

export default function RiskGreeksMatrix({
  greeks,
  lastActionMessage,
  onRollCe,
  onRollPe,
  onRollCeUp,
  onRollCeDown,
  onRollPeUp,
  onRollPeDown,
  onDeltaHedge,
  onAddWings,
  onTrim50,
  onFlatten,
}: RiskGreeksMatrixProps) {
  const isRupeeDeltaPositive = greeks.rupeeDelta >= 0;

  return (
    <div className="flex flex-col gap-4 font-mono select-none">
      {/* ── 1. RISK & GREEKS MATRIX TERMINAL PANEL ───────────────────────── */}
      <TerminalPanel
        title="RISK & GREEKS MATRIX"
        icon={Activity}
        meta={<span>INSTITUTIONAL METRICS</span>}
      >
        <div className="p-3.5 flex flex-col gap-3">
          {/* Greeks Table matching diagram */}
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-zinc-800 text-white font-bold text-xs">
                  <th className="py-2.5 px-3 rounded-l">GREEK</th>
                  <th className="py-2.5 px-2">VALUE</th>
                  <th className="py-2.5 px-3 text-right rounded-r">IMPACT / RISK</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/80">
                {/* Net Delta */}
                <tr className="hover:bg-zinc-800/40 transition-colors">
                  <td className="py-2.5 px-3 font-semibold text-zinc-300 flex items-center gap-1.5">
                    <span className="text-amber-400 font-bold">Δ</span>
                    <span>Net Delta</span>
                  </td>
                  <td className="py-2.5 px-2 font-bold text-white tabular-nums">
                    {greeks.netDelta >= 0 ? '+' : ''}
                    {greeks.netDelta.toFixed(2)} Δ
                  </td>
                  <td
                    className={`py-2.5 px-3 text-right font-bold tabular-nums ${
                      isRupeeDeltaPositive ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {isRupeeDeltaPositive ? '+' : ''}₹{(greeks.rupeeDelta / 1000).toFixed(2)}k / 1% move
                  </td>
                </tr>

                {/* Gamma */}
                <tr className="hover:bg-zinc-800/40 transition-colors">
                  <td className="py-2.5 px-3 font-semibold text-zinc-300 flex items-center gap-1.5">
                    <span className="text-amber-400 font-bold">Γ</span>
                    <span>Gamma (Γ)</span>
                  </td>
                  <td className="py-2.5 px-2 font-bold text-white tabular-nums">
                    {greeks.netGamma.toFixed(4)}
                  </td>
                  <td className="py-2.5 px-3 text-right">
                    <span
                      className={`inline-block text-[10px] px-1.5 py-0.5 rounded font-bold border ${
                        greeks.gammaRiskLabel === 'High Acceleration'
                          ? 'bg-red-500/10 text-red-400 border-red-500/30'
                          : greeks.gammaRiskLabel === 'Moderate'
                          ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
                          : 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                      }`}
                    >
                      {greeks.gammaRiskLabel}
                    </span>
                  </td>
                </tr>

                {/* Theta */}
                <tr className="hover:bg-zinc-800/40 transition-colors">
                  <td className="py-2.5 px-3 font-semibold text-zinc-300 flex items-center gap-1.5">
                    <span className="text-emerald-400 font-bold">Θ</span>
                    <span>Theta (Θ)</span>
                  </td>
                  <td className="py-2.5 px-2 font-bold text-emerald-400 tabular-nums">
                    {greeks.netTheta >= 0 ? '+' : ''}₹{greeks.netTheta.toLocaleString('en-IN')}/day
                  </td>
                  <td className="py-2.5 px-3 text-right font-bold text-emerald-400 tabular-nums">
                    +{greeks.thetaPerHour >= 0 ? '₹' : '-₹'}
                    {Math.abs(greeks.thetaPerHour).toLocaleString('en-IN')}/hr decay
                  </td>
                </tr>

                {/* Vega */}
                <tr className="hover:bg-zinc-800/40 transition-colors">
                  <td className="py-2.5 px-3 font-semibold text-zinc-300 flex items-center gap-1.5">
                    <span className="text-sky-400 font-bold">V</span>
                    <span>Vega (V)</span>
                  </td>
                  <td className="py-2.5 px-2 font-bold text-zinc-200 tabular-nums">
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
            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400 block">MAX PROFIT</span>
              <span className="font-bold text-emerald-400 text-sm mt-0.5 block tabular-nums">
                {typeof greeks.maxProfit === 'number'
                  ? `₹${greeks.maxProfit.toLocaleString('en-IN')}`
                  : greeks.maxProfit}
              </span>
            </div>

            <div className="p-2.5 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-400 block">PROBABILITY OF PROFIT</span>
              <span className="font-bold text-amber-400 text-sm mt-0.5 block tabular-nums">
                {greeks.popPct}% POP
              </span>
            </div>
          </div>
        </div>
      </TerminalPanel>

      {/* ── 2. QUICK EXECUTION & ADJUSTMENT TERMINAL PANEL ────────────────── */}
      <TerminalPanel
        title="QUICK EXECUTION & ADJUSTMENT BAR"
        icon={Zap}
        meta={<span className="text-[10px] font-bold text-amber-400">KEYBOARD ACTIVE</span>}
      >
        <div className="p-3.5 flex flex-col gap-3">
          {/* Action Grid matching the diagram */}
          <div className="grid grid-cols-2 gap-2">
            {/* Roll CE: Dual Up / Down */}
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 font-bold text-xs shadow-sm">
              <div className="flex items-center gap-1.5">
                <RotateCw className="w-3.5 h-3.5 text-sky-400" />
                <span>Roll CE</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onRollCeUp || onRollCe}
                  className="flex items-center gap-0.5 px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-emerald-400 border border-zinc-700 text-[10px] font-bold cursor-pointer transition-colors"
                  title="Roll Call UP further OTM [Hotkey: C]"
                >
                  <span>▲</span>
                  <span className="text-zinc-400 text-[9px]">[C]</span>
                </button>
                <button
                  type="button"
                  onClick={onRollCeDown || onRollCe}
                  className="flex items-center gap-0.5 px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-red-400 border border-zinc-700 text-[10px] font-bold cursor-pointer transition-colors"
                  title="Roll Call DOWN [Hotkey: Shift+C]"
                >
                  <span>▼</span>
                  <span className="text-zinc-400 text-[9px]">[⇧C]</span>
                </button>
              </div>
            </div>

            {/* Roll PE: Dual Up / Down */}
            <div className="flex items-center justify-between px-3 py-2 rounded-xl bg-zinc-950 border border-zinc-800 text-zinc-100 font-bold text-xs shadow-sm">
              <div className="flex items-center gap-1.5">
                <RotateCw className="w-3.5 h-3.5 text-amber-400" />
                <span>Roll PE</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  onClick={onRollPeUp || onRollPe}
                  className="flex items-center gap-0.5 px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-emerald-400 border border-zinc-700 text-[10px] font-bold cursor-pointer transition-colors"
                  title="Roll Put UP [Hotkey: Shift+P]"
                >
                  <span>▲</span>
                  <span className="text-zinc-400 text-[9px]">[⇧P]</span>
                </button>
                <button
                  type="button"
                  onClick={onRollPeDown || onRollPe}
                  className="flex items-center gap-0.5 px-2 py-0.5 rounded bg-zinc-900 hover:bg-zinc-800 text-red-400 border border-zinc-700 text-[10px] font-bold cursor-pointer transition-colors"
                  title="Roll Put DOWN further OTM [Hotkey: P]"
                >
                  <span>▼</span>
                  <span className="text-zinc-400 text-[9px]">[P]</span>
                </button>
              </div>
            </div>

            {/* Delta Hedge (H) */}
            <button
              onClick={onDeltaHedge}
              className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-zinc-950 border border-amber-500/30 hover:bg-amber-500/10 text-amber-300 font-bold text-xs transition-all cursor-pointer shadow-sm group"
              title="Neutralize portfolio delta skew [Hotkey: H]"
            >
              <div className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 text-amber-400" />
                <span>Delta Hedge</span>
              </div>
              <span className="text-[10px] bg-amber-500/20 px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 font-bold">
                H
              </span>
            </button>

            {/* Add Wings (W) */}
            <button
              onClick={onAddWings}
              className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-zinc-950 border border-emerald-500/30 hover:bg-emerald-500/10 text-emerald-300 font-bold text-xs transition-all cursor-pointer shadow-sm group"
              title="Add protective OTM wings to convert to Iron Condor [Hotkey: W]"
            >
              <div className="flex items-center gap-1.5">
                <Shield className="w-3.5 h-3.5 text-emerald-400" />
                <span>Add Wings</span>
              </div>
              <span className="text-[10px] bg-emerald-500/20 px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-300 font-bold">
                W
              </span>
            </button>

            {/* Trim 50% (X) */}
            <button
              onClick={onTrim50}
              className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-zinc-950 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-100 font-bold text-xs transition-all cursor-pointer shadow-sm group"
              title="Trim 50% of position size [Hotkey: X]"
            >
              <div className="flex items-center gap-1.5">
                <Scissors className="w-3.5 h-3.5 text-amber-400" />
                <span>Trim 50%</span>
              </div>
              <span className="text-[10px] bg-zinc-900 group-hover:bg-zinc-700 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-300 font-bold">
                X
              </span>
            </button>

            {/* FLATTEN (ESC) */}
            <button
              onClick={onFlatten}
              className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-red-950/70 border border-red-600 hover:bg-red-900 text-white font-bold text-xs transition-all cursor-pointer shadow-md group"
              title="Square Off All Open Legs [Hotkey: Escape]"
            >
              <div className="flex items-center gap-1.5">
                <LogOut className="w-3.5 h-3.5 text-red-400" />
                <span>FLATTEN</span>
              </div>
              <span className="text-[10px] bg-red-900 px-1.5 py-0.5 rounded border border-red-500 text-red-200 font-bold">
                ESC
              </span>
            </button>
          </div>

          {/* Action Feedback Banner */}
          {lastActionMessage && (
            <div className="mt-1 p-2 rounded-lg bg-zinc-950 border border-amber-500/30 text-amber-400 text-xs flex items-center gap-2 animate-in fade-in duration-200">
              <CheckCircle2 className="w-4 h-4 text-amber-400 shrink-0" />
              <span className="truncate">{lastActionMessage}</span>
            </div>
          )}
        </div>
      </TerminalPanel>
    </div>
  );
}

