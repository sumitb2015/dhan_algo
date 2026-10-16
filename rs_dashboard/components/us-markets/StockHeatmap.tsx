'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { DashRow, GroupStat } from '@/lib/usDashboard';
import { heatCls, pctText, usd } from './format';

interface Props { rows: DashRow[]; sectors: GroupStat[]; themes: GroupStat[]; onSelect: (key: string) => void }

/** Equal-size tiles coloured by % change, grouped by GICS sector or by AI theme (a stock can sit in several themes). */
export default function StockHeatmap({ rows, sectors, themes, onSelect }: Props) {
  const [mode, setMode] = useState<'sector' | 'ai'>('sector');
  const by = new Map(rows.map(r => [r.symbol, r]));
  const groups = mode === 'sector' ? sectors : themes;
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3" aria-label="Heatmap">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">Heatmap · % change</h2>
        <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg" role="group" aria-label="Group heatmap by">
          {([['sector', 'Sectors'], ['ai', 'AI themes']] as const).map(([k, label]) => (
            <button key={k} onClick={() => setMode(k)} aria-pressed={mode === k}
              className={cn('px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                mode === k ? 'bg-sky-500/10 text-sky-400 border-sky-500/20' : 'text-zinc-500 hover:text-zinc-300 border-transparent')}>
              {label}
            </button>
          ))}
        </div>
      </div>
      <div className="flex flex-col gap-2">
        {groups.map(g => (
          <div key={g.key} className="flex flex-col sm:flex-row gap-1.5 sm:items-stretch">
            <button onClick={() => onSelect(g.key)} title={g.desc}
              className="sm:w-36 shrink-0 text-left text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 flex sm:flex-col justify-between sm:justify-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 rounded">
              <span className="truncate">{g.label}</span>
              <span className="text-[10px] text-zinc-500 tabular-nums">{pctText(g.avgPct)} avg</span>
            </button>
            <div className="flex flex-wrap gap-1 flex-1">
              {g.symbols.map(s => {
                const r = by.get(s);
                return (
                  <div key={s} title={r ? `${r.name} · ${usd(r.ltp)}` : s}
                    className={cn('w-[4.25rem] h-11 rounded border flex flex-col items-center justify-center leading-tight', heatCls(r?.changePct ?? null))}>
                    <span className="text-[11px] font-bold text-zinc-100">{s}</span>
                    <span className="text-[10px] font-semibold tabular-nums text-zinc-200">{pctText(r?.changePct ?? null, 1)}</span>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
