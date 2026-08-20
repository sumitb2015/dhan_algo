'use client';

import React from 'react';
import { AlertTriangle, Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { kellyFraction, type ExposureSummary } from '@/lib/positionLegs';
import type { KellyStats } from '@/app/api/options/kelly-stats/route';

function fmtInr(n: number): string {
  const abs = Math.abs(n);
  return `${n < 0 ? '-' : ''}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function Tile({
  label, value, sub, color, title,
}: {
  label: string; value: string; sub?: React.ReactNode; color?: string; title?: string;
}) {
  return (
    <div className="min-w-[180px] flex-1 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3" title={title}>
      <div className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">{label}</div>
      <div className={cn('mt-1 font-mono text-xl font-bold tabular-nums', color ?? 'text-zinc-100')}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-zinc-500">{sub}</div>}
    </div>
  );
}

interface Props {
  exposure: ExposureSummary;
  stats: KellyStats | null;
  capital: number | null;
  nav: number | null;
  stopMultiple: number;
}

export default function KellySizingCard({ exposure, stats, capital, nav, stopMultiple }: Props) {
  const f = stats?.available
    ? kellyFraction(stats.winRate ?? null, stats.payoffRatio ?? null)
    : null;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-white">Kelly Criterion Live Sizing</h2>
        {exposure.overAllocated && (
          <span className="ml-auto flex items-center gap-1.5 rounded-full border border-rose-700 bg-rose-950 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-rose-300">
            <AlertTriangle className="h-3 w-3" />
            Over-Allocated / High Concentration
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <Tile
          label="Live Assignment Exposure"
          value={fmtInr(exposure.assignmentExposure)}
          color={exposure.overAllocated ? 'text-rose-400' : 'text-zinc-100'}
          sub={exposure.exposurePctOfCapital === null
            ? 'capital unavailable'
            : `${exposure.exposurePctOfCapital.toFixed(1)}% of capital${capital ? ` (${fmtInr(capital)})` : ''}`}
          title="Strike × quantity summed over SHORT legs only — the cash a writer must be able to produce if every short finished in the money. Long wings are a right, not an obligation, so netting them here would understate the requirement."
        />
        <Tile
          label="Live Premium Collected"
          value={fmtInr(exposure.premiumCollected)}
          color={exposure.premiumCollected >= 0 ? 'text-emerald-400' : 'text-red-400'}
          sub={exposure.premiumCollected < 0 ? 'net debit book' : undefined}
        />
        <Tile
          label={`Managed Stop-Loss Risk (${stopMultiple}x)`}
          value={fmtInr(exposure.managedStopRisk)}
          color="text-amber-400"
          sub={exposure.stopRiskPctOfNav === null
            ? 'NAV unavailable'
            : `${exposure.stopRiskPctOfNav.toFixed(2)}% of NAV${nav ? ` (${fmtInr(nav)})` : ''}`}
          title={`The conventional exit-at-${stopMultiple}×-premium stop. This is what the book loses if every short is bought back at ${stopMultiple}× the credit — it is a discipline, not a guarantee, and a gap through the stop can cost more.`}
        />
      </div>

      {/* The actual Kelly fraction, kept visibly separate from the live exposure
          tiles because it rests on historical day-level data, not on this book. */}
      <div className="mt-3 rounded-lg border border-zinc-800 bg-zinc-900 px-4 py-3">
        {stats?.available && f !== null ? (
          <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
            <div>
              <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Kelly f*</span>
              <span className={cn(
                'ml-2 font-mono text-lg font-bold tabular-nums',
                f > 0 ? 'text-emerald-400' : 'text-rose-400',
              )}>
                {(f * 100).toFixed(1)}%
              </span>
              {f <= 0 && <span className="ml-2 text-[11px] text-rose-300">negative edge — history does not justify size</span>}
            </div>
            <div className="font-mono text-[11px] tabular-nums text-zinc-400">
              W {(stats.winRate! * 100).toFixed(1)}%
              <span className="mx-1.5 text-zinc-600">·</span>
              R {stats.payoffRatio!.toFixed(2)}
              <span className="mx-1.5 text-zinc-600">·</span>
              avg win {fmtInr(stats.avgWin!)}
              <span className="mx-1.5 text-zinc-600">·</span>
              avg loss {fmtInr(-stats.avgLoss!)}
              <span className="mx-1.5 text-zinc-600">·</span>
              {stats.days} days
            </div>
            {f > 0 && (
              <div className="font-mono text-[11px] tabular-nums text-zinc-400">
                Half-Kelly {(f * 50).toFixed(1)}%
                {capital ? <> → {fmtInr(capital * f * 0.5)}</> : null}
              </div>
            )}
          </div>
        ) : (
          <div className="text-[11px] text-zinc-500">
            Kelly f* unavailable — {stats?.reason ?? 'loading trade history…'}
          </div>
        )}

        <div className="mt-2 flex items-start gap-1.5 text-[10px] text-zinc-500">
          <Info className="mt-px h-3 w-3 shrink-0" />
          <span>
            {stats?.basis ?? 'Day-level net P&L, F&O segment'}
            {stats?.fromDate && stats?.toDate ? ` · ${stats.fromDate} → ${stats.toDate}` : ''}
            {' — '}
            a <strong className="text-zinc-400">day</strong>-level win rate across the whole F&amp;O book, not a
            per-trade one. Days mix strategies and are serially correlated, so treat f* as an upper bound and
            size below it.
          </span>
        </div>
      </div>
    </section>
  );
}
