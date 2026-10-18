'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, SlidersHorizontal, Lightbulb, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BreakdownConfig } from '@/lib/breakdownLedger';
import { OPTIMIZATION_REPORT as R, matchesCandidate, type OptStats } from '@/lib/breakdownOptimization';

const inr = (n: number) => `${n < 0 ? '−' : '+'}₹${(Math.abs(n) / 1000).toFixed(0)}k`;

function StatCell({ s }: { s: OptStats }) {
  return (
    <td className="px-2.5 py-1.5 font-mono text-[11px]">
      <span className={s.net >= 0 ? 'text-emerald-400' : 'text-red-400'}>{inr(s.net)}</span>
      <span className="text-zinc-400"> · PF {s.pf.toFixed(2)} · DD ₹{(s.dd / 1000).toFixed(0)}k</span>
      {s.winDays && <span className="text-zinc-500"> · {s.winDays} win days</span>}
    </td>
  );
}

const settingText = (s: Partial<BreakdownConfig>) =>
  [
    `${s.timeframe}m`,
    s.useSupertrend ? `ST ${s.stPeriod}/${s.stMultiplier}` : 'ST off',
    `VWAP ${s.useVwap ? 'on' : 'off'}`,
    `EMA ${s.useEma ? 'on' : 'off'}`,
    `SL ${s.slPct}%`,
    `Tgt ${s.targetPct}%`,
    `Loss limit ₹${((s.dailyLossLimit ?? 0) / 1000).toFixed(0)}k`,
    `Per side ${s.maxSameSide}`,
  ].join(' · ');

/** Static report of the dated settings grid search (lib/breakdownOptimization.ts), with which candidate the page runs. */
export function OptimizationReport({ pageConfig }: { pageConfig: BreakdownConfig }) {
  const [open, setOpen] = useState(false);
  const active = R.candidates.find((c) => matchesCandidate(pageConfig, c));

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className={cn(
          'flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-800/40',
          open && 'border-b border-zinc-800',
        )}
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg border border-sky-500/30 bg-sky-500/10">
            <SlidersHorizontal className="h-4 w-4 text-sky-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-white">Settings Optimization Report</h3>
              <span
                className={cn(
                  'rounded-full border px-2 py-0.5 text-[10px] font-bold',
                  active?.id === 'recommended'
                    ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                    : 'border-zinc-700 bg-zinc-800 text-zinc-300',
                )}
              >
                {active ? `RUNNING: ${active.label.toUpperCase()}` : 'RULES DIFFER FROM ALL CANDIDATES'}
              </span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Grid search of {R.configsTested} rule sets on the {R.source}, ₹0 brokerage, checked on unseen sessions.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-violet-300">
            RUN {R.date}
          </span>
          {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
        </div>
      </button>

      {open && (
        <div className="flex flex-col gap-4 p-4 text-xs">
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full min-w-[860px] text-left">
              <thead className="bg-zinc-800">
                <tr className="text-xs font-bold text-white">
                  <th className="px-2.5 py-2">Rule set</th>
                  <th className="px-2.5 py-2">
                    Train {R.train.from} → {R.train.to} ({R.train.sessions}d, {R.train.slippagePts} pt)
                  </th>
                  <th className="px-2.5 py-2">
                    Unseen {R.test.from} → {R.test.to} ({R.test.sessions}d, {R.test.slippagePts} pt)
                  </th>
                  <th className="px-2.5 py-2">
                    All {R.stress.sessions}d at {R.stress.slippagePts} pt slippage
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {R.candidates.map((c) => (
                  <tr key={c.id} className={cn(c.id === 'recommended' && 'bg-emerald-500/5')}>
                    <td className="px-2.5 py-1.5">
                      <div className="font-bold text-zinc-100">
                        {c.label}
                        {active?.id === c.id && <span className="ml-1.5 text-[10px] text-emerald-400">● active</span>}
                      </div>
                      <div className="font-mono text-[10px] text-zinc-400">{settingText(c.settings)}</div>
                    </td>
                    <StatCell s={c.train} />
                    <StatCell s={c.test} />
                    <StatCell s={c.stress} />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="font-mono text-[10px] text-zinc-400">Same in every row: {R.common}</p>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                <Lightbulb className="h-3.5 w-3.5 text-amber-400" />
                What the search found
              </h4>
              <ul className="list-disc space-y-1 pl-4 text-[11px] text-zinc-300">
                {R.findings.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                Caveats
              </h4>
              <ul className="list-disc space-y-1 pl-4 text-[11px] text-zinc-300">
                {R.caveats.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          </div>
          <p className="text-[10px] text-zinc-500">
            PF = gross wins ÷ gross losses · DD = largest peak-to-trough fall of the daily equity curve. A snapshot: the
            numbers above are not recomputed; re-run the backtest to see the active rules on the current data.
          </p>
        </div>
      )}
    </section>
  );
}
