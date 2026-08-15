import React from 'react';
import { cn } from '@/lib/utils';

/** Wraps fetch with a hard client-side timeout so a hung Python child process
 * on the server (e.g. a stalled Dhan API call) can't leave the UI spinning
 * forever — it always resolves to a visible error instead. */
export async function fetchWithTimeout(input: string, timeoutMs: number, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export function fmt(n: number, digits = 2) { return (n ?? 0).toFixed(digits); }

export function fmtCountdown(s: number) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

export function fmtInr(n: number, digits = 0) {
  return (n ?? 0).toLocaleString('en-IN', { maximumFractionDigits: digits });
}

/** Compact ₹ for wide tables: 1.50L / 95.2K / 480. */
export function fmtCompactInr(n: number) {
  const abs = Math.abs(n ?? 0);
  if (abs >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n ?? 0));
}

export function PnlBadge({ v }: { v: number }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-px rounded-sm text-[11px] font-bold tabular-nums font-mono',
      v > 0 ? 'bg-emerald-500/10 text-emerald-400' : v < 0 ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-500')}>
      {v > 0 ? '+' : ''}₹{fmt(v)}
    </span>
  );
}

export function PctText({ v, digits = 2 }: { v: number | null | undefined; digits?: number }) {
  if (v === null || v === undefined || !Number.isFinite(v)) return <span className="text-zinc-600">—</span>;
  return (
    <span className={cn('tabular-nums', v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-400')}>
      {v > 0 ? '+' : ''}{v.toFixed(digits)}%
    </span>
  );
}

export function TH({ children, right, className, title }: { children?: React.ReactNode; right?: boolean; className?: string; title?: string }) {
  return (
    <th title={title} className={cn('py-1.5 px-2 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wide whitespace-nowrap sticky top-0 z-10',
      right ? 'text-right' : 'text-left', className)}>
      {children}
    </th>
  );
}

export function TD({ children, right, className, title }: { children?: React.ReactNode; right?: boolean; className?: string; title?: string }) {
  return <td title={title} className={cn('py-1.5 px-2 text-[12px] font-mono align-top', right ? 'text-right' : 'text-left', className)}>{children}</td>;
}
