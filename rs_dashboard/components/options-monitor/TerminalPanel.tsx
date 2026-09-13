'use client';

import React from 'react';

export default function TerminalPanel({
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
    <section className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm overflow-hidden ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-3.5 py-2.5 shrink-0">
        <div className="flex items-center gap-2 min-w-0">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400 truncate">
            {Icon && <Icon className="h-3.5 w-3.5 text-amber-400 shrink-0" />}
            {title}
          </span>
          {badge}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {action}
          {meta ? <div className="font-mono text-[11px] text-zinc-400">{meta}</div> : null}
        </div>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}
