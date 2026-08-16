'use client';

import React from 'react';
import { cn } from '@/lib/utils';
import type { PayoffStats } from '@/lib/optionsStrategy';

function fmtInr(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export function StatChip({
  label, value, sub, color, title,
}: {
  label: string; value: React.ReactNode; sub?: string; color?: string; title?: string;
}) {
  return (
    <div className="flex min-w-[104px] flex-col border-r border-zinc-800 px-4 last:border-r-0" title={title}>
      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">{label}</span>
      <span className={cn('font-mono text-sm font-bold tabular-nums', color ?? 'text-zinc-100')}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-500">{sub}</span>}
    </div>
  );
}

interface Props {
  stats: PayoffStats;
  lotSize: number;
  standaloneMargin: number | null;
  /** Why standaloneMargin is null, when it's a known limitation rather than a fetch failure. */
  standaloneMarginReason?: string | null;
  marginAvailable: number | null;
}

export default function PayoffMetricStrip({
  stats, lotSize, standaloneMargin, standaloneMarginReason, marginAvailable,
}: Props) {
  const unlimited = stats.maxLoss === 'Unlimited';

  const rangeLabel = `${Math.round(stats.rangeLo).toLocaleString('en-IN')}–${Math.round(stats.rangeHi).toLocaleString('en-IN')}`;

  return (
    <div className="flex flex-wrap items-center gap-y-3 rounded-xl border border-zinc-800 bg-zinc-900 px-2 py-3">
      <StatChip
        label="Max Profit"
        value={stats.maxProfit === 'Unlimited' ? 'Unlimited' : fmtInr(stats.maxProfit)}
        color="text-emerald-400"
      />

      {/*
        An unlimited-loss book has no max loss. Showing the in-range figure bare
        would read as a floor and understate a naked short without bound, so the
        window it was measured over is part of the value, not a footnote.
      */}
      <StatChip
        label="Max Loss"
        value={unlimited ? 'Unlimited' : fmtInr(stats.maxLoss as number)}
        sub={unlimited ? `${fmtInr(stats.maxLossInRange)} within ${rangeLabel}` : undefined}
        color={unlimited ? 'text-rose-400' : 'text-red-400'}
        title={unlimited
          ? `Loss is unbounded. Within the plotted range ${rangeLabel} the worst outcome is ${fmtInr(stats.maxLossInRange)} at ${Math.round(stats.maxLossAtSpot).toLocaleString('en-IN')}. Zoom out to widen the window.`
          : undefined}
      />

      <StatChip
        label="Reward : Risk"
        value={stats.rewardRisk === null ? '—' : `${stats.rewardRisk.toFixed(2)} : 1`}
        sub={stats.rewardRisk === null && unlimited ? 'undefined — risk unbounded' : undefined}
      />

      <StatChip
        label="POP"
        value={stats.popPct === null ? '—' : `${stats.popPct}%`}
        sub={stats.popPct === null ? 'needs IV' : undefined}
        title="Probability of profit at expiry, integrating the risk-neutral lognormal distribution over each profitable zone between breakevens."
      />

      <StatChip label="Time Value" value={fmtInr(stats.timeValue)} />
      <StatChip label="Intrinsic Value" value={fmtInr(stats.intrinsicValue)} />

      <StatChip
        label="Breakeven"
        value={stats.breakevensExpiry.length
          ? stats.breakevensExpiry.map((b) => Math.round(b).toLocaleString('en-IN')).join(', ')
          : '—'}
        color="text-amber-400"
      />

      <StatChip
        label="Net Premium"
        value={`${stats.netPremium >= 0 ? 'Cr' : 'Db'} ${fmtInr(Math.abs(stats.netPremium))}`}
        color={stats.netPremium >= 0 ? 'text-emerald-400' : 'text-red-400'}
        title={`Lot size ${lotSize}. Credit is positive, debit negative.`}
      />

      <StatChip
        label="Standalone Margin"
        value={standaloneMargin === null ? '—' : fmtInr(standaloneMargin)}
        sub={standaloneMargin === null ? standaloneMarginReason ?? undefined : undefined}
        title={standaloneMargin === null ? standaloneMarginReason ?? undefined : undefined}
      />

      <StatChip
        label="Margin Available"
        value={marginAvailable === null ? '—' : fmtInr(marginAvailable)}
        color={marginAvailable !== null && marginAvailable < 0 ? 'text-red-400' : 'text-zinc-100'}
      />
    </div>
  );
}
