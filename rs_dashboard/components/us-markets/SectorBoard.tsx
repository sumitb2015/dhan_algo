'use client';

import { cn } from '@/lib/utils';
import type { Breadth, GroupStat } from '@/lib/usDashboard';
import { heatCls, pctText, signCls } from './format';

function AdvDecBar({ adv, dec, unch }: { adv: number; dec: number; unch: number }) {
  const n = adv + dec + unch;
  if (n === 0) return <div className="h-1.5 rounded-full bg-zinc-800" />;
  return (
    <div className="flex h-1.5 rounded-full overflow-hidden bg-zinc-800" title={`${adv} up · ${dec} down · ${unch} flat`}>
      <div className="bg-emerald-500" style={{ width: `${(adv / n) * 100}%` }} />
      <div className="bg-zinc-600" style={{ width: `${(unch / n) * 100}%` }} />
      <div className="bg-red-500" style={{ width: `${(dec / n) * 100}%` }} />
    </div>
  );
}

export function BreadthStrip({ b }: { b: Breadth }) {
  return (
    <div className="flex items-center gap-3 flex-wrap text-[11px]">
      <span className="font-bold uppercase tracking-wider text-zinc-300">Breadth</span>
      <span className="text-emerald-400 font-semibold tabular-nums">{b.adv} up</span>
      <span className="text-red-400 font-semibold tabular-nums">{b.dec} down</span>
      <span className="text-zinc-400 tabular-nums">{b.unch} flat</span>
      <span className="text-zinc-500 tabular-nums">{b.quoted}/{b.total} stocks quoted</span>
      <div className="w-40"><AdvDecBar adv={b.adv} dec={b.dec} unch={b.unch} /></div>
    </div>
  );
}

interface Props { groups: GroupStat[]; selected: string | null; onSelect: (key: string | null) => void; title: string }

/** One tile per group: the benchmark ETF's move, the equal-weight member median, breadth and best/worst. Click to drill down. */
export default function SectorBoard({ groups, selected, onSelect, title }: Props) {
  return (
    <section className="flex flex-col gap-2" aria-label={title}>
      <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">{title}</h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 2xl:grid-cols-6 gap-2">
        {groups.map(g => {
          const head = g.etfPct ?? g.medianPct;
          // A group with a benchmark that has not moved yet (no quote / no previous close) falls back to its member median: say so.
          const onMedian = g.etf != null && g.etfPct == null && g.medianPct != null;
          return (
            <button key={g.key} onClick={() => onSelect(selected === g.key ? null : g.key)} aria-pressed={selected === g.key} title={g.desc}
              className={cn('text-left rounded-lg border px-3 py-2 flex flex-col gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                heatCls(head), selected === g.key && 'ring-2 ring-sky-400')}>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-xs font-bold text-zinc-100 truncate">{g.label}</span>
                {g.etf && <span className="text-[10px] font-semibold text-zinc-400">{g.etf}</span>}
              </div>
              <div className="flex items-baseline justify-between gap-2">
                <span className="flex items-baseline gap-1.5">
                  <span className={cn('text-base font-bold tabular-nums leading-none', signCls(head))}>{pctText(head)}</span>
                  {onMedian && <span className="text-[9px] font-bold uppercase tracking-wider text-amber-300" title={`${g.etf} has no move yet; this is the median of its stocks`}>median</span>}
                </span>
                <span className="text-[10px] text-zinc-400 tabular-nums" title="Median % change of the group's stocks">med {pctText(g.medianPct)}</span>
              </div>
              <AdvDecBar adv={g.adv} dec={g.dec} unch={g.unch} />
              <div className="flex items-baseline justify-between gap-2 text-[10px] tabular-nums">
                <span className="text-zinc-400 truncate">{g.best ? <>▲ {g.best.symbol} <span className={signCls(g.best.pct)}>{pctText(g.best.pct, 1)}</span></> : '–'}</span>
                <span className="text-zinc-400 truncate">{g.worst && g.worst !== g.best ? <>▼ {g.worst.symbol} <span className={signCls(g.worst.pct)}>{pctText(g.worst.pct, 1)}</span></> : ''}</span>
              </div>
            </button>
          );
        })}
      </div>
    </section>
  );
}
