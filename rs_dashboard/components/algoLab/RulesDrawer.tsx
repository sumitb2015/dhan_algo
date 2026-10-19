'use client';

import { useState } from 'react';
import { X, Sliders, RefreshCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlgoConfig, ConfigField, ConfigValue, LedgerMode } from '@/lib/algoLab/types';
import { RuleNumInput } from '@/components/breakdownScalper/RuleNumInput';

/**
 * HH:MM time field that commits on blur/Enter only and reverts on invalid times,
 * ensuring a half-typed value cannot trigger premature EOD square-offs (dhan-commit-on-blur).
 */
function TimeInput({
  value,
  onCommit,
  placeholder = 'HH:MM',
  ariaLabel,
}: {
  value: string;
  onCommit: (v: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft !== null && draft !== value && /^([01]\d|2[0-3]):[0-5]\d$/.test(draft)) {
      onCommit(draft);
    }
    setDraft(null);
  };
  return (
    <input
      type="text"
      inputMode="numeric"
      value={draft ?? value}
      aria-label={ariaLabel ?? placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') setDraft(null);
      }}
      placeholder={placeholder}
      maxLength={5}
      className="mt-1 h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 font-mono text-xs text-white focus:border-emerald-500/50 focus:outline-none"
    />
  );
}

/** Card container shared across all rule sections */
function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5">
      <span className="font-bold text-zinc-200">{title}</span>
      {description && <p className="text-[11px] leading-relaxed text-zinc-400">{description}</p>}
      {children}
    </div>
  );
}

/** Single row for a setting item with title, sublabel, and input control */
function FieldRow({
  label,
  sublabel,
  borderTop,
  children,
}: {
  label: React.ReactNode;
  sublabel?: string;
  borderTop?: boolean;
  children: React.ReactNode;
}) {
  return (
    <div className={cn('flex items-center justify-between', borderTop && 'border-t border-zinc-800/60 pt-2')}>
      <div>
        <span className="font-medium text-zinc-300">{label}</span>
        {sublabel && <p className="text-[10px] text-zinc-500">{sublabel}</p>}
      </div>
      <div>{children}</div>
    </div>
  );
}

interface RulesDrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  strategyKey?: string;
  fields: ConfigField[];
  config: AlgoConfig;
  defaults: AlgoConfig;
  mode: LedgerMode;
  realAllowed: boolean;
  onPatch: (patch: Record<string, ConfigValue>) => void;
  onSetMode: (m: LedgerMode) => void;
  onResetSim: () => void;
}

/**
 * Universal Strategy & Risk Rules Drawer Template.
 * Provides consistent typography, card layout, pill buttons, commit-on-blur stepper inputs,
 * and section hierarchy across all Algo Lab strategies.
 */
export function RulesDrawer({
  open,
  onClose,
  title,
  strategyKey,
  fields,
  config,
  defaults,
  mode,
  realAllowed,
  onPatch,
  onSetMode,
  onResetSim,
}: RulesDrawerProps) {
  if (!open) return null;

  const has = (key: string) => fields.some((f) => f.key === key) || config[key] !== undefined;

  // Helper values from config
  const tf = (config.timeframe as 1 | 3 | 5) ?? 1;
  const strikeWindow = Number(config.strikeWindow ?? 6);
  const lotsPerTrade = Number(config.lotsPerTrade ?? 1);
  const maxConcurrent = Number(config.maxConcurrent ?? 2);
  const maxSameSide = Number(config.maxSameSide ?? 1);
  const dailyLossLimit = Number(config.dailyLossLimit ?? 5000);
  const hardCircuitBreaker = config.hardCircuitBreaker !== false;
  const brokerage = Number(config.brokerage ?? 20);
  const dataSource = (config.dataSource as string) ?? 'dhan';
  const slippagePts = Number(config.slippagePts ?? 0);
  const btWarmOnly = Boolean(config.btWarmOnly);

  const trendMode = (config.trendMode as string) ?? 'AUTO';
  const trendUseEma = config.trendUseEma !== false;
  const trendEmaFast = Number(config.trendEmaFast ?? 9);
  const trendEmaSlow = Number(config.trendEmaSlow ?? 20);
  const trendUseSupertrend = Boolean(config.trendUseSupertrend);
  const trendStPeriod = Number(config.trendStPeriod ?? 7);
  const trendStMultiplier = Number(config.trendStMultiplier ?? 3.0);

  const useSupertrend = config.useSupertrend !== false;
  const stPeriod = Number(config.stPeriod ?? 7);
  const stMultiplier = Number(config.stMultiplier ?? 1.5);
  const useVwap = Boolean(config.useVwap);
  const useEma = Boolean(config.useEma);
  const emaPeriod = Number(config.emaPeriod ?? 20);

  const slPct = Number(config.slPct ?? 20);
  const trailStartPct = Number(config.trailStartPct ?? 15);
  const trailStepPts = Number(config.trailStepPts ?? 2);
  const trailByPts = Number(config.trailByPts ?? 1);
  const targetPct = Number(config.targetPct ?? 35);
  const recoveryExit = Boolean(config.recoveryExit);

  const entryStart = String(config.entryStart ?? '09:30');
  const entryEnd = String(config.entryEnd ?? '15:00');
  const eodExit = String(config.eodExit ?? '15:15');

  // Track standard keys so remaining custom fields can be rendered in an additional section if needed
  const handledKeys = new Set([
    'timeframe',
    'strikeWindow',
    'lotsPerTrade',
    'maxConcurrent',
    'maxSameSide',
    'dailyLossLimit',
    'hardCircuitBreaker',
    'brokerage',
    'dataSource',
    'slippagePts',
    'btWarmOnly',
    'trendMode',
    'trendUseEma',
    'trendEmaFast',
    'trendEmaSlow',
    'trendUseSupertrend',
    'trendStPeriod',
    'trendStMultiplier',
    'useSupertrend',
    'stPeriod',
    'stMultiplier',
    'useVwap',
    'useEma',
    'emaPeriod',
    'otmOnly',
    'maxSignalAge',
    'minPremium',
    'maxPremium',
    'minVolume',
    'minOi',
    'slPct',
    'trailStartPct',
    'trailStepPts',
    'trailByPts',
    'targetPct',
    'recoveryExit',
    'entryStart',
    'entryEnd',
    'eodExit',
    'engineActive',
  ]);

  const extraFields = fields.filter((f) => !handledKeys.has(f.key));

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-oncolor-dark/70 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Strategy rules"
        className="flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-6 text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10">
              <Sliders className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold tracking-tight text-white">Strategy &amp; Risk Rules</h2>
              <p className="text-[10px] text-zinc-500">{title} · saved to ledger, used by Live and Backtest</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close rules"
            className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Form Body: Standardized Card Sections Template */}
        <div className="mt-5 flex flex-col gap-5 text-xs">
          {/* Card 1: Execution Mode */}
          <SectionCard title="Execution Mode">
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-zinc-400">Order Dispatch Mode</span>
              <span
                className={cn(
                  'rounded px-2 py-0.5 text-[10px] font-extrabold uppercase',
                  mode === 'REAL'
                    ? 'border border-red-500/30 bg-red-500/20 text-red-400'
                    : 'border border-emerald-500/30 bg-emerald-500/20 text-emerald-400',
                )}
              >
                {mode === 'REAL' ? 'REAL MONEY ARMED' : 'SIMULATED PAPER'}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onSetMode('SIM')}
                className={cn(
                  'rounded-lg border py-1.5 text-xs font-bold transition',
                  mode === 'SIM'
                    ? 'border-emerald-500/50 bg-emerald-600/20 text-emerald-300 shadow-sm'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white',
                )}
              >
                SIM (Virtual Paper)
              </button>
              <button
                type="button"
                disabled={!realAllowed}
                title={realAllowed ? undefined : 'REAL orders are limited to Dhan and Kotak'}
                onClick={() => {
                  if (confirm('Enable REAL live orders? Real trades will be submitted to the broker!')) {
                    onSetMode('REAL');
                  }
                }}
                className={cn(
                  'rounded-lg border py-1.5 text-xs font-bold transition disabled:cursor-not-allowed disabled:opacity-50',
                  mode === 'REAL'
                    ? 'border-red-500/50 bg-red-600/20 text-red-300 shadow-sm'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white',
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
                className="mt-1 flex items-center justify-center gap-1.5 text-[11px] font-medium text-zinc-400 transition hover:text-red-400"
              >
                <RefreshCcw className="h-3 w-3" />
                <span>Reset SIM Paper Trades</span>
              </button>
            )}
          </SectionCard>

          {/* Card 2: Market Direction / Trend Filter (if supported by strategy) */}
          {has('trendMode') && (
            <SectionCard
              title="Market Direction Filter"
              description="Separates trade entries from market bias using index trend evaluation computed on the candle timeframe below:"
            >
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => onPatch({ trendMode: 'AUTO' })}
                  className={cn(
                    'rounded-lg border p-2 text-left text-xs transition',
                    trendMode === 'AUTO'
                      ? 'border-emerald-500/40 bg-emerald-600/20 text-emerald-300'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white',
                  )}
                >
                  <div className="font-bold">AUTO Trend Filter</div>
                  <div className="mt-0.5 text-[10px] text-zinc-400">Trend directional bias: bull vs bear</div>
                </button>

                <button
                  type="button"
                  onClick={() => onPatch({ trendMode: 'BYPASS' })}
                  className={cn(
                    'rounded-lg border p-2 text-left text-xs transition',
                    trendMode === 'BYPASS'
                      ? 'border-sky-500/40 bg-sky-600/20 text-sky-300'
                      : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white',
                  )}
                >
                  <div className="font-bold">BYPASS Filter</div>
                  <div className="mt-0.5 text-[10px] text-zinc-400">Allow both CE &amp; PE entries</div>
                </button>
              </div>

              {/* Index EMA Cross toggle if strategy has it */}
              {has('trendUseEma') && (
                <div className="flex flex-col gap-2 border-t border-zinc-800/60 pt-2.5">
                  <label className="flex cursor-pointer items-center justify-between">
                    <div>
                      <span className="font-medium text-zinc-300">Index EMA Cross</span>
                      <p className="text-[10px] text-zinc-500">Bull when fast &gt; slow, bear when fast &lt; slow</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={trendUseEma}
                      onChange={(e) => onPatch({ trendUseEma: e.target.checked })}
                      aria-label="Use index EMA cross in the trend filter"
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                    />
                  </label>
                  {trendUseEma && (
                    <div className="flex items-center justify-between border-l-2 border-zinc-800 pl-3">
                      <span className="text-[11px] text-zinc-400">Periods</span>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[11px] text-zinc-400">Fast</span>
                        <RuleNumInput
                          value={trendEmaFast}
                          onCommit={(v) =>
                            onPatch({
                              trendEmaFast: Math.max(2, Math.min(trendEmaSlow - 1, Math.round(Number(v) || trendEmaFast))),
                            })
                          }
                          step={1}
                          min={2}
                          max={trendEmaSlow - 1}
                          className="w-14 text-center"
                        />
                        <span className="text-[11px] text-zinc-400">Slow</span>
                        <RuleNumInput
                          value={trendEmaSlow}
                          onCommit={(v) =>
                            onPatch({
                              trendEmaSlow: Math.max(trendEmaFast + 1, Math.min(200, Math.round(Number(v) || trendEmaSlow))),
                            })
                          }
                          step={1}
                          min={trendEmaFast + 1}
                          max={200}
                          className="w-14 text-center"
                        />
                      </div>
                    </div>
                  )}

                  {/* Index Supertrend toggle if strategy has it */}
                  {has('trendUseSupertrend') && (
                    <>
                      <label className="flex cursor-pointer items-center justify-between">
                        <div>
                          <span className="font-medium text-zinc-300">Index Supertrend</span>
                          <p className="text-[10px] text-zinc-500">Confirmed direction · off by default</p>
                        </div>
                        <input
                          type="checkbox"
                          checked={trendUseSupertrend}
                          onChange={(e) => onPatch({ trendUseSupertrend: e.target.checked })}
                          aria-label="Use index Supertrend in the trend filter"
                          className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                        />
                      </label>
                      {trendUseSupertrend && (
                        <div className="grid grid-cols-2 gap-2 border-l-2 border-zinc-800 pl-3">
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] text-zinc-400">ATR Period</span>
                            <RuleNumInput
                              value={trendStPeriod}
                              onCommit={(v) =>
                                onPatch({ trendStPeriod: Math.max(2, Math.min(50, Math.round(Number(v) || trendStPeriod))) })
                              }
                              step={1}
                              min={2}
                              max={50}
                              className="w-14 text-center"
                            />
                          </div>
                          <div className="flex items-center justify-between gap-1">
                            <span className="text-[11px] text-zinc-400">Multiplier</span>
                            <RuleNumInput
                              value={trendStMultiplier}
                              onCommit={(v) =>
                                onPatch({ trendStMultiplier: Math.max(0.5, Math.min(10, Number(v) || trendStMultiplier)) })
                              }
                              step={0.1}
                              min={0.5}
                              max={10}
                              className="w-14 text-center"
                            />
                          </div>
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </SectionCard>
          )}

          {/* Card 3: Scanner & Timeframe */}
          <SectionCard title="Scanner &amp; Timeframe">
            <FieldRow label="Candle Timeframe" sublabel="Indicator calculation bucket">
              <div className="flex items-center gap-1 rounded-md border border-zinc-800 bg-zinc-950 p-0.5">
                {[1, 3, 5].map((interval) => (
                  <button
                    key={interval}
                    type="button"
                    onClick={() => onPatch({ timeframe: interval })}
                    className={cn(
                      'rounded px-2.5 py-0.5 text-xs font-bold transition',
                      tf === interval ? 'bg-zinc-800 text-white' : 'text-zinc-500 hover:text-zinc-200',
                    )}
                  >
                    {interval}m
                  </button>
                ))}
              </div>
            </FieldRow>

            <FieldRow label="Strike Scan Window" sublabel="ATM ± N strikes (e.g. ±6 = 26 contracts)">
              <RuleNumInput
                value={strikeWindow}
                onCommit={(v) => onPatch({ strikeWindow: Math.max(2, Math.min(10, Number(v) || 6)) })}
                step={1}
                min={2}
                max={10}
                className="w-16 text-center"
              />
            </FieldRow>

            <FieldRow label="Lots Per Trade" sublabel="Contract lots sized per entry signal">
              <RuleNumInput
                value={lotsPerTrade}
                onCommit={(v) => onPatch({ lotsPerTrade: Math.max(1, Math.min(20, Number(v) || 1)) })}
                step={1}
                min={1}
                max={20}
                className="w-16 text-center"
              />
            </FieldRow>

            {/* Optional scanner threshold filters */}
            {has('minPremium') && (
              <FieldRow label="Min Premium" sublabel="Skip contracts priced below this floor" borderTop>
                <div className="flex items-center gap-1">
                  <span className="font-mono text-zinc-500">₹</span>
                  <RuleNumInput
                    value={Number(config.minPremium ?? 20)}
                    onCommit={(v) => onPatch({ minPremium: Math.max(1, Number(v) || 20) })}
                    step={5}
                    min={1}
                    className="w-16 text-center"
                  />
                </div>
              </FieldRow>
            )}

            {has('maxPremium') && (
              <FieldRow label="Max Premium" sublabel="Skip contracts priced above this ceiling">
                <div className="flex items-center gap-1">
                  <span className="font-mono text-zinc-500">₹</span>
                  <RuleNumInput
                    value={Number(config.maxPremium ?? 300)}
                    onCommit={(v) => onPatch({ maxPremium: Math.max(10, Number(v) || 300) })}
                    step={10}
                    min={10}
                    className="w-16 text-center"
                  />
                </div>
              </FieldRow>
            )}

            {has('otmOnly') && (
              <label className="flex cursor-pointer items-center justify-between py-1">
                <div>
                  <span className="font-medium text-zinc-300">OTM options only</span>
                  <p className="text-[10px] text-zinc-500">Check only OTM calls (strike above spot) and OTM puts (strike below spot); ATM/ITM blocked</p>
                </div>
                <input
                  type="checkbox"
                  checked={Boolean(config.otmOnly)}
                  onChange={(e) => onPatch({ otmOnly: e.target.checked })}
                  aria-label="Sell OTM options only"
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                />
              </label>
            )}

            {has('maxSignalAge') && (
              <FieldRow label="Max Signal Age" sublabel="Max bars elapsed since trigger confirmation">
                <div className="flex items-center gap-1">
                  <RuleNumInput
                    value={Number(config.maxSignalAge ?? 2)}
                    onCommit={(v) => onPatch({ maxSignalAge: Math.max(1, Math.min(10, Math.round(Number(v) || 2))) })}
                    step={1}
                    min={1}
                    max={10}
                    className="w-16 text-center"
                  />
                  <span className="text-zinc-500">bars</span>
                </div>
              </FieldRow>
            )}

            {has('minVolume') && (
              <FieldRow label="Min Volume" sublabel="Minimum traded contract volume threshold">
                <RuleNumInput
                  value={Number(config.minVolume ?? 1000)}
                  onCommit={(v) => onPatch({ minVolume: Math.max(0, Number(v) || 0) })}
                  step={500}
                  min={0}
                  className="w-20 text-center"
                />
              </FieldRow>
            )}

            {has('minOi') && (
              <FieldRow label="Min Open Interest" sublabel="Minimum open interest threshold">
                <RuleNumInput
                  value={Number(config.minOi ?? 5000)}
                  onCommit={(v) => onPatch({ minOi: Math.max(0, Number(v) || 0) })}
                  step={1000}
                  min={0}
                  className="w-20 text-center"
                />
              </FieldRow>
            )}
          </SectionCard>

          {/* Card 4: Option Chart Indicators / Setup */}
          {(has('useSupertrend') || has('useVwap') || has('useEma') || has('emaPeriod')) && (
            <SectionCard
              title="Option Chart Indicators"
              description="Configure indicator parameters required for entry signal confirmation on option candles:"
            >
              {has('useSupertrend') && (
                <div className="flex flex-col gap-1.5 py-1">
                  <label className="flex cursor-pointer items-center justify-between">
                    <div>
                      <span className="font-medium text-zinc-300">Supertrend</span>
                      <p className="text-[10px] text-zinc-500">Trailing volatility trend band</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={useSupertrend}
                      onChange={(e) => onPatch({ useSupertrend: e.target.checked })}
                      aria-label="Use Supertrend indicator"
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                    />
                  </label>
                  {useSupertrend && (
                    <div className="grid grid-cols-2 gap-2 border-l-2 border-zinc-800 pl-3 pt-1">
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] text-zinc-400">ATR Period</span>
                        <RuleNumInput
                          value={stPeriod}
                          onCommit={(v) => onPatch({ stPeriod: Math.max(2, Math.min(50, Math.round(Number(v) || 7))) })}
                          step={1}
                          min={2}
                          max={50}
                          className="w-14 text-center"
                        />
                      </div>
                      <div className="flex items-center justify-between gap-1">
                        <span className="text-[11px] text-zinc-400">Multiplier</span>
                        <RuleNumInput
                          value={stMultiplier}
                          onCommit={(v) => onPatch({ stMultiplier: Math.max(0.5, Math.min(10.0, Number(v) || 1.5)) })}
                          step={0.1}
                          min={0.5}
                          max={10.0}
                          className="w-14 text-center"
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {has('useVwap') && (
                <label className="flex cursor-pointer items-center justify-between border-t border-zinc-800/60 py-1">
                  <div>
                    <span className="font-medium text-zinc-300">Session VWAP</span>
                    <p className="text-[10px] text-zinc-500">Volume-Weighted Average Price benchmark</p>
                  </div>
                  <input
                    type="checkbox"
                    checked={useVwap}
                    onChange={(e) => onPatch({ useVwap: e.target.checked })}
                    aria-label="Use VWAP indicator"
                    className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                  />
                </label>
              )}

              {has('useEma') && (
                <div className="flex flex-col gap-1.5 border-t border-zinc-800/60 py-1">
                  <label className="flex cursor-pointer items-center justify-between">
                    <div>
                      <span className="font-medium text-zinc-300">EMA</span>
                      <p className="text-[10px] text-zinc-500">Exponential Moving Average support</p>
                    </div>
                    <input
                      type="checkbox"
                      checked={useEma}
                      onChange={(e) => onPatch({ useEma: e.target.checked })}
                      aria-label="Use EMA indicator"
                      className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                    />
                  </label>
                  {useEma && (
                    <div className="flex items-center justify-between border-l-2 border-zinc-800 pl-3 pt-1">
                      <span className="text-[11px] text-zinc-400">EMA Period</span>
                      <RuleNumInput
                        value={emaPeriod}
                        onCommit={(v) => onPatch({ emaPeriod: Math.max(3, Math.min(200, Math.round(Number(v) || 20))) })}
                        step={1}
                        min={3}
                        max={200}
                        className="w-14 text-center"
                      />
                    </div>
                  )}
                </div>
              )}

              {!has('useEma') && has('emaPeriod') && (
                <FieldRow label="Option EMA Period" sublabel="Exponential Moving Average candle period" borderTop={has('useVwap')}>
                  <RuleNumInput
                    value={emaPeriod}
                    onCommit={(v) => onPatch({ emaPeriod: Math.max(3, Math.min(200, Math.round(Number(v) || 20))) })}
                    step={1}
                    min={3}
                    max={200}
                    className="w-16 text-center"
                  />
                </FieldRow>
              )}
            </SectionCard>
          )}

          {/* Card 5: Portfolio & Risk Limits */}
          <SectionCard title="Portfolio &amp; Risk Limits">
            <FieldRow label="Max Concurrent Positions" sublabel="Hard cap on open active trades">
              <RuleNumInput
                value={maxConcurrent}
                onCommit={(v) => onPatch({ maxConcurrent: Math.max(1, Math.min(5, Number(v) || 2)) })}
                step={1}
                min={1}
                max={5}
                className="w-16 text-center"
              />
            </FieldRow>

            <FieldRow label="Max Same-Side Positions" sublabel="Max concurrent CE or PE legs">
              <RuleNumInput
                value={maxSameSide}
                onCommit={(v) => onPatch({ maxSameSide: Math.max(1, Math.min(3, Number(v) || 1)) })}
                step={1}
                min={1}
                max={3}
                className="w-16 text-center"
              />
            </FieldRow>

            <FieldRow label="Daily Loss Limit (₹)" sublabel="Halt auto-trading once loss limit is reached">
              <RuleNumInput
                value={dailyLossLimit}
                onCommit={(v) => onPatch({ dailyLossLimit: Math.max(500, Number(v) || 5000) })}
                step={500}
                min={500}
                className="w-24 text-right"
              />
            </FieldRow>

            <div className="flex items-center justify-between border-t border-zinc-800/60 pt-2">
              <div>
                <span className="font-medium text-zinc-300">Hard Circuit Breaker</span>
                <p className="text-[10px] text-zinc-500">Emergency square off all open positions when daily loss limit is hit</p>
              </div>
              <input
                type="checkbox"
                checked={hardCircuitBreaker}
                onChange={(e) => onPatch({ hardCircuitBreaker: e.target.checked })}
                aria-label="Hard Circuit Breaker: emergency square off on daily loss limit"
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
              />
            </div>
          </SectionCard>

          {/* Card 6: Brokerage & Execution Fees */}
          <SectionCard title="Brokerage &amp; Execution Fees">
            <FieldRow label="Brokerage per Order (₹)" sublabel="₹20 for Dhan / Zerodha · ₹0 for Kotak Trade Free">
              <div className="flex items-center gap-1">
                <span className="font-mono text-zinc-500">₹</span>
                <RuleNumInput
                  value={brokerage}
                  onCommit={(v) => onPatch({ brokerage: Math.max(0, Math.min(100, Number(v) || 0)) })}
                  step={5}
                  min={0}
                  max={100}
                  className="w-16 text-center"
                />
              </div>
            </FieldRow>

            {has('dataSource') && (
              <FieldRow label="Backtest Data Source" sublabel="Backtest only · change then Re-run">
                <select
                  value={dataSource}
                  onChange={(e) => onPatch({ dataSource: e.target.value === 'breeze' ? 'breeze' : 'dhan' })}
                  aria-label="Backtest data source"
                  className="rounded border border-zinc-700 bg-zinc-900 px-2 py-1 text-xs text-zinc-200 focus:ring-emerald-500"
                >
                  <option value="dhan">Dhan DB</option>
                  <option value="breeze">ICICI Breeze DB</option>
                </select>
              </FieldRow>
            )}

            <FieldRow label="Backtest Slippage (pts)" sublabel="Per fill · 0 = exact trigger execution">
              <RuleNumInput
                value={slippagePts}
                onCommit={(v) => onPatch({ slippagePts: Math.max(0, Math.min(10, Number(v) || 0)) })}
                step={0.05}
                min={0}
                max={10}
                className="w-16 text-center"
              />
            </FieldRow>

            <div className="flex items-center justify-between border-t border-zinc-800/60 pt-2">
              <div>
                <span className="font-medium text-zinc-300">Backtest: Skip Cold Contracts</span>
                <p className="text-[10px] text-zinc-500">Skip strikes with insufficient prior-session seeding</p>
              </div>
              <input
                type="checkbox"
                checked={btWarmOnly}
                onChange={(e) => onPatch({ btWarmOnly: e.target.checked })}
                aria-label="Backtest: skip cold contracts"
                className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
              />
            </div>

            <div className="flex items-center gap-2 border-t border-zinc-800/60 pt-2">
              <button
                type="button"
                onClick={() => onPatch({ brokerage: 20 })}
                className={cn(
                  'flex-1 rounded border py-1 text-[11px] font-bold transition',
                  brokerage === 20
                    ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white',
                )}
              >
                Dhan / Std (₹20)
              </button>
              <button
                type="button"
                onClick={() => onPatch({ brokerage: 0 })}
                className={cn(
                  'flex-1 rounded border py-1 text-[11px] font-bold transition',
                  brokerage === 0
                    ? 'border-emerald-500/50 bg-emerald-500/20 text-emerald-300'
                    : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-white',
                )}
              >
                Kotak Neo (₹0)
              </button>
            </div>
          </SectionCard>

          {/* Card 7: Stop-Loss & Profit Exits */}
          <SectionCard title="Stop-Loss &amp; Profit Exits">
            <FieldRow label="Initial Stop-Loss %" sublabel="Max risk percentage above/below entry price">
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={slPct}
                  onCommit={(v) => onPatch({ slPct: Math.max(5, Math.min(100, Number(v) || 20)) })}
                  step={5}
                  min={5}
                  max={100}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">%</span>
              </div>
            </FieldRow>

            <FieldRow label="Lock &amp; Trail Trigger %" sublabel="At this profit %, lock stop to cost and trail">
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={trailStartPct}
                  onCommit={(v) => onPatch({ trailStartPct: Math.max(5, Math.min(100, Number(v) || 15)) })}
                  step={1}
                  min={5}
                  max={100}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">%</span>
              </div>
            </FieldRow>

            <FieldRow label="Trail Step (x pts)" sublabel="Gain increment required for each stop ratchet">
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={trailStepPts}
                  onCommit={(v) => onPatch({ trailStepPts: Math.max(0.5, Math.min(50, Number(v) || 2)) })}
                  step={0.5}
                  min={0.5}
                  max={50}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">pts</span>
              </div>
            </FieldRow>

            <FieldRow label="Trail By (y pts)" sublabel="Amount to tighten stop-loss at each step">
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={trailByPts}
                  onCommit={(v) => onPatch({ trailByPts: Math.max(0.5, Math.min(50, Number(v) || 1)) })}
                  step={0.5}
                  min={0.5}
                  max={50}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">pts</span>
              </div>
            </FieldRow>

            <FieldRow label="Target Profit %" sublabel="Take profit target threshold (0 = off)">
              <div className="flex items-center gap-1">
                <RuleNumInput
                  value={targetPct}
                  onCommit={(v) => onPatch({ targetPct: Math.max(0, Math.min(200, Number(v) || 35)) })}
                  step={5}
                  min={0}
                  max={200}
                  className="w-16 text-center"
                />
                <span className="text-zinc-500">%</span>
              </div>
            </FieldRow>

            {has('recoveryExit') && (
              <div className="flex items-center justify-between border-t border-zinc-800/60 pt-2">
                <div>
                  <span className="font-medium text-zinc-300">Indicator Recovery Exit</span>
                  <p className="text-[10px] text-zinc-500">Close position if candle closes back across support/resistance</p>
                </div>
                <input
                  type="checkbox"
                  checked={recoveryExit}
                  onChange={(e) => onPatch({ recoveryExit: e.target.checked })}
                  aria-label="Indicator Recovery Exit"
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                />
              </div>
            )}
          </SectionCard>

          {/* Card 8: Trading Hours (IST) */}
          <SectionCard title="Trading Hours (IST)">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <span className="text-[10px] text-zinc-400">Entry Window Start</span>
                <TimeInput
                  value={entryStart}
                  onCommit={(v) => onPatch({ entryStart: v })}
                  placeholder="09:30"
                  ariaLabel="Entry Window Start"
                />
              </div>

              <div>
                <span className="text-[10px] text-zinc-400">Entry Window End</span>
                <TimeInput
                  value={entryEnd}
                  onCommit={(v) => onPatch({ entryEnd: v })}
                  placeholder="15:00"
                  ariaLabel="Entry Window End"
                />
              </div>
            </div>

            <div>
              <span className="text-[10px] text-zinc-400">Mandatory EOD Exit Cutoff</span>
              <TimeInput
                value={eodExit}
                onCommit={(v) => onPatch({ eodExit: v })}
                placeholder="15:15"
                ariaLabel="Mandatory EOD Exit Cutoff"
              />
            </div>
          </SectionCard>

          {/* Card 9: Extra strategy-specific parameters (if any) */}
          {extraFields.length > 0 && (
            <SectionCard title="Custom Strategy Parameters">
              <div className="grid grid-cols-2 gap-3">
                {extraFields.map((f) => {
                  const val = config[f.key];
                  return (
                    <div key={f.key} className="flex flex-col gap-1" title={f.help}>
                      <span className="flex items-center justify-between gap-1 text-[11px] text-zinc-300">
                        <span>
                          {f.label}
                          {f.kind === 'number' && f.unit ? <span className="text-zinc-500"> ({f.unit})</span> : null}
                        </span>
                        {f.backtestOnly && (
                          <span className="rounded bg-violet-500/10 px-1 text-[9px] font-bold text-violet-400">BT</span>
                        )}
                      </span>
                      {f.kind === 'number' ? (
                        <RuleNumInput
                          value={Number(val)}
                          step={f.step ?? (f.integer ? 1 : undefined)}
                          min={f.min}
                          max={f.max}
                          label={f.label}
                          onCommit={(v) => onPatch({ [f.key]: Number(v) })}
                          className="w-full text-center"
                        />
                      ) : f.kind === 'time' ? (
                        <TimeInput value={String(val)} onCommit={(t) => onPatch({ [f.key]: t })} ariaLabel={f.label} />
                      ) : f.kind === 'boolean' ? (
                        <label className="flex cursor-pointer items-center justify-between py-1">
                          <span className="text-[11px] text-zinc-300">{f.label}</span>
                          <input
                            type="checkbox"
                            checked={Boolean(val)}
                            onChange={(e) => onPatch({ [f.key]: e.target.checked })}
                            aria-label={f.label}
                            className="h-4 w-4 rounded border-zinc-700 bg-zinc-900 text-emerald-500 focus:ring-emerald-500"
                          />
                        </label>
                      ) : (
                        <select
                          aria-label={f.label}
                          value={String(val)}
                          onChange={(e) => {
                            const opt = f.options.find((o) => String(o.value) === e.target.value);
                            if (opt) onPatch({ [f.key]: opt.value });
                          }}
                          className="h-7 w-full rounded border border-zinc-800 bg-zinc-950 px-2 text-xs text-white focus:outline-none"
                        >
                          {f.options.map((o) => (
                            <option key={String(o.value)} value={String(o.value)}>
                              {o.label}
                            </option>
                          ))}
                        </select>
                      )}
                    </div>
                  );
                })}
              </div>
            </SectionCard>
          )}
        </div>

        {/* Footer */}
        <div className="mt-auto flex justify-end border-t border-zinc-800 pt-4">
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
