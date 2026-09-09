'use client';

import React from 'react';
import { cn } from '@/lib/utils';

export function TerminalPanel({
  title,
  icon: Icon,
  meta,
  badge,
  action,
  children,
  className = '',
}: {
  title: string;
  icon?: React.ComponentType<{ className?: string }>;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn('flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm overflow-hidden', className)}>
      <header className="flex items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-3.5 py-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400">
            {Icon && <Icon className="h-3.5 w-3.5 text-amber-400" />}
            {title}
          </span>
          {badge}
        </div>
        <div className="flex items-center gap-2">
          {action}
          {meta ? <div className="font-mono text-[11px] text-zinc-400">{meta}</div> : null}
        </div>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

export function StatTile({
  label,
  value,
  sub,
  progress,
  tone = 'neutral',
  tooltip,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  progress?: { percent: number; colorClass?: string };
  tone?: 'neutral' | 'up' | 'down' | 'accent';
  tooltip?: string;
}) {
  const valueClass =
    tone === 'up' ? 'text-emerald-400'
    : tone === 'down' ? 'text-red-400'
    : tone === 'accent' ? 'text-amber-400'
    : 'text-zinc-100';

  return (
    <div
      title={tooltip}
      className="flex flex-col justify-between gap-1.5 rounded-lg border border-zinc-800/80 bg-zinc-950/80 px-3 py-2.5 transition-colors hover:border-zinc-700"
    >
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">{label}</span>
        {progress && (
          <span className="font-mono text-[9px] font-semibold text-zinc-400">
            {progress.percent.toFixed(1)}%
          </span>
        )}
      </div>

      <div className={`font-mono text-sm lg:text-base font-bold leading-none tabular-nums ${valueClass}`}>
        {value}
      </div>

      {progress && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full transition-all ${progress.colorClass ?? 'bg-amber-400'}`}
            style={{ width: `${Math.min(100, Math.max(0, progress.percent))}%` }}
          />
        </div>
      )}

      {sub && (
        <div className="font-mono text-[10px] text-zinc-400 leading-tight truncate">
          {sub}
        </div>
      )}
    </div>
  );
}
