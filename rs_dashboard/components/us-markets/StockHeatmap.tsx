'use client';

import { useState } from 'react';
import { cn } from '@/lib/utils';
import type { GroupStat } from '@/lib/usDashboard';
import { heatCls, pctText, usd } from './format';

export interface HeatRow { symbol: string; name: string; ltp: number | null; changePct: number | null }
export interface HeatView { key: string; label: string; groups: GroupStat[] }

interface Props {
  rows: readonly HeatRow[];
  /** The grouping choices; the segmented control is shown when there is more than one. */
  views: HeatView[];
  onSelect: (key: string) => void;
  fmtPrice?: (v: number | null) => string;
  /** Smaller tiles for a large universe (e.g. the Nifty 500). */
  dense?: boolean;
}

/** Equal-size tiles coloured by % change, grouped by one of `views` (e.g. GICS sector / AI theme; a stock can sit in several). */
export default function StockHeatmap({ rows, views, onSelect, fmtPrice = usd, dense = false }: Props) {
  const [mode, setMode] = useState(views[0]?.key ?? '');
  const by = new Map(rows.map(r => [r.symbol, r]));
  const groups = (views.find(v => v.key === mode) ?? views[0])?.groups ?? [];
  return (
    <section className="flex flex-col gap-2 rounded-lg border border-zinc-800 bg-zinc-950 p-3" aria-label="Heatmap">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">Heatmap · % change</h2>
        {views.length > 1 && (
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg" role="group" aria-label="Group heatmap by">
            {views.map(v => (
              <button key={v.key} onClick={() => setMode(v.key)} aria-pressed={mode === v.key}
                className={cn('px-2.5 py-1 text-[11px] font-semibold rounded-md border transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
                  mode === v.key ? 'bg-sky-500/10 text-sky-400 border-sky-500/20' : 'text-zinc-500 hover:text-zinc-300 border-transparent')}>
                {v.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <div className="flex flex-col gap-2">
        {groups.map(g => (
          <div key={g.key} className="flex flex-col sm:flex-row gap-1.5 sm:items-stretch">
            <button onClick={() => onSelect(g.key)} title={g.desc}
              className="sm:w-36 shrink-0 text-left text-[11px] font-semibold text-zinc-300 hover:text-zinc-100 flex sm:flex-col justify-between sm:justify-center gap-1 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60 rounded">
              <span className="truncate">{g.label}</span>
              <span className="text-[10px] text-zinc-500 tabular-nums">{pctText(g.avgPct)} avg · {g.symbols.length}</span>
            </button>
            <div className="flex flex-wrap gap-1 flex-1">
              {g.symbols.map(s => {
                const r = by.get(s);
                return (
                  <div key={s} title={r ? `${r.name} · ${fmtPrice(r.ltp)} · ${pctText(r.changePct)}` : s}
                    className={cn('rounded border flex flex-col items-center justify-center leading-tight overflow-hidden',
                      dense ? 'w-[3.75rem] h-9' : 'w-[4.25rem] h-11', heatCls(r?.changePct ?? null))}>
                    <span className={cn('font-bold text-zinc-100 truncate max-w-full px-0.5', dense ? 'text-[9px]' : 'text-[11px]')}>{s}</span>
                    <span className={cn('font-semibold tabular-nums text-zinc-200', dense ? 'text-[9px]' : 'text-[10px]')}>{pctText(r?.changePct ?? null, 1)}</span>
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
