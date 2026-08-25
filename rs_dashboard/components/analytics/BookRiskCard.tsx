'use client';

/**
 * Live book-risk tiles for the open positions on this page.
 *
 * Was "Kelly Criterion Live Sizing" — it also carried a day-level Kelly f*
 * box computed from the WHOLE F&O account's trade history (see
 * /api/options/kelly-stats), not from this underlying's book. That number
 * never fed a sizing decision on this page (there is no order-entry flow
 * here to size), needs 20+ days of history, mixes every strategy running on
 * the account, and already shipped with three separate caveats saying not to
 * treat it as a per-trade figure. It answered a question this page doesn't
 * ask. The three tiles below are the load-bearing, live numbers — dropped
 * the rest rather than keep a stat nobody could act on here.
 */

import React from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ExposureSummary } from '@/lib/positionLegs';

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
  capital: number | null;
  nav: number | null;
  stopMultiple: number;
}

export default function BookRiskCard({ exposure, capital, nav, stopMultiple }: Props) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h2 className="text-xs font-bold uppercase tracking-wider text-white">Book Risk</h2>
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
    </section>
  );
}
