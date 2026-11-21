'use client';

import { History } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ReplaySummary } from '@/lib/signalOrb';

// "These rules on the recent sessions": the replay from lib/signalOrb.ts (same decideOrb, fills at bar close, no costs or
// slippage). A sanity check before arming REAL — how often the orb flips and which way it leans — not a backtest.

const inr = (n: number) => `${n >= 0 ? '+' : '−'}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;

export function ReplayCard({ r, tf, compact = false, bare = false, futuresPoints = false }: {
  r: ReplaySummary | null; tf: number; compact?: boolean; bare?: boolean;
  /** options mode: the replay still trades the future's points, not the option premium */
  futuresPoints?: boolean;
}) {
  if (!r) {
    return <p className="font-mono text-[11px] text-zinc-500">Replay: not enough history yet</p>;
  }
  const max = Math.max(1, ...r.days.map(d => Math.abs(d.points)));
  const tone = (futuresPoints ? r.pointsPerDay : r.rupeesPerDay) >= 0 ? 'text-emerald-400' : 'text-red-400';
  const title = `What-if, not live: the last ${r.sessions} sessions with these rules on ${tf === 60 ? '1h' : `${tf}m`} bars: each decision at the bar close, no costs, no slippage. A rough check, not a backtest.${futuresPoints ? ' Options mode: replayed on the future\'s points, not on option premiums.' : ''}`;
  return (
    <div title={title}
      className={cn('flex flex-wrap items-center gap-x-4 gap-y-1.5', bare ? '' : 'rounded-2xl border border-zinc-900 bg-zinc-950/70 backdrop-blur', bare ? '' : compact ? 'px-3 py-2' : 'px-4 py-2.5')}>
      <div className="flex items-center gap-2 text-zinc-500">
        <History className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span className="whitespace-nowrap text-[10px] font-bold uppercase tracking-[0.25em]">Replay · {r.sessions}d{futuresPoints ? ' · fut pts' : ''}</span>
      </div>
      <dl className="flex items-baseline gap-4 whitespace-nowrap font-mono text-[11px]">
        <div><dt className="sr-only">Orders per day</dt><dd className="text-zinc-300"><strong className="text-zinc-100">{r.ordersPerDay.toFixed(0)}</strong> fills/day</dd></div>
        <div><dt className="sr-only">Gross per day</dt><dd className={cn('font-bold', tone)}>{futuresPoints ? `${r.pointsPerDay >= 0 ? '+' : '−'}${Math.abs(r.pointsPerDay).toFixed(1)} pts` : inr(r.rupeesPerDay)}/day</dd></div>
        <div><dt className="sr-only">Green days</dt><dd className="text-zinc-300"><strong className="text-zinc-100">{r.greenDays}</strong>/{r.sessions} green</dd></div>
      </dl>
      {/* one bar per session, up = green day */}
      <svg viewBox={`0 0 ${r.days.length * 4} 20`} className="h-5 w-24 shrink-0" aria-hidden preserveAspectRatio="none">
        <line x1="0" x2={r.days.length * 4} y1="10" y2="10" stroke="currentColor" className="text-zinc-800" strokeWidth=".5" />
        {r.days.map((d, i) => {
          const h = Math.max(0.6, (Math.abs(d.points) / max) * 9.5);
          return <rect key={d.day} x={i * 4 + 0.6} width="2.8" y={d.points >= 0 ? 10 - h : 10} height={h} rx=".6"
            fill={d.points >= 0 ? 'var(--color-emerald-500)' : 'var(--color-red-500)'} />;
        })}
      </svg>
    </div>
  );
}
