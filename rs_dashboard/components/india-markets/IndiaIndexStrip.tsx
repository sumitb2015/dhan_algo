'use client';

import { cn } from '@/lib/utils';
import type { IndexCard } from '@/lib/indiaMarkets';
import type { GroupStat } from '@/lib/usDashboard';
import { pctText, signCls } from '@/components/us-markets/format';
import { inr } from './format';

interface Props { cards: IndexCard[]; broad: GroupStat[]; selected: string | null; onSelect: (key: string | null) => void; live: boolean }

/** Broad-market indices and India VIX. A card with constituents opens its member table; the bar is member breadth. */
export default function IndiaIndexStrip({ cards, broad, selected, onSelect, live }: Props) {
  const stat = new Map(broad.map(g => [g.key, g]));
  return (
    <section className="flex flex-col gap-2" aria-label="Broad market indices">
      <div className="flex items-center gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">Broad market</h2>
        <span className="text-[10px] font-semibold text-zinc-500">Dhan index feed{live ? ' · live' : ' · last saved'}</span>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 2xl:grid-cols-9 gap-2">
        {cards.map(c => {
          const g = stat.get(c.symbol);
          const drill = !!g && g.symbols.length > 0;
          const n = g ? g.adv + g.dec + g.unch : 0;
          const body = (
            <>
              <div className="flex items-baseline justify-between gap-2">
                <span className="text-[11px] font-bold text-zinc-300 truncate">{c.label}</span>
                {g && g.symbols.length > 0 && <span className="text-[10px] text-zinc-500 tabular-nums">{g.symbols.length}</span>}
              </div>
              <div className="mt-1 text-lg font-bold tabular-nums text-zinc-100 leading-none">{inr(c.ltp)}</div>
              <div className={cn('mt-1 text-[11px] font-semibold tabular-nums', signCls(c.change))}>
                {c.change == null ? '–' : `${c.change > 0 ? '+' : ''}${inr(c.change)}`} <span className="ml-1">{pctText(c.changePct)}</span>
              </div>
              {g && n > 0 && (
                <div className="mt-1.5 flex h-1 rounded-full overflow-hidden bg-zinc-800" title={`${g.adv} up · ${g.dec} down · ${g.unch} flat`}>
                  <div className="bg-emerald-500" style={{ width: `${(g.adv / n) * 100}%` }} />
                  <div className="bg-zinc-600" style={{ width: `${(g.unch / n) * 100}%` }} />
                  <div className="bg-red-500" style={{ width: `${(g.dec / n) * 100}%` }} />
                </div>
              )}
            </>
          );
          const cls = cn('rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-left', selected === c.symbol && 'ring-2 ring-sky-400');
          return drill ? (
            <button key={c.symbol} onClick={() => onSelect(selected === c.symbol ? null : c.symbol)} aria-pressed={selected === c.symbol}
              className={cn(cls, 'hover:border-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60')}>{body}</button>
          ) : <div key={c.symbol} className={cls}>{body}</div>;
        })}
      </div>
    </section>
  );
}
