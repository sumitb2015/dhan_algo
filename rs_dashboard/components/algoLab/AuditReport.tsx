'use client';

import { ShieldCheck, ShieldAlert, CheckCircle2, XCircle, ChevronDown, ChevronRight, Clock, AlertTriangle, FileCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BtAudit } from '@/lib/algoLab/audit';
import type { Side } from '@/lib/algoLab/types';

/** The stored audit (lib/algoLab/audit.ts, computed by the runner). Every number comes from `audit`, none is typed. */
export function AuditReport({
  audit,
  storeConfigKey,
  tradeCount,
  side,
  open,
  onToggle,
}: {
  audit: BtAudit | null;
  storeConfigKey: string | null;
  tradeCount: number;
  side: Side;
  open: boolean;
  onToggle: () => void;
}) {
  const stale = !!audit && ((storeConfigKey != null && audit.configKey !== storeConfigKey) || audit.trades !== tradeCount);
  const failed = audit ? audit.checks.filter((c) => c.failures > 0) : [];
  const state: 'none' | 'stale' | 'fail' | 'pass' = !audit ? 'none' : stale ? 'stale' : failed.length ? 'fail' : 'pass';
  const badge = {
    none: { text: 'NOT AUDITED — RE-RUN', cls: 'border-zinc-700 bg-zinc-800 text-zinc-300' },
    stale: { text: 'AUDIT OUT OF DATE — RE-RUN', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
    fail: { text: `${failed.length} CHECK${failed.length === 1 ? '' : 'S'} FAILED`, cls: 'border-red-500/30 bg-red-500/10 text-red-400' },
    pass: { text: `ALL ${audit?.checks.length ?? 0} CHECKS PASSED`, cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  }[state];
  const Icon = state === 'pass' ? ShieldCheck : ShieldAlert;

  return (
    <section id="algo-lab-audit" className="mt-4 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className={cn('flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left hover:bg-zinc-800/40', open && 'border-b border-zinc-800')}
      >
        <div className="flex items-center gap-2.5">
          <div className={cn('flex h-7 w-7 items-center justify-center rounded-lg border', state === 'pass' ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10')}>
            <Icon className={cn('h-4 w-4', state === 'pass' ? 'text-emerald-400' : 'text-amber-400')} />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-white">Backtest integrity audit</h3>
              <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-bold', badge.cls)}>{badge.text}</span>
            </div>
            <p className="text-[11px] text-zinc-400">Every stored trade re-checked against the rules and the bars it was simulated on.</p>
          </div>
        </div>
        {open ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
      </button>

      {open && (
        <div className="flex flex-col gap-4 p-4 text-xs">
          {!audit ? (
            <p className="text-[11px] text-zinc-400">No audit yet: the runner audits the results when a run finishes.</p>
          ) : (
            <>
              {stale && (
                <p className="rounded border border-amber-500/30 bg-amber-500/10 px-2.5 py-1.5 text-[11px] text-amber-300">
                  This audit covers {audit.trades} trades but {tradeCount} are shown (or the rules changed). Re-run to audit the current results.
                </p>
              )}
              <div>
                <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                  <FileCheck className="h-3.5 w-3.5 text-emerald-400" />
                  Trade invariants · {audit.trades.toLocaleString('en-IN')} trades · {audit.sessions} sessions
                  {audit.sessionsWithBars < audit.sessions && ` (bar files for ${audit.sessionsWithBars})`}
                </h4>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
                  {audit.checks.map((c) => {
                    const ok = c.failures === 0;
                    return (
                      <div key={c.id} className={cn('rounded-lg border bg-zinc-950/60 p-2.5', ok ? 'border-zinc-800' : 'border-red-500/40')}>
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-bold text-zinc-200">{c.label}</span>
                          <span className={cn('flex shrink-0 items-center gap-1 font-mono text-[10px] font-bold', ok ? 'text-emerald-400' : 'text-red-400')}>
                            {ok ? <CheckCircle2 className="h-3 w-3" /> : <XCircle className="h-3 w-3" />}
                            {c.failures} fail{c.failures === 1 ? '' : 's'}
                          </span>
                        </div>
                        <p className="mt-1 font-mono text-[10px] text-zinc-400">{c.rule}</p>
                        <p className="mt-1 font-mono text-[10px] text-zinc-500">Checked: {c.checked.toLocaleString('en-IN')}</p>
                        {c.examples.length > 0 && (
                          <ul className="mt-1 space-y-0.5 font-mono text-[10px] text-red-300">
                            {c.examples.map((e) => (
                              <li key={e}>{e}</li>
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                  <Clock className="h-3.5 w-3.5 text-sky-400" /> Indicator warm-up
                </h4>
                <div className="flex flex-wrap gap-2">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((wd) => {
                    const w = audit.warmup[wd];
                    if (!w) return null;
                    return (
                      <span key={wd} className={cn('rounded border px-2 py-0.5 font-mono text-[10px]', w.partial ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-zinc-800 text-zinc-300')}>
                        {wd}: {w.partial}/{w.sessions} without previous day
                      </span>
                    );
                  })}
                  <span
                    className={cn('rounded border px-2 py-0.5 font-mono text-[10px]', audit.coldEntries.trades ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-zinc-800 text-zinc-300')}
                    title={`Entries whose contract had fewer than ${audit.coldEntries.minBars} one-minute bars before the session`}
                  >
                    Cold-contract entries: {audit.coldEntries.trades}/{audit.trades} · net ₹
                    {audit.coldEntries.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </span>
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
                  The options DB holds only ATM±10 strikes per minute and a weekly contract only from the day after the previous
                  expiry, so Wednesdays and strikes far from the previous day&apos;s spot start without warm-up bars; the live page loads
                  every strike&apos;s history. A cold entry signalled on indicators seeded from today&apos;s bars only — read a large cold share as
                  a result live trading would not reproduce. &quot;Skip cold contracts&quot; in the rules excludes them.
                </p>
              </div>
            </>
          )}

          <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
            <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
              <AlertTriangle className="h-3.5 w-3.5 text-amber-400" /> What the backtest cannot know
            </h4>
            <ul className="space-y-1.5 text-[11px] text-zinc-400">
              <li>
                <span className="font-bold text-zinc-300">Fills:</span> live sends a MARKET order after the price crosses a level (checked once a
                second). With slippage 0 every level fills exactly; set Slippage in the rules to price that in.
              </li>
              <li>
                <span className="font-bold text-zinc-300">Path inside a bar:</span> assumed {side === 'SELL' ? 'open → high → low → close' : 'open → low → high → close'}{' '}
                (the adverse move first), from 1-minute OHLC only.
              </li>
              <li>
                <span className="font-bold text-zinc-300">Charges:</span> Dhan F&amp;O per order — brokerage from the rules, STT 0.10% of the SELL premium,
                exchange 0.05%, GST 18%, SEBI ₹10/cr, stamp 0.003% of the BUY.
              </li>
              <li>
                <span className="font-bold text-zinc-300">Not modelled:</span> broker rejections, partial fills, feed gaps.
              </li>
            </ul>
          </div>
        </div>
      )}
    </section>
  );
}
