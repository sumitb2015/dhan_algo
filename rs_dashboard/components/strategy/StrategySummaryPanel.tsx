'use client';

import { PayoffStats } from '@/lib/optionsStrategy';
import { Separator } from '@/components/ui/separator';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';

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
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number, spot: number): string {
  return `${((n - spot) / spot * 100).toFixed(1)}%`;
}

function TileLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11px] font-semibold uppercase tracking-wider text-zinc-500">{children}</div>
  );
}

export default function StrategySummaryPanel({
  stats, targetBreakevens, breakevenMode, onBreakevenModeChange, margin, marginLoading, spot,
}: StrategySummaryPanelProps) {
  const breakevens = breakevenMode === 'expiry' ? stats.breakevensExpiry : (targetBreakevens ?? []);
  const marginPct = margin && margin.total_margin > 0 && margin.available_funds > 0
    ? Math.min(100, (margin.total_margin / margin.available_funds) * 100)
    : null;
  const fundsShort = margin !== null && margin.total_margin > 0 && margin.available_funds < margin.total_margin;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Risk profile */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <div className="space-y-3">
          <div>
            <TileLabel>Max profit</TileLabel>
            <div className="mt-0.5 font-mono text-2xl font-bold tabular-nums text-emerald-400">
              {stats.maxProfit === 'Unlimited' ? 'Unlimited' : `+${fmtRupee(stats.maxProfit)}`}
            </div>
          </div>
          <Separator />
          <div>
            <TileLabel>Max loss</TileLabel>
            <div className="mt-0.5 font-mono text-2xl font-bold tabular-nums text-rose-400">
              {stats.maxLoss === 'Unlimited' ? 'Unlimited' : fmtRupee(stats.maxLoss)}
            </div>
          </div>
          <Separator />
          <div className="flex items-baseline justify-between">
            <TileLabel>Reward / risk</TileLabel>
            <span className="font-mono text-sm tabular-nums text-zinc-200">
              {stats.rewardRisk === null ? 'NA' : `1 / ${(1 / stats.rewardRisk).toFixed(1)}`}
            </span>
          </div>
          <div className="flex items-baseline justify-between">
            <TileLabel>Prob. of profit</TileLabel>
            <span className="font-mono text-sm tabular-nums text-zinc-200">
              {stats.popPct === null ? '—' : `${stats.popPct}%`}
            </span>
          </div>
        </div>
      </div>

      {/* Breakevens & premium composition */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <TileLabel>Breakeven</TileLabel>
            <ToggleGroup
              value={[breakevenMode]}
              onValueChange={(v: unknown[]) => {
                const next = v[v.length - 1] as 'target' | 'expiry' | undefined;
                if (next) onBreakevenModeChange(next);
              }}
              variant="outline"
              size="sm"
              spacing={0}
            >
              {(['target', 'expiry'] as const).map((m) => (
                <ToggleGroupItem
                  key={m}
                  value={m}
                  className="h-6 px-2 text-xs capitalize aria-pressed:bg-sky-500/15 aria-pressed:text-sky-400"
                >
                  {m}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          </div>
          {breakevenMode === 'target' && targetBreakevens === null ? (
            <div className="text-sm text-zinc-500">—</div>
          ) : breakevens.length === 0 ? (
            <div className="text-sm text-zinc-500">None</div>
          ) : (
            <div className="space-y-1">
              {breakevens.map((be) => (
                <div key={be} className="font-mono text-sm tabular-nums text-zinc-200">
                  {be.toFixed(0)} <span className="text-zinc-500">({fmtPct(be, spot)})</span>
                </div>
              ))}
            </div>
          )}
          <Separator />
          <div className="flex items-baseline justify-between">
            <TileLabel>Time value</TileLabel>
            <span className="font-mono text-sm tabular-nums text-zinc-200">{fmtRupee(stats.timeValue)}</span>
          </div>
          <div className="flex items-baseline justify-between">
            <TileLabel>Intrinsic value</TileLabel>
            <span className="font-mono text-sm tabular-nums text-zinc-200">{fmtRupee(stats.intrinsicValue)}</span>
          </div>
        </div>
      </div>

      {/* Funds & margin */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <div className="space-y-3">
          <TileLabel>Funds &amp; margins</TileLabel>
          {marginLoading ? (
            <div className="space-y-2 animate-pulse">
              <div className="h-4 w-28 rounded bg-zinc-800" />
              <div className="h-4 w-36 rounded bg-zinc-800" />
              <div className="h-1 w-full rounded bg-zinc-800" />
            </div>
          ) : margin === null ? (
            <div className="text-sm text-zinc-500">—</div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-zinc-500">Margin required</span>
                <span className={cn('font-mono text-sm font-semibold tabular-nums', margin.total_margin > 0 ? 'text-amber-300' : 'text-zinc-500')}>
                  {margin.total_margin > 0 ? fmtRupee(margin.total_margin) : '— (market closed)'}
                </span>
              </div>
              {margin.hedge_benefit > 0 && (
                <div className="flex items-baseline justify-between">
                  <span className="text-xs text-zinc-500">Hedge benefit</span>
                  <span className="font-mono text-sm tabular-nums text-emerald-400">−{fmtRupee(margin.hedge_benefit)}</span>
                </div>
              )}
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-zinc-500">Funds available</span>
                <span className={cn('font-mono text-sm font-semibold tabular-nums', fundsShort ? 'text-rose-400' : 'text-emerald-400')}>
                  {fmtRupee(margin.available_funds)}
                </span>
              </div>
              {marginPct !== null && (
                <div className="space-y-1.5">
                  <Progress
                    value={marginPct}
                    className={cn(
                      '**:data-[slot=progress-indicator]:transition-none',
                      fundsShort
                        ? '**:data-[slot=progress-indicator]:bg-rose-500'
                        : marginPct > 70
                          ? '**:data-[slot=progress-indicator]:bg-amber-500'
                          : '**:data-[slot=progress-indicator]:bg-emerald-500',
                    )}
                  />
                  <div className="text-[11px] text-zinc-500">
                    {marginPct.toFixed(0)}% of available funds used
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
