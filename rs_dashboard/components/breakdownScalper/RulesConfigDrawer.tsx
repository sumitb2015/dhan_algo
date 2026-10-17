'use client';

import { X, ShieldAlert, Sliders, CheckCircle, RefreshCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RuleNumInput } from './RuleNumInput';
import type { BreakdownConfig, LedgerMode } from '@/lib/breakdownLedger';

interface RulesConfigDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  config: BreakdownConfig;
  mode: LedgerMode;
  onUpdateConfig: (patch: Partial<BreakdownConfig>) => void;
  onSetMode: (mode: LedgerMode) => void;
  onResetSim: () => void;
}

export function RulesConfigDrawer({
  isOpen,
  onClose,
  config,
  mode,
  onUpdateConfig,
  onSetMode,
  onResetSim,
}: RulesConfigDrawerProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-oncolor-dark/70 backdrop-blur-sm">
      <div className="flex h-full w-full max-w-lg flex-col border-l border-zinc-800 bg-zinc-950 p-6 text-white shadow-2xl overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-500/10 border border-emerald-500/25">
              <Sliders className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">Strategy & Risk Rules</h2>
              <p className="text-[10px] text-zinc-500">Multi-strike breakdown seller settings</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form Body */}
        <div className="mt-5 flex flex-col gap-5 text-xs">
          {/* Section 1: Execution Mode */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-zinc-200">Execution Mode</span>
              <span
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-extrabold uppercase',
                  mode === 'REAL'
                    ? 'bg-red-500/20 text-red-400 border border-red-500/30'
                    : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30',
                )}
              >
                {mode === 'REAL' ? 'REAL MONEY ARMED' : 'SIMULATED PAPER'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 mt-1">
              <button
                type="button"
                onClick={() => onSetMode('SIM')}
                className={cn(
                  'rounded-lg py-1.5 font-bold transition text-xs border',
                  mode === 'SIM'
                    ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/50 shadow-sm'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white',
                )}
              >
                SIM (Virtual Paper)
              </button>
              <button
                type="button"
                onClick={() => {
                  if (confirm('Enable REAL live orders? Real trades will be submitted to the broker!')) {
                    onSetMode('REAL');
                  }
                }}
                className={cn(
                  'rounded-lg py-1.5 font-bold transition text-xs border',
                  mode === 'REAL'
                    ? 'bg-red-600/20 text-red-300 border-red-500/50 shadow-sm'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white',
                )}
              >
                REAL (Live Orders)
              </button>
            </div>

            {mode === 'SIM' && (
              <button
                type="button"
                onClick={() => {
                  if (confirm('Clear SIM paper trading history?')) {
                    onResetSim();
                  }
                }}
                className="mt-1 flex items-center justify-center gap-1.5 text-[11px] font-medium text-zinc-400 hover:text-red-400 transition"
              >
                <RefreshCcw className="h-3 w-3" />
                <span>Reset SIM Paper Trades</span>
              </button>
            )}
          </div>

          {/* Section 2: Market Bias Filter */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-2.5">
            <span className="font-bold text-zinc-200">Market Direction Filter</span>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              Separates entry signals from market bias using NIFTY Spot vs VWAP & EMA 9/20:
            </p>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onUpdateConfig({ trendMode: 'AUTO' })}
                className={cn(
                  'rounded-lg p-2 text-left border transition text-xs',
                  config.trendMode === 'AUTO'
                    ? 'bg-emerald-600/20 text-emerald-300 border-emerald-500/40'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white',
                )}
              >
                <div className="font-bold">AUTO Trend Filter</div>
                <div className="text-[10px] text-zinc-400 mt-0.5">Bull=PE only, Bear=CE only, Side=Block</div>
              </button>

              <button
                type="button"
                onClick={() => onUpdateConfig({ trendMode: 'BYPASS' })}
                className={cn(
                  'rounded-lg p-2 text-left border transition text-xs',
                  config.trendMode === 'BYPASS'
                    ? 'bg-sky-600/20 text-sky-300 border-sky-500/40'
                    : 'bg-zinc-800 text-zinc-400 border-zinc-700 hover:text-white',
                )}
              >
                <div className="font-bold">BYPASS Filter</div>
                <div className="text-[10px] text-zinc-400 mt-0.5">Allow both CE & PE breakdown entries</div>
              </button>
            </div>
          </div>

          {/* Section 3: Timeframe & Strike Window */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-3">
            <span className="font-bold text-zinc-200">Scanner & Timeframe</span>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Candle Timeframe</span>
                <p className="text-[10px] text-zinc-500">Indicator calculation bucket</p>
              </div>
              <div className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
                {[1, 3, 5].map((tf) => (
                  <button
                    key={tf}
                    type="button"
                    onClick={() => onUpdateConfig({ timeframe: tf as 1 | 3 | 5 })}
                    className={cn(
                      'rounded px-2.5 py-0.5 text-xs font-bold transition',
                      config.timeframe === tf
                        ? 'bg-zinc-800 text-white'
                        : 'text-zinc-500 hover:text-zinc-200',
                    )}
                  >
                    {tf}m
                  </button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Strike Scan Window</span>
                <p className="text-[10px] text-zinc-500">ATM ± N strikes (e.g. ±6 = 26 contracts)</p>
              </div>
              <RuleNumInput
                value={config.strikeWindow}
                onCommit={(v) => onUpdateConfig({ strikeWindow: Math.max(2, Math.min(10, Number(v) || 6)) })}
                step={1}
                min={2}
                max={10}
                className="w-16 text-center"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Lots Per Short</span>
                <p className="text-[10px] text-zinc-500">Contract lots per entry signal</p>
              </div>
              <RuleNumInput
                value={config.lotsPerTrade}
                onCommit={(v) => onUpdateConfig({ lotsPerTrade: Math.max(1, Math.min(20, Number(v) || 1)) })}
                step={1}
                min={1}
                max={20}
                className="w-16 text-center"
              />
            </div>
          </div>

          {/* Section 4: Position & Risk Limits */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-3">
            <span className="font-bold text-zinc-200">Portfolio & Risk Limits</span>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Max Concurrent Positions</span>
                <p className="text-[10px] text-zinc-500">Hard cap on open short trades</p>
              </div>
              <RuleNumInput
                value={config.maxConcurrent}
                onCommit={(v) => onUpdateConfig({ maxConcurrent: Math.max(1, Math.min(5, Number(v) || 2)) })}
                step={1}
                min={1}
                max={5}
                className="w-16 text-center"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Max Same-Side Positions</span>
                <p className="text-[10px] text-zinc-500">Max concurrent CE or PE legs</p>
              </div>
              <RuleNumInput
                value={config.maxSameSide}
                onCommit={(v) => onUpdateConfig({ maxSameSide: Math.max(1, Math.min(3, Number(v) || 1)) })}
                step={1}
                min={1}
                max={3}
                className="w-16 text-center"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Daily Loss Limit (₹)</span>
                <p className="text-[10px] text-zinc-500">Halt all auto-trading once reached</p>
              </div>
              <RuleNumInput
                value={config.dailyLossLimit}
                onCommit={(v) => onUpdateConfig({ dailyLossLimit: Math.max(1000, Number(v) || 5000) })}
                step={500}
                min={1000}
                className="w-24 text-right"
              />
            </div>
          </div>

          {/* Section 5: Stop-Loss & Trailing Stop */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-3">
            <span className="font-bold text-zinc-200">Stop-Loss & Profit Exits</span>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Initial Stop-Loss %</span>
                <p className="text-[10px] text-zinc-500">Max loss % above entry premium</p>
              </div>
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={config.slPct}
                  onCommit={(v) => onUpdateConfig({ slPct: Math.max(5, Math.min(100, Number(v) || 25)) })}
                  step={5}
                  min={5}
                  max={100}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">%</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Trailing Stop-Loss %</span>
                <p className="text-[10px] text-zinc-500">Ratchets down as premium drops, never loosens</p>
              </div>
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={config.trailPct}
                  onCommit={(v) => onUpdateConfig({ trailPct: Math.max(5, Math.min(50, Number(v) || 15)) })}
                  step={5}
                  min={5}
                  max={50}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">%</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Scalp Target Decay %</span>
                <p className="text-[10px] text-zinc-500">Take profit floor (e.g. 35% premium decay)</p>
              </div>
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={config.targetPct}
                  onCommit={(v) => onUpdateConfig({ targetPct: Math.max(0, Math.min(90, Number(v) || 35)) })}
                  step={5}
                  min={0}
                  max={90}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">%</span>
              </div>
            </div>

            <div className="flex items-center justify-between pt-1 border-t border-zinc-800/60">
              <div>
                <span className="text-zinc-300 font-medium">Indicator Recovery Exit</span>
                <p className="text-[10px] text-zinc-500">Close if option closes back above ST or EMA</p>
              </div>
              <input
                type="checkbox"
                checked={config.recoveryExit}
                onChange={(e) => onUpdateConfig({ recoveryExit: e.target.checked })}
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
              />
            </div>
          </div>

          {/* Section 6: Trading Schedule */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-3">
            <span className="font-bold text-zinc-200">Trading Hours (IST)</span>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-[10px] text-zinc-400">Entry Window Start</span>
                <input
                  type="text"
                  value={config.entryStart}
                  onChange={(e) => onUpdateConfig({ entryStart: e.target.value })}
                  placeholder="09:30"
                  className="mt-1 h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-white"
                />
              </div>

              <div>
                <span className="text-[10px] text-zinc-400">Entry Window End</span>
                <input
                  type="text"
                  value={config.entryEnd}
                  onChange={(e) => onUpdateConfig({ entryEnd: e.target.value })}
                  placeholder="15:00"
                  className="mt-1 h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-white"
                />
              </div>
            </div>

            <div>
              <span className="text-[10px] text-zinc-400">Mandatory EOD Exit Cutoff</span>
              <input
                type="text"
                value={config.eodExit}
                onChange={(e) => onUpdateConfig({ eodExit: e.target.value })}
                placeholder="15:15"
                className="mt-1 h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-white"
              />
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="mt-auto border-t border-zinc-800 pt-4 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-bold text-oncolor transition hover:bg-emerald-500"
          >
            Done
          </button>
        </div>
      </div>
    </div>
  );
}
