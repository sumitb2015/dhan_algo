'use client';

import { useState } from 'react';
import { X, Sliders, RefreshCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import { RuleNumInput } from './RuleNumInput';
import type { BreakdownConfig, LedgerMode } from '@/lib/breakdownLedger';
import { indexTrendParamsOf } from '@/lib/breakdownScalper';

interface RulesConfigDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  config: BreakdownConfig;
  mode: LedgerMode;
  onUpdateConfig: (patch: Partial<BreakdownConfig>) => void;
  onSetMode: (mode: LedgerMode) => void;
  onResetSim: () => void;
}

/** HH:MM field that commits on blur/Enter only and reverts on anything that is not a valid time, so a half-typed
 *  "1" can never become an EOD cutoff that closes every position (dhan-commit-on-blur). */
function TimeInput({ value, onCommit, placeholder }: { value: string; onCommit: (v: string) => void; placeholder: string }) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value && /^([01]\d|2[0-3]):[0-5]\d$/.test(draft)) onCommit(draft);
    setDraft(null);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft ?? value}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(null);
      }}
      placeholder={placeholder}
      maxLength={5}
      className="mt-1 h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-white"
    />
  );
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
  const tp = indexTrendParamsOf(config);

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
              Separates entry signals from market bias using an EMA cross on NIFTY, optionally confirmed by a NIFTY
              Supertrend (no VWAP: the index has no volume). Computed on the candle timeframe below:
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

            <div className="flex flex-col gap-2 border-t border-zinc-800/60 pt-2.5">
              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-zinc-300 font-medium">Index EMA Cross</span>
                  <p className="text-[10px] text-zinc-500">Bull when fast &gt; slow, bear when fast &lt; slow</p>
                </div>
                <input
                  type="checkbox"
                  checked={tp.useEma}
                  onChange={(e) => onUpdateConfig({ trendUseEma: e.target.checked })}
                  aria-label="Use index EMA cross in the trend filter"
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                />
              </label>
              {tp.useEma && (
                <div className="flex items-center justify-between pl-3 border-l-2 border-zinc-800">
                  <span className="text-[11px] text-zinc-400">Periods</span>
                  <div className="flex items-center gap-1.5">
                    <span className="text-[11px] text-zinc-400">Fast</span>
                    <RuleNumInput
                      value={tp.emaFast}
                      onCommit={(v) =>
                        onUpdateConfig({ trendEmaFast: Math.max(2, Math.min(tp.emaSlow - 1, Math.round(Number(v) || tp.emaFast))) })
                      }
                      step={1}
                      min={2}
                      max={tp.emaSlow - 1}
                      className="w-14 text-center"
                    />
                    <span className="text-[11px] text-zinc-400">Slow</span>
                    <RuleNumInput
                      value={tp.emaSlow}
                      onCommit={(v) =>
                        onUpdateConfig({ trendEmaSlow: Math.max(tp.emaFast + 1, Math.min(200, Math.round(Number(v) || tp.emaSlow))) })
                      }
                      step={1}
                      min={tp.emaFast + 1}
                      max={200}
                      className="w-14 text-center"
                    />
                  </div>
                </div>
              )}

              <label className="flex items-center justify-between cursor-pointer">
                <div>
                  <span className="text-zinc-300 font-medium">Index Supertrend</span>
                  <p className="text-[10px] text-zinc-500">Confirmed direction · off by default: it cut profit in the backtest</p>
                </div>
                <input
                  type="checkbox"
                  checked={tp.useSupertrend}
                  onChange={(e) => onUpdateConfig({ trendUseSupertrend: e.target.checked })}
                  aria-label="Use index Supertrend in the trend filter"
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                />
              </label>
              {tp.useSupertrend && (
                <div className="grid grid-cols-2 gap-2 pl-3 border-l-2 border-zinc-800">
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[11px] text-zinc-400">ATR Period</span>
                    <RuleNumInput
                      value={tp.stPeriod}
                      onCommit={(v) => onUpdateConfig({ trendStPeriod: Math.max(2, Math.min(50, Math.round(Number(v) || tp.stPeriod))) })}
                      step={1}
                      min={2}
                      max={50}
                      className="w-14 text-center"
                    />
                  </div>
                  <div className="flex items-center justify-between gap-1">
                    <span className="text-[11px] text-zinc-400">Multiplier</span>
                    <RuleNumInput
                      value={tp.stMultiplier}
                      onCommit={(v) => onUpdateConfig({ trendStMultiplier: Math.max(0.5, Math.min(10, Number(v) || tp.stMultiplier)) })}
                      step={0.1}
                      min={0.5}
                      max={10}
                      className="w-14 text-center"
                    />
                  </div>
                </div>
              )}
              <p className="text-[10px] text-zinc-500">
                The index Supertrend uses close-to-close range (the backtest stores only index closes, so live does the same).
              </p>
              {!tp.useEma && !tp.useSupertrend && (
                <p className="text-[10px] text-amber-400 font-medium">
                  Both index trend filters are off: in AUTO mode, all breakdown signals will be allowed.
                </p>
              )}
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

          {/* Section 3b: Option Chart Breakdown Indicators */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-2.5">
            <span className="font-bold text-zinc-200">Option Chart Indicators</span>
            <p className="text-[11px] text-zinc-400 leading-relaxed">
              Select which indicators the option premium must close below to trigger a breakdown signal, and configure their parameters:
            </p>
            <div className="flex flex-col gap-2 pt-1">
              <div className="flex flex-col gap-1.5 py-1">
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <span className="text-zinc-300 font-medium">Supertrend</span>
                    <p className="text-[10px] text-zinc-500">Bearish trailing volatility band (price &lt; Supertrend)</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={config.useSupertrend !== false}
                    onChange={(e) => onUpdateConfig({ useSupertrend: e.target.checked })}
                    aria-label="Use Supertrend indicator"
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                  />
                </label>
                {config.useSupertrend !== false && (
                  <div className="grid grid-cols-2 gap-2 pl-3 pt-1 border-l-2 border-zinc-800">
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] text-zinc-400">ATR Period</span>
                      <RuleNumInput
                        value={config.stPeriod ?? 10}
                        onCommit={(v) => onUpdateConfig({ stPeriod: Math.max(2, Math.min(50, Math.round(Number(v) || 10))) })}
                        step={1}
                        min={2}
                        max={50}
                        className="w-14 text-center"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-1">
                      <span className="text-[11px] text-zinc-400">Multiplier</span>
                      <RuleNumInput
                        value={config.stMultiplier ?? 2.0}
                        onCommit={(v) => onUpdateConfig({ stMultiplier: Math.max(0.5, Math.min(10.0, Number(v) || 2.0)) })}
                        step={0.1}
                        min={0.5}
                        max={10.0}
                        className="w-14 text-center"
                      />
                    </div>
                  </div>
                )}
              </div>

              <label className="flex items-center justify-between cursor-pointer py-1 border-t border-zinc-800/60">
                <div>
                  <span className="text-zinc-300 font-medium">Session VWAP</span>
                  <p className="text-[10px] text-zinc-500">Volume-Weighted Average Price (price &lt; VWAP)</p>
                </div>
                <input
                  type="checkbox"
                  checked={config.useVwap !== false}
                  onChange={(e) => onUpdateConfig({ useVwap: e.target.checked })}
                  aria-label="Use VWAP indicator"
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                />
              </label>

              <div className="flex flex-col gap-1.5 py-1 border-t border-zinc-800/60">
                <label className="flex items-center justify-between cursor-pointer">
                  <div>
                    <span className="text-zinc-300 font-medium">EMA</span>
                    <p className="text-[10px] text-zinc-500">Exponential Moving Average (price &lt; EMA)</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={config.useEma !== false}
                    onChange={(e) => onUpdateConfig({ useEma: e.target.checked })}
                    aria-label="Use EMA indicator"
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                  />
                </label>
                {config.useEma !== false && (
                  <div className="flex items-center justify-between pl-3 pt-1 border-l-2 border-zinc-800">
                    <span className="text-[11px] text-zinc-400">EMA Period</span>
                    <RuleNumInput
                      value={config.emaPeriod ?? 20}
                      onCommit={(v) => onUpdateConfig({ emaPeriod: Math.max(3, Math.min(200, Math.round(Number(v) || 20))) })}
                      step={1}
                      min={3}
                      max={200}
                      className="w-14 text-center"
                    />
                  </div>
                )}
              </div>
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

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Hard Circuit Breaker</span>
                <p className="text-[10px] text-zinc-500">Emergency square off all open positions when daily loss limit is reached</p>
              </div>
              <input
                type="checkbox"
                checked={config.hardCircuitBreaker ?? true}
                onChange={(e) => onUpdateConfig({ hardCircuitBreaker: e.target.checked })}
                aria-label="Hard Circuit Breaker: emergency square off on daily loss limit"
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
              />
            </div>
          </div>

          {/* Section 4b: Brokerage & Execution Costs */}
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5 flex flex-col gap-3">
            <span className="font-bold text-zinc-200">Brokerage & Execution Fees</span>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Brokerage per Order (₹)</span>
                <p className="text-[10px] text-zinc-500">₹20 for Dhan / Zerodha · ₹0 for Kotak Trade Free</p>
              </div>
              <div className="flex items-center gap-1">
                <span className="text-zinc-500 font-mono">₹</span>
                <RuleNumInput
                  value={config.brokerage ?? 20}
                  onCommit={(v) => onUpdateConfig({ brokerage: Math.max(0, Math.min(100, Number(v) || 0)) })}
                  step={5}
                  min={0}
                  max={100}
                  className="w-16 text-center"
                />
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Backtest Data Source</span>
                <p className="text-[10px] text-zinc-500">
                  Backtest only · Breeze = sparse trade-only bars, own results; change then Re-run
                </p>
              </div>
              <select
                value={config.dataSource ?? 'dhan'}
                onChange={(e) => onUpdateConfig({ dataSource: e.target.value === 'breeze' ? 'breeze' : 'dhan' })}
                aria-label="Backtest data source"
                className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:ring-emerald-500"
              >
                <option value="dhan">Dhan DB</option>
                <option value="breeze">ICICI Breeze DB</option>
              </select>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Backtest Slippage (pts per fill)</span>
                <p className="text-[10px] text-zinc-500">Backtest only · entry sells lower, every exit buys higher · 0 = exact levels</p>
              </div>
              <RuleNumInput
                value={config.slippagePts ?? 0}
                onCommit={(v) => onUpdateConfig({ slippagePts: Math.max(0, Math.min(10, Number(v) || 0)) })}
                step={0.05}
                min={0}
                max={10}
                className="w-16 text-center"
              />
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Backtest: Skip Cold Contracts</span>
                <p className="text-[10px] text-zinc-500">
                  Backtest only · no entry on a strike without enough previous-day bars to seed EMA20 (not like live)
                </p>
              </div>
              <input
                type="checkbox"
                checked={!!config.btWarmOnly}
                onChange={(e) => onUpdateConfig({ btWarmOnly: e.target.checked })}
                aria-label="Backtest: skip cold contracts"
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
              />
            </div>

            <div className="flex items-center gap-2 pt-1 border-t border-zinc-800/60">
              <button
                type="button"
                onClick={() => onUpdateConfig({ brokerage: 20 })}
                className={cn(
                  'flex-1 rounded py-1 text-[11px] font-bold border transition',
                  (config.brokerage ?? 20) === 20
                    ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white',
                )}
              >
                Dhan / Std (₹20)
              </button>
              <button
                type="button"
                onClick={() => onUpdateConfig({ brokerage: 0 })}
                className={cn(
                  'flex-1 rounded py-1 text-[11px] font-bold border transition',
                  config.brokerage === 0
                    ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white',
                )}
              >
                Kotak Neo (₹0)
              </button>
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
                <span className="text-zinc-300 font-medium">Lock & Trail Trigger %</span>
                <p className="text-[10px] text-zinc-500">At this profit %, lock SL to cost and start trailing</p>
              </div>
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={config.trailStartPct ?? config.trailPct ?? 15}
                  onCommit={(v) => {
                    const val = Math.max(5, Math.min(50, Number(v) || 15));
                    onUpdateConfig({ trailStartPct: val, trailPct: val });
                  }}
                  step={1}
                  min={5}
                  max={50}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">%</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Trail Step (x pts)</span>
                <p className="text-[10px] text-zinc-500">For every X points gain in option premium beyond trigger</p>
              </div>
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={config.trailStepPts ?? 5}
                  onCommit={(v) => onUpdateConfig({ trailStepPts: Math.max(0.5, Math.min(50, Number(v) || 5)) })}
                  step={0.5}
                  min={0.5}
                  max={50}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">pts</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-zinc-300 font-medium">Trail By (y pts)</span>
                <p className="text-[10px] text-zinc-500">Tighten stop-loss by Y points for every step</p>
              </div>
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={config.trailByPts ?? 2}
                  onCommit={(v) => onUpdateConfig({ trailByPts: Math.max(0.5, Math.min(50, Number(v) || 2)) })}
                  step={0.5}
                  min={0.5}
                  max={50}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">pts</span>
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
                <TimeInput value={config.entryStart} onCommit={(v) => onUpdateConfig({ entryStart: v })} placeholder="09:30" />
              </div>

              <div>
                <span className="text-[10px] text-zinc-400">Entry Window End</span>
                <TimeInput value={config.entryEnd} onCommit={(v) => onUpdateConfig({ entryEnd: v })} placeholder="15:00" />
              </div>
            </div>

            <div>
              <span className="text-[10px] text-zinc-400">Mandatory EOD Exit Cutoff</span>
              <TimeInput value={config.eodExit} onCommit={(v) => onUpdateConfig({ eodExit: v })} placeholder="15:15" />
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
