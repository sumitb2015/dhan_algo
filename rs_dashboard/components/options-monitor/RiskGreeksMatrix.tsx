'use client';

import React from 'react';
import { PortfolioGreeks } from '@/lib/optionsMonitorMath';
import {
  Zap,
  RotateCw,
  Shield,
  Scissors,
  LogOut,
  Activity,
} from 'lucide-react';

interface RiskGreeksMatrixProps {
  greeks: PortfolioGreeks;
  lastActionMessage: string | null;
  availableMargin?: number | null;
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
  onOpenTradeBasket?: () => void;
}

function formatRupee(amount: number): string {
  const isNeg = amount < 0;
  const absVal = Math.abs(amount);
  return `${isNeg ? '-' : ''}₹${absVal.toLocaleString('en-IN')}`;
}

function formatRupeeCompact(amount: number): string {
  const isNeg = amount < 0;
  const absVal = Math.abs(amount);
  if (absVal >= 100000) {
    return `${isNeg ? '-' : ''}₹${(absVal / 100000).toFixed(2)}L`;
  }
  if (absVal >= 1000) {
    return `${isNeg ? '-' : ''}₹${(absVal / 1000).toFixed(1)}k`;
  }
  return `${isNeg ? '-' : ''}₹${Math.round(absVal)}`;
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
    <section className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/80 shadow-sm overflow-hidden ${className}`}>
      <header className="flex items-center justify-between gap-2 border-b border-zinc-800/80 bg-zinc-950/70 px-3 py-2">
        <div className="flex items-center gap-1.5 min-w-0">
          <Icon className="h-3.5 w-3.5 text-amber-400 shrink-0" />
          <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300 truncate">
            {title}
          </span>
        </div>
        {meta ? <div className="font-mono text-[10px] shrink-0">{meta}</div> : null}
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

export default function RiskGreeksMatrix({
  greeks,
  lastActionMessage,
  availableMargin = null,
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
  onOpenTradeBasket,
}: RiskGreeksMatrixProps) {
  const isRupeeDeltaPositive = greeks.rupeeDelta >= 0;

  return (
    <div className="flex flex-col gap-3 font-mono select-none">
      {/* ── 1. RISK & GREEKS MATRIX TERMINAL PANEL ───────────────────────── */}
      <TerminalPanel
        title="RISK & GREEKS MATRIX"
        icon={Activity}
        meta={<span className="text-zinc-500 text-[9px] tracking-wider uppercase">INTRADAY METRICS</span>}
      >
        <div className="p-2.5 flex flex-col gap-2.5">
          {/* Greeks Table */}
          <div className="w-full">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="bg-zinc-800 text-white font-bold text-[10px]">
                  <th className="py-1.5 px-2 rounded-l">GREEK</th>
                  <th className="py-1.5 px-1.5 text-center">VALUE</th>
                  <th className="py-1.5 px-2 text-right rounded-r">RISK / IMPACT</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {/* Net Delta */}
                <tr className="hover:bg-zinc-800/30 transition-colors">
                  <td className="py-2 px-2 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="w-4 h-4 rounded flex items-center justify-center bg-sky-500/10 text-sky-400 border border-sky-500/30 text-[10px] font-bold shrink-0">
                        Δ
                      </span>
                      <span className="font-medium text-zinc-300 text-xs">Delta</span>
                    </div>
                  </td>
                  <td className="py-2 px-1.5 text-center font-bold text-white tabular-nums text-xs whitespace-nowrap">
                    {greeks.netDelta >= 0 ? '+' : ''}
                    {greeks.netDelta.toFixed(2)} Δ
                  </td>
                  <td
                    className={`py-2 px-2 text-right font-bold tabular-nums text-xs whitespace-nowrap ${
                      isRupeeDeltaPositive ? 'text-emerald-400' : 'text-red-400'
                    }`}
                  >
                    {isRupeeDeltaPositive ? '+' : ''}{formatRupeeCompact(greeks.rupeeDelta)}/1%
                  </td>
                </tr>

                {/* Gamma */}
                <tr className="hover:bg-zinc-800/30 transition-colors">
                  <td className="py-2 px-2 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="w-4 h-4 rounded flex items-center justify-center bg-purple-500/10 text-purple-400 border border-purple-500/30 text-[10px] font-bold shrink-0">
                        Γ
                      </span>
                      <span className="font-medium text-zinc-300 text-xs">Gamma</span>
                    </div>
                  </td>
                  <td className="py-2 px-1.5 text-center font-bold text-white tabular-nums text-xs whitespace-nowrap">
                    {greeks.netGamma.toFixed(4)}
                  </td>
                  <td className="py-2 px-2 text-right whitespace-nowrap">
                    <span
                      className={`inline-block text-[9px] px-1.5 py-0.5 rounded font-bold border ${
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
                <tr className="hover:bg-zinc-800/30 transition-colors">
                  <td className="py-2 px-2 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="w-4 h-4 rounded flex items-center justify-center bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-[10px] font-bold shrink-0">
                        Θ
                      </span>
                      <span className="font-medium text-zinc-300 text-xs">Theta</span>
                    </div>
                  </td>
                  <td className="py-2 px-1.5 text-center font-bold text-emerald-400 tabular-nums text-xs whitespace-nowrap">
                    {greeks.netTheta >= 0 ? '+' : ''}₹{Math.round(greeks.netTheta).toLocaleString('en-IN')}/d
                  </td>
                  <td className="py-2 px-2 text-right font-bold text-emerald-400 tabular-nums text-xs whitespace-nowrap">
                    {greeks.thetaPerHour >= 0 ? '+' : ''}{formatRupee(Math.round(greeks.thetaPerHour))}/hr
                  </td>
                </tr>

                {/* Vega */}
                <tr className="hover:bg-zinc-800/30 transition-colors">
                  <td className="py-2 px-2 whitespace-nowrap">
                    <div className="flex items-center gap-1.5">
                      <span className="w-4 h-4 rounded flex items-center justify-center bg-amber-500/10 text-amber-400 border border-amber-500/30 text-[10px] font-bold shrink-0">
                        V
                      </span>
                      <span className="font-medium text-zinc-300 text-xs">Vega</span>
                    </div>
                  </td>
                  <td className="py-2 px-1.5 text-center font-bold text-zinc-200 tabular-nums text-xs whitespace-nowrap">
                    {greeks.netVega >= 0 ? '+' : ''}₹{Math.round(greeks.netVega).toLocaleString('en-IN')}
                  </td>
                  <td className="py-2 px-2 text-right text-zinc-400 text-xs tabular-nums whitespace-nowrap">
                    / 1.0% VIX
                  </td>
                </tr>
              </tbody>
            </table>
          </div>

          {/* Supplementary Risk & Margin Stats Grid */}
          <div className="grid grid-cols-2 gap-1.5 pt-2 border-t border-zinc-800/80 text-xs">
            <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 block">
                MAX PROFIT
              </span>
              <span className="font-bold text-emerald-400 text-xs mt-0.5 block tabular-nums truncate">
                {typeof greeks.maxProfit === 'number'
                  ? `₹${greeks.maxProfit.toLocaleString('en-IN')}`
                  : greeks.maxProfit}
              </span>
            </div>

            <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 block">
                PROB. OF PROFIT
              </span>
              <span className="font-bold text-amber-400 text-xs mt-0.5 block tabular-nums truncate">
                {greeks.popPct}% POP
              </span>
            </div>

            <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 block">
                MAX LOSS
              </span>
              <span className="font-bold text-red-400 text-xs mt-0.5 block tabular-nums truncate">
                {typeof greeks.maxLoss === 'number'
                  ? formatRupee(greeks.maxLoss)
                  : greeks.maxLoss}
              </span>
            </div>

            <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 block">
                EST. MARGIN
              </span>
              <span className="font-bold text-zinc-200 text-xs mt-0.5 block tabular-nums truncate">
                ₹{(greeks.estimatedMargin / 100000).toFixed(2)}L
              </span>
            </div>

            <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 block">
                AVAIL. MARGIN (DHAN)
              </span>
              <span className="font-bold text-emerald-400 text-xs mt-0.5 block tabular-nums truncate">
                {availableMargin !== null && availableMargin !== undefined
                  ? availableMargin >= 100000
                    ? `₹${(availableMargin / 100000).toFixed(2)}L`
                    : `₹${availableMargin.toLocaleString('en-IN')}`
                  : '--'}
              </span>
            </div>

            <div className="p-2 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-[9px] font-bold uppercase tracking-wider text-zinc-500 block">
                MARGIN BUFFER
              </span>
              <span
                className={`font-bold text-xs mt-0.5 block tabular-nums truncate ${
                  availableMargin !== null && availableMargin >= greeks.estimatedMargin
                    ? 'text-emerald-400'
                    : 'text-amber-400'
                }`}
              >
                {availableMargin !== null && availableMargin !== undefined
                  ? availableMargin >= greeks.estimatedMargin
                    ? `+₹${((availableMargin - greeks.estimatedMargin) / 100000).toFixed(2)}L`
                    : `-₹${((greeks.estimatedMargin - availableMargin) / 100000).toFixed(2)}L`
                  : '--'}
              </span>
            </div>
          </div>
        </div>
      </TerminalPanel>

      {/* ── 2. QUICK EXECUTION & ADJUSTMENT TERMINAL PANEL ────────────────── */}
      <TerminalPanel
        title="QUICK EXECUTION & ADJUSTMENT"
        icon={Zap}
        meta={<span className="text-[9px] font-bold text-amber-400/90 tracking-wider">HOTKEYS ACTIVE</span>}
      >
        <div className="p-2.5 flex flex-col gap-2">
          {/* Primary Basket Execution Button */}
          {onOpenTradeBasket && (
            <button
              type="button"
              onClick={onOpenTradeBasket}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-bold text-xs shadow-sm transition-all cursor-pointer group"
              title="Execute active strategy basket on Dhan broker [F5]"
            >
              <div className="flex items-center gap-1.5">
                <Zap className="w-3.5 h-3.5 fill-current group-hover:scale-110 transition-transform" />
                <span className="tracking-wider text-[11px]">EXECUTE BASKET</span>
              </div>
              <kbd className="text-[9px] bg-emerald-700 px-1.5 py-0.5 rounded font-mono font-bold">
                [F5]
              </kbd>
            </button>
          )}

          {/* Roll Controls: 2 compact cards side-by-side */}
          <div className="grid grid-cols-2 gap-1.5">
            {/* Roll CE */}
            <div className="flex flex-col p-2 rounded-lg bg-zinc-950 border border-zinc-800/90 gap-1.5">
              <div className="flex items-center justify-between text-[10px] font-bold text-sky-400">
                <span className="flex items-center gap-1">
                  <RotateCw className="w-3 h-3 text-sky-400" />
                  Roll CE
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={onRollCeUp || onRollCe}
                  className="flex items-center justify-center gap-0.5 py-1 px-1 rounded bg-zinc-900 hover:bg-zinc-800 text-emerald-400 border border-zinc-700/60 text-[10px] font-bold transition-colors cursor-pointer"
                  title="Roll Call UP further OTM [Hotkey: C]"
                >
                  <span>▲</span>
                  <span className="text-zinc-400 text-[8px]">[C]</span>
                </button>
                <button
                  type="button"
                  onClick={onRollCeDown || onRollCe}
                  className="flex items-center justify-center gap-0.5 py-1 px-1 rounded bg-zinc-900 hover:bg-zinc-800 text-red-400 border border-zinc-700/60 text-[10px] font-bold transition-colors cursor-pointer"
                  title="Roll Call DOWN [Hotkey: Shift+C]"
                >
                  <span>▼</span>
                  <span className="text-zinc-400 text-[8px]">[⇧C]</span>
                </button>
              </div>
            </div>

            {/* Roll PE */}
            <div className="flex flex-col p-2 rounded-lg bg-zinc-950 border border-zinc-800/90 gap-1.5">
              <div className="flex items-center justify-between text-[10px] font-bold text-amber-400">
                <span className="flex items-center gap-1">
                  <RotateCw className="w-3 h-3 text-amber-400" />
                  Roll PE
                </span>
              </div>
              <div className="grid grid-cols-2 gap-1">
                <button
                  type="button"
                  onClick={onRollPeUp || onRollPe}
                  className="flex items-center justify-center gap-0.5 py-1 px-1 rounded bg-zinc-900 hover:bg-zinc-800 text-emerald-400 border border-zinc-700/60 text-[10px] font-bold transition-colors cursor-pointer"
                  title="Roll Put UP [Hotkey: Shift+P]"
                >
                  <span>▲</span>
                  <span className="text-zinc-400 text-[8px]">[⇧P]</span>
                </button>
                <button
                  type="button"
                  onClick={onRollPeDown || onRollPe}
                  className="flex items-center justify-center gap-0.5 py-1 px-1 rounded bg-zinc-900 hover:bg-zinc-800 text-red-400 border border-zinc-700/60 text-[10px] font-bold transition-colors cursor-pointer"
                  title="Roll Put DOWN further OTM [Hotkey: P]"
                >
                  <span>▼</span>
                  <span className="text-zinc-400 text-[8px]">[P]</span>
                </button>
              </div>
            </div>
          </div>

          {/* Quick Action Buttons 2x2 Grid */}
          <div className="grid grid-cols-2 gap-1.5">
            {/* Delta Hedge (H) */}
            <button
              onClick={onDeltaHedge}
              className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-amber-500/25 hover:bg-amber-500/10 text-amber-300 font-bold text-[11px] transition-all cursor-pointer shadow-sm group"
              title="Neutralize portfolio delta skew [Hotkey: H]"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Zap className="w-3 h-3 text-amber-400 shrink-0" />
                <span className="truncate">Delta Hedge</span>
              </div>
              <kbd className="text-[9px] bg-amber-500/20 px-1.5 py-0.5 rounded border border-amber-500/40 text-amber-300 font-bold shrink-0">
                H
              </kbd>
            </button>

            {/* Add Wings (W) */}
            <button
              onClick={onAddWings}
              className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-emerald-500/25 hover:bg-emerald-500/10 text-emerald-300 font-bold text-[11px] transition-all cursor-pointer shadow-sm group"
              title="Add protective OTM wings to convert to Iron Condor [Hotkey: W]"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Shield className="w-3 h-3 text-emerald-400 shrink-0" />
                <span className="truncate">Add Wings</span>
              </div>
              <kbd className="text-[9px] bg-emerald-500/20 px-1.5 py-0.5 rounded border border-emerald-500/40 text-emerald-300 font-bold shrink-0">
                W
              </kbd>
            </button>

            {/* Trim 50% (X) */}
            <button
              onClick={onTrim50}
              className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 hover:bg-zinc-800 hover:border-zinc-700 text-zinc-200 font-bold text-[11px] transition-all cursor-pointer shadow-sm group"
              title="Trim 50% of position size [Hotkey: X]"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <Scissors className="w-3 h-3 text-zinc-400 group-hover:text-zinc-200 shrink-0" />
                <span className="truncate">Trim 50%</span>
              </div>
              <kbd className="text-[9px] bg-zinc-900 group-hover:bg-zinc-700 px-1.5 py-0.5 rounded border border-zinc-700 text-zinc-400 font-bold shrink-0">
                X
              </kbd>
            </button>

            {/* FLATTEN (ESC) */}
            <button
              onClick={onFlatten}
              className="flex items-center justify-between px-2.5 py-1.5 rounded-lg bg-red-950/60 border border-red-500/50 hover:bg-red-900 text-white font-bold text-[11px] transition-all cursor-pointer shadow-sm group"
              title="Square Off All Open Legs [Hotkey: Escape]"
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <LogOut className="w-3 h-3 text-red-400 shrink-0" />
                <span className="truncate text-red-100">FLATTEN</span>
              </div>
              <kbd className="text-[9px] bg-red-900/80 px-1.5 py-0.5 rounded border border-red-500 text-red-200 font-bold shrink-0">
                ESC
              </kbd>
            </button>
          </div>

          {/* Action Feedback Ticker */}
          {lastActionMessage && (
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-amber-500/30 text-[10px] text-amber-300 font-mono animate-in fade-in duration-150">
              <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse shrink-0" />
              <span className="truncate">{lastActionMessage}</span>
            </div>
          )}
        </div>
      </TerminalPanel>
    </div>
  );
}
