'use client';

// Shared chrome and table primitives for the Advanced Scalper's small live
// ticker panels (TopWeightStocks, TopIndices), so the two sit side by side
// looking like one component rather than two near-misses.
//
// TH/TD/PctPill follow EquityWatchlist.tsx / MarketMovers.tsx exactly: bold
// white headers on solid bg-zinc-800, and opacity only ever on backgrounds
// (bg-emerald-500/10), never on text colours — per the dashboard rules in
// CLAUDE.md.

import React from 'react';
import { cn } from '@/lib/utils';

/** Em dash for "no data" — never render 0 or 0.00% for missing values. */
export const DASH = <span className="text-zinc-600">—</span>;

export function fmtPrice(n: number) {
  return n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export type SortDir = 'asc' | 'desc';

export function TH({ children, right, className, sortDir, onClick }: {
  children?: React.ReactNode;
  right?: boolean;
  className?: string;
  /** Present (even if the column isn't the active sort) marks the header clickable. */
  sortDir?: SortDir | null;
  onClick?: () => void;
}) {
  const sortable = onClick !== undefined;
  return (
    <th
      onClick={onClick}
      aria-sort={sortDir === 'asc' ? 'ascending' : sortDir === 'desc' ? 'descending' : undefined}
      className={cn('py-1.5 px-1.5 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wide whitespace-nowrap',
        right ? 'text-right' : 'text-left',
        sortable && 'cursor-pointer select-none hover:bg-zinc-700', className)}>
      <span className={cn('inline-flex items-center gap-0.5', right && 'flex-row-reverse')}>
        {children}
        {sortable && (
          <span className={cn('text-[9px] leading-none', sortDir ? 'text-zinc-300' : 'text-zinc-600')}>
            {sortDir === 'asc' ? '▲' : sortDir === 'desc' ? '▼' : '↕'}
          </span>
        )}
      </span>
    </th>
  );
}

export function TD({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn('py-1 px-1.5 text-[12px] font-mono whitespace-nowrap', right ? 'text-right' : 'text-left', className)}>{children}</td>;
}

export function PctPill({ v }: { v: number | null }) {
  if (v === null || !Number.isFinite(v)) return DASH;
  return (
    <span className={cn('inline-flex items-center px-1.5 py-px rounded-sm text-[11px] font-bold tabular-nums font-mono',
      v > 0 ? 'bg-emerald-500/10 text-emerald-400' : v < 0 ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-500')}>
      {v > 0 ? '+' : ''}{v.toFixed(2)}%
    </span>
  );
}

export type TickerStatus =
  | 'RUNNING' | 'LIVE'      // green: fresh and complete
  | 'STARTING'              // yellow pulse: first response not in yet
  | 'WARN'                  // amber: serving, but some rows are missing
  | 'STALE' | 'ERROR'       // rose: do not trust the numbers on screen
  | 'STOPPED';              // grey: not running

/**
 * Bordered panel matching the option boxes' chrome, with a status header.
 *
 * The header always surfaces feed health, so a dead or stale feed reads as dead
 * rather than as a suspiciously flat market — and `dimBody` greys the numbers so
 * stale prices can't be mistaken for current ones on an order-entry screen.
 */
export function TickerPanel({
  title, status, statusLabel, statusTitle, dimBody, head, children, className,
}: {
  title: string;
  status: TickerStatus | string;
  statusLabel: string;
  /** Hover text for the status chip — used to surface upstream error detail. */
  statusTitle?: string;
  dimBody?: boolean;
  head: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  const good = status === 'RUNNING' || status === 'LIVE';
  const warn = status === 'WARN';
  const bad = status === 'STALE' || status === 'ERROR';
  return (
    <div className={cn('bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col h-full', className)}>
      <div className="flex items-center justify-between gap-2 px-3 py-2 border-b border-zinc-800 bg-zinc-900/40 shrink-0">
        <span className="text-xs font-bold text-zinc-300 uppercase tracking-wider whitespace-nowrap">{title}</span>
        <div className="flex items-center gap-1.5 shrink-0" title={statusTitle}>
          <span className={cn('w-2 h-2 rounded-full',
            good ? 'bg-emerald-400 animate-pulse'
              : status === 'STARTING' ? 'bg-yellow-400 animate-pulse'
              : warn ? 'bg-amber-400'
              : bad ? 'bg-rose-400' : 'bg-zinc-600')} />
          <span className={cn('text-[10px] font-mono tabular-nums',
            bad ? 'text-rose-400 font-bold' : warn ? 'text-amber-400 font-bold' : 'text-zinc-500')}>
            {statusLabel}
          </span>
        </div>
      </div>
      <div className="flex-1 overflow-x-auto">
        <table className={cn('w-full border-collapse', dimBody && 'opacity-40')}>
          <thead>{head}</thead>
          <tbody>{children}</tbody>
        </table>
      </div>
    </div>
  );
}
