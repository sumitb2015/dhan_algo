'use client';

import { useState } from 'react';
import { ShieldCheck, ShieldAlert, CheckCircle2, XCircle, ChevronDown, ChevronRight, Scale, Clock, AlertTriangle, FileCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { BtAudit } from '@/lib/breakdownBacktest';

/**
 * Invariant audit of the stored backtest. Every number here comes from `audit` (lib/breakdownBacktest.ts
 * auditResults, run by the runner at the end of each run against the cached bar files) — never fixed text.
 */
export function BacktestAuditReport({
  audit,
  storeConfigKey,
  tradeCount,
  defaultOpen = false,
  isOpen: controlledOpen,
  onToggle,
}: {
  audit: BtAudit | null;
  storeConfigKey: string | null;
  /** Trades currently shown, to spot an audit older than the results. */
  tradeCount: number;
  defaultOpen?: boolean;
  isOpen?: boolean;
  onToggle?: () => void;
}) {
  const [internalOpen, setInternalOpen] = useState(defaultOpen);
  const isOpen = controlledOpen !== undefined ? controlledOpen : internalOpen;
  const handleToggle = () => (onToggle ? onToggle() : setInternalOpen((prev) => !prev));

  const stale = !!audit && ((storeConfigKey != null && audit.configKey !== storeConfigKey) || audit.trades !== tradeCount);
  const failed = audit ? audit.checks.filter((c) => c.failures > 0) : [];
  const partialDays = audit ? Object.values(audit.warmup).reduce((a, w) => a + w.partial, 0) : 0;
  const state: 'none' | 'stale' | 'fail' | 'pass' = !audit ? 'none' : stale ? 'stale' : failed.length ? 'fail' : 'pass';
  const badge = {
    none: { text: 'NOT AUDITED — RE-RUN', cls: 'border-zinc-700 bg-zinc-800 text-zinc-300' },
    stale: { text: 'AUDIT OUT OF DATE — RE-RUN', cls: 'border-amber-500/30 bg-amber-500/10 text-amber-400' },
    fail: { text: `${failed.length} CHECK${failed.length === 1 ? '' : 'S'} FAILED`, cls: 'border-red-500/30 bg-red-500/10 text-red-400' },
    pass: { text: `ALL ${audit?.checks.length ?? 0} CHECKS PASSED`, cls: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400' },
  }[state];
  const Icon = state === 'pass' ? ShieldCheck : ShieldAlert;

  return (
    <section className="mt-4 overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900/60">
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={isOpen}
        className={cn(
          'flex w-full flex-wrap items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-800/40',
          isOpen && 'border-b border-zinc-800',
        )}
      >
        <div className="flex items-center gap-2.5">
          <div
            className={cn(
              'flex h-7 w-7 items-center justify-center rounded-lg border',
              state === 'pass' ? 'border-emerald-500/30 bg-emerald-500/10' : 'border-amber-500/30 bg-amber-500/10',
            )}
          >
            <Icon className={cn('h-4 w-4', state === 'pass' ? 'text-emerald-400' : 'text-amber-400')} />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-bold uppercase tracking-wider text-white">Backtest Integrity Audit</h3>
              <span className={cn('rounded-full border px-2 py-0.5 text-[10px] font-bold', badge.cls)}>{badge.text}</span>
            </div>
            <p className="text-[11px] text-zinc-400">
              Every stored trade re-checked against the rules and the bars it was simulated on.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-3">
          {audit && (
            <span className="rounded-full border border-violet-500/30 bg-violet-500/10 px-2.5 py-0.5 font-mono text-[10px] font-bold tracking-wider text-violet-300">
              AUDITED {audit.at.slice(0, 16).replace('T', ' ')} UTC
            </span>
          )}
          {isOpen ? <ChevronDown className="h-4 w-4 text-zinc-400" /> : <ChevronRight className="h-4 w-4 text-zinc-400" />}
        </div>
      </button>

      {isOpen && (
        <div className="flex flex-col gap-4 p-4 text-xs">
          {!audit ? (
            <p className="text-[11px] text-zinc-400">
              These results were built before the audit existed. Re-run the backtest: the runner audits the results when it finishes.
            </p>
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
                      <div
                        key={c.id}
                        className={cn(
                          'flex flex-col justify-between rounded-lg border bg-zinc-950/60 p-2.5',
                          ok ? 'border-zinc-800' : 'border-red-500/40',
                        )}
                      >
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
                  <Clock className="h-3.5 w-3.5 text-sky-400" />
                  Indicator warm-up by weekday
                </h4>
                <div className="flex flex-wrap gap-2">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map((wd) => {
                    const w = audit.warmup[wd];
                    if (!w) return null;
                    return (
                      <span
                        key={wd}
                        className={cn(
                          'rounded border px-2 py-0.5 font-mono text-[10px]',
                          w.partial ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-zinc-800 text-zinc-300',
                        )}
                      >
                        {wd}: {w.partial}/{w.sessions} without previous day
                      </span>
                    );
                  })}
                  {audit.coldEntries && (
                    <span
                      className={cn(
                        'rounded border px-2 py-0.5 font-mono text-[10px]',
                        audit.coldEntries.trades ? 'border-amber-500/30 bg-amber-500/10 text-amber-300' : 'border-zinc-800 text-zinc-300',
                      )}
                      title={`Entries whose contract had fewer than ${audit.coldEntries.minBars} one-minute bars in the previous session`}
                    >
                      Cold-contract entries: {audit.coldEntries.trades}/{audit.trades} · net ₹
                      {audit.coldEntries.net.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                    </span>
                  )}
                </div>
                <p className="mt-2 text-[11px] leading-relaxed text-zinc-400">
                  Indicators warm up on the previous session only. The options DB stores just the strikes inside ATM±10 each
                  minute, and holds a weekly contract only from the day after the previous expiry: so every Wednesday, and any strike
                  that was far from the previous day&apos;s spot, starts without that warm-up. Such a contract cannot signal until EMA20
                  seeds on today&apos;s own bars (20 closed bars: ≈ 10:15 on 3m), and then on values the live page — which loads every
                  strike&apos;s history — would not have. A cold-contract entry is one whose contract had fewer than
                  {audit.coldEntries ? ` ${audit.coldEntries.minBars}` : ' EMA-period × timeframe'} previous-session bars.
                  {partialDays > 0 && ' Read the Wednesday row as indicative only.'}
                </p>
              </div>
            </>
          )}

          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                <Scale className="h-3.5 w-3.5 text-amber-400" />
                Charges per order
              </h4>
              <ul className="space-y-1 text-[11px] text-zinc-300">
                <li className="flex justify-between border-b border-zinc-800/60 pb-0.5">
                  <span>Brokerage</span> <span className="font-mono text-zinc-200">Rules setting (₹20 Dhan / ₹0 Kotak)</span>
                </li>
                <li className="flex justify-between border-b border-zinc-800/60 pb-0.5">
                  <span>STT</span> <span className="font-mono text-zinc-200">0.10% of SELL premium</span>
                </li>
                <li className="flex justify-between border-b border-zinc-800/60 pb-0.5">
                  <span>Exchange</span> <span className="font-mono text-zinc-200">0.05% of premium (NSE ≈ 0.035%: conservative)</span>
                </li>
                <li className="flex justify-between border-b border-zinc-800/60 pb-0.5">
                  <span>GST</span> <span className="font-mono text-zinc-200">18% of brokerage + exchange + SEBI</span>
                </li>
                <li className="flex justify-between">
                  <span>SEBI / stamp</span> <span className="font-mono text-zinc-200">₹10/cr · 0.003% of BUY</span>
                </li>
              </ul>
            </div>

            <div className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
              <h4 className="mb-2 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                <AlertTriangle className="h-3.5 w-3.5 text-amber-400" />
                What the backtest cannot know
              </h4>
              <ul className="space-y-1.5 text-[11px] text-zinc-400">
                <li>
                  <span className="font-bold text-zinc-300">Fills:</span> the live engine sends a MARKET order after LTP crosses a level
                  (checked once a second), for targets too. With slippage 0 every stop fills exactly at its level; set Slippage in the
                  rules to price that in.
                </li>
                <li>
                  <span className="font-bold text-zinc-300">Path inside a bar:</span> assumed open → high → low → close (the adverse move
                  first for a short), from 1-minute OHLC only.
                </li>
                <li>
                  <span className="font-bold text-zinc-300">Not modelled:</span> broker rejections, partial fills, feed gaps.
                </li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}
