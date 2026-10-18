'use client';

import { X, Sliders, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { AlgoConfig, ConfigField, ConfigValue, LedgerMode } from '@/lib/algoLab/types';
import { NumInput, TimeInput } from './RuleInputs';

/** The rules drawer, generated from the strategy's settings schema (base fields + its own). */
export function RulesDrawer({
  open,
  onClose,
  title,
  fields,
  config,
  defaults,
  mode,
  realAllowed,
  onPatch,
  onSetMode,
  onResetSim,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  fields: ConfigField[];
  config: AlgoConfig;
  defaults: AlgoConfig;
  mode: LedgerMode;
  realAllowed: boolean;
  onPatch: (patch: Record<string, ConfigValue>) => void;
  onSetMode: (m: LedgerMode) => void;
  onResetSim: () => void;
}) {
  if (!open) return null;
  const groups = [...new Set(fields.map((f) => f.group))];

  const control = (f: ConfigField) => {
    const v = config[f.key];
    switch (f.kind) {
      case 'number':
        return <NumInput label={f.label} value={Number(v)} step={f.step ?? (f.integer ? 1 : undefined)} onCommit={(n) => onPatch({ [f.key]: n })} />;
      case 'time':
        return <TimeInput label={f.label} value={String(v)} onCommit={(t) => onPatch({ [f.key]: t })} />;
      case 'boolean':
        return (
          <button
            type="button"
            role="switch"
            aria-checked={!!v}
            aria-label={f.label}
            onClick={() => onPatch({ [f.key]: !v })}
            className={cn(
              'h-7 w-full rounded border text-xs font-bold',
              v ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400' : 'border-zinc-800 bg-zinc-950 text-zinc-400',
            )}
          >
            {v ? 'On' : 'Off'}
          </button>
        );
      case 'select':
        return (
          <select
            aria-label={f.label}
            value={String(v)}
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
        );
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-oncolor-dark/70 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Strategy rules"
        className="flex h-full w-full max-w-lg flex-col overflow-y-auto border-l border-zinc-800 bg-zinc-950 p-6 text-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-zinc-800 pb-4">
          <div className="flex items-center gap-2.5">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg border border-emerald-500/25 bg-emerald-500/10">
              <Sliders className="h-4 w-4 text-emerald-400" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white">Strategy &amp; Risk Rules</h2>
              <p className="text-[11px] text-zinc-500">{title} · saved to the ledger, used by Live and Backtest</p>
            </div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close rules" className="rounded-lg p-1.5 text-zinc-400 hover:bg-zinc-900 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="mt-5 flex flex-col gap-5 text-xs">
          <div className="flex flex-col gap-2.5 rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5">
            <div className="flex items-center justify-between">
              <span className="font-bold text-zinc-200">Execution mode</span>
              <span
                className={cn(
                  'rounded border px-2 py-0.5 text-[10px] font-extrabold uppercase',
                  mode === 'REAL' ? 'border-red-500/30 bg-red-500/20 text-red-400' : 'border-emerald-500/30 bg-emerald-500/20 text-emerald-400',
                )}
              >
                {mode === 'REAL' ? 'REAL MONEY' : 'SIMULATED PAPER'}
              </span>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => onSetMode('SIM')}
                className={cn(
                  'rounded-lg border py-1.5 text-xs font-bold',
                  mode === 'SIM' ? 'border-emerald-500/50 bg-emerald-600/20 text-emerald-300' : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white',
                )}
              >
                SIM (paper)
              </button>
              <button
                type="button"
                disabled={!realAllowed}
                title={realAllowed ? undefined : 'REAL orders are limited to Dhan and Kotak'}
                onClick={() => {
                  if (confirm('Enable REAL orders for this strategy? The engine will send live orders to the broker.')) onSetMode('REAL');
                }}
                className={cn(
                  'rounded-lg border py-1.5 text-xs font-bold disabled:cursor-not-allowed disabled:opacity-50',
                  mode === 'REAL' ? 'border-red-500/50 bg-red-600/20 text-red-300' : 'border-zinc-700 bg-zinc-800 text-zinc-400 hover:text-white',
                )}
              >
                REAL (live orders)
              </button>
            </div>
          </div>

          {groups.map((g) => (
            <div key={g} className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3.5">
              <h3 className="mb-3 text-[11px] font-bold uppercase tracking-wider text-zinc-400">{g}</h3>
              <div className="grid grid-cols-2 gap-3">
                {fields
                  .filter((f) => f.group === g)
                  .map((f) => (
                    <label key={f.key} className="flex flex-col gap-1" title={f.help}>
                      <span className="flex items-center justify-between gap-1 text-[11px] text-zinc-300">
                        <span>
                          {f.label}
                          {f.kind === 'number' && f.unit ? <span className="text-zinc-500"> ({f.unit})</span> : null}
                        </span>
                        {f.backtestOnly && <span className="rounded bg-violet-500/10 px-1 text-[9px] font-bold text-violet-400">BT</span>}
                      </span>
                      {control(f)}
                      {f.kind === 'number' && (
                        <span className="text-[10px] text-zinc-500">
                          {f.min}–{f.max} · default {String(defaults[f.key])}
                        </span>
                      )}
                    </label>
                  ))}
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => {
              if (confirm('Clear all closed SIM rows of this strategy? Open rows are kept.')) onResetSim();
            }}
            className="flex items-center justify-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 py-2 text-xs font-bold text-zinc-400 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" /> Reset SIM history
          </button>
        </div>
      </div>
    </div>
  );
}
