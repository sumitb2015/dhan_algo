'use client';

import { PayoffStats } from '@/lib/optionsStrategy';

interface StrategySummaryPanelProps {
  stats: PayoffStats;
  targetBreakevens: number[] | null;
  breakevenMode: 'target' | 'expiry';
  onBreakevenModeChange: (m: 'target' | 'expiry') => void;
  margin: { total_margin: number; hedge_benefit: number; available_funds: number } | null;
  marginLoading: boolean;
  spot: number;
}

function fmtRupee(n: number): string {
  return `${n < 0 ? '-' : ''}${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number, spot: number): string {
  return `${((n - spot) / spot * 100).toFixed(1)}%`;
}

export default function StrategySummaryPanel({
  stats, targetBreakevens, breakevenMode, onBreakevenModeChange, margin, marginLoading, spot,
}: StrategySummaryPanelProps) {
  const breakevens = breakevenMode === 'expiry' ? stats.breakevensExpiry : (targetBreakevens ?? []);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="text-xs text-zinc-500 uppercase tracking-wide mb-1">Max Profit</div>
        <div className="text-xl font-bold text-emerald-400 tabular-nums">
          {stats.maxProfit === 'Unlimited' ? 'Unlimited' : `+${fmtRupee(stats.maxProfit)}`}
        </div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">Max Loss</div>
        <div className="text-xl font-bold text-rose-400 tabular-nums">
          {stats.maxLoss === 'Unlimited' ? 'Unlimited' : fmtRupee(stats.maxLoss)}
        </div>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs text-zinc-500 uppercase tracking-wide">Breakeven</span>
          <div className="flex rounded-md overflow-hidden border border-zinc-700 text-[10px]">
            {(['target', 'expiry'] as const).map((m) => (
              <button
                key={m}
                onClick={() => onBreakevenModeChange(m)}
                className={`px-2 py-0.5 font-medium capitalize ${
                  breakevenMode === m ? 'bg-sky-600 text-white' : 'bg-zinc-800 text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m}
              </button>
            ))}
          </div>
        </div>
        {breakevenMode === 'target' && targetBreakevens === null ? (
          <div className="text-sm text-zinc-500">—</div>
        ) : breakevens.length === 0 ? (
          <div className="text-sm text-zinc-500">None</div>
        ) : (
          <div className="space-y-1">
            {breakevens.map((be) => (
              <div key={be} className="text-sm text-zinc-200 tabular-nums">
                {be.toFixed(0)} <span className="text-zinc-500">({fmtPct(be, spot)})</span>
              </div>
            ))}
          </div>
        )}
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">Reward / Risk</div>
        <div className="text-sm text-zinc-200 tabular-nums">
          {stats.rewardRisk === null ? 'NA' : `1/${(1 / stats.rewardRisk).toFixed(1)}`}
        </div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">POP</div>
        <div className="text-sm text-zinc-200 tabular-nums">{stats.popPct === null ? '—' : `${stats.popPct}%`}</div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">Time Value</div>
        <div className="text-sm text-zinc-200 tabular-nums">{fmtRupee(stats.timeValue)}</div>
        <div className="text-xs text-zinc-500 uppercase tracking-wide mt-3 mb-1">Intrinsic Value</div>
        <div className="text-sm text-zinc-200 tabular-nums">{fmtRupee(stats.intrinsicValue)}</div>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="text-xs text-zinc-500 uppercase tracking-wide mb-2">Funds &amp; Margins</div>
        {marginLoading ? (
          <div className="text-sm text-zinc-500 animate-pulse">Loading…</div>
        ) : margin === null ? (
          <div className="text-sm text-zinc-500">—</div>
        ) : (
          <div className="space-y-2">
            <div>
              <div className="text-xs text-zinc-500">Margin Required</div>
              <div className={`text-sm font-semibold tabular-nums ${margin.total_margin > 0 ? 'text-amber-300' : 'text-zinc-400'}`}>
                {margin.total_margin > 0 ? fmtRupee(margin.total_margin) : <span className="text-xs">—  (market closed)</span>}
              </div>
            </div>
            {margin.hedge_benefit > 0 && (
              <div>
                <div className="text-xs text-zinc-500">Hedge Benefit</div>
                <div className="text-sm text-emerald-400 tabular-nums">−{fmtRupee(margin.hedge_benefit)}</div>
              </div>
            )}
            <div>
              <div className="text-xs text-zinc-500">Funds Available</div>
              <div className={`text-sm font-semibold tabular-nums ${
                margin.total_margin > 0 && margin.available_funds < margin.total_margin
                  ? 'text-rose-400'
                  : 'text-emerald-400'
              }`}>
                {fmtRupee(margin.available_funds)}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
