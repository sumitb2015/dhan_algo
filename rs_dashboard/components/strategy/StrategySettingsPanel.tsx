'use client';

import { StrategyTemplate } from '@/lib/optionsStrategy';

interface StrategySettingsPanelProps {
  template: StrategyTemplate;
  params: Record<string, number>;
  onParamsChange: (params: Record<string, number>) => void;
  lots: number;
  onLotsChange: (lots: number) => void;
  mode: 'intraday' | 'positional';
  onModeChange: (mode: 'intraday' | 'positional') => void;
  expiryKindFilter: 'weekly' | 'monthly' | 'all';
  onExpiryKindFilterChange: (k: 'weekly' | 'monthly' | 'all') => void;
  expiries: { date: string; kind: 'weekly' | 'monthly' }[];
  selectedExpiry: string;
  onExpiryChange: (expiry: string) => void;
  onAnalyze: () => void;
  onSave: () => void;
  canSave: boolean;
  onEnterTrade: () => void;
  onExitTrade: () => void;
  canEnter: boolean;
  canExit: boolean;
  entering: boolean;
  exiting: boolean;
}

export default function StrategySettingsPanel({
  template, params, onParamsChange, lots, onLotsChange, mode, onModeChange,
  expiryKindFilter, onExpiryKindFilterChange, expiries, selectedExpiry, onExpiryChange,
  onAnalyze, onSave, canSave, onEnterTrade, onExitTrade, canEnter, canExit, entering, exiting,
}: StrategySettingsPanelProps) {
  const visibleExpiries = expiries.filter((e) => expiryKindFilter === 'all' || e.kind === expiryKindFilter);

  return (
    <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-md overflow-hidden border border-zinc-700 text-xs">
          {(['weekly', 'monthly', 'all'] as const).map((k) => (
            <button
              key={k}
              onClick={() => onExpiryKindFilterChange(k)}
              className={`px-3 py-1 font-medium capitalize ${
                expiryKindFilter === k ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
            >
              {k}
            </button>
          ))}
        </div>
        <select
          value={selectedExpiry}
          onChange={(e) => onExpiryChange(e.target.value)}
          className="bg-zinc-800 border border-zinc-700 rounded-md text-xs text-zinc-200 px-2 py-1"
        >
          {visibleExpiries.map((e) => (
            <option key={e.date} value={e.date}>{e.date} ({e.kind})</option>
          ))}
        </select>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        {template.params.map((p) => (
          <label key={p.key} className="flex flex-col gap-1 text-xs text-zinc-400">
            {p.label}
            <input
              type="number"
              min={p.min}
              max={p.max}
              step={p.step}
              value={params[p.key] ?? p.default}
              onChange={(e) => onParamsChange({ ...params, [p.key]: Number(e.target.value) })}
              className="bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-100 px-2 py-1 w-20"
            />
          </label>
        ))}

        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Lots
          <input
            type="number"
            min={1}
            step={1}
            value={lots || ''}
            onChange={(e) => {
              const val = e.target.value;
              if (val === '') {
                onLotsChange(0);
              } else {
                const parsed = parseInt(val, 10);
                onLotsChange(isNaN(parsed) ? 1 : parsed);
              }
            }}
            className="bg-zinc-800 border border-zinc-700 rounded-md text-sm text-zinc-100 px-2 py-1 w-20"
          />
        </label>

        <div className="flex flex-col gap-1 text-xs text-zinc-400">
          Mode
          <div className="flex rounded-md overflow-hidden border border-zinc-700">
            {(['intraday', 'positional'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onModeChange(m)}
                className={`px-3 py-1 text-xs font-medium capitalize ${
                  mode === m ? 'bg-emerald-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={onAnalyze}
          className="px-4 py-1.5 bg-sky-600 hover:bg-sky-500 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          Analyze
        </button>

        {mode === 'positional' && (
          <button
            onClick={onSave}
            disabled={!canSave}
            className="px-4 py-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-semibold rounded-lg transition-colors"
          >
            Save Strategy
          </button>
        )}

        <button
          onClick={onEnterTrade}
          disabled={!canEnter || entering || exiting}
          className="px-4 py-1.5 bg-orange-600 hover:bg-orange-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {entering ? 'Entering...' : 'Enter (Dhan)'}
        </button>

        <button
          onClick={onExitTrade}
          disabled={!canExit || entering || exiting}
          className="px-4 py-1.5 bg-rose-600 hover:bg-rose-500 disabled:bg-zinc-700 disabled:text-zinc-500 text-white text-sm font-semibold rounded-lg transition-colors"
        >
          {exiting ? 'Exiting...' : 'Exit (Dhan)'}
        </button>
      </div>
    </div>
  );
}
