'use client';

import { cn } from '@/lib/utils';
import type { DashRow, GroupStat } from '@/lib/usDashboard';
import { pctText, signCls } from './format';

interface Props { themes: GroupStat[]; rows: DashRow[]; selected: string | null; onSelect: (key: string | null) => void }

/** The AI stack, layer by layer: each theme's equal-weight average, breadth and member moves. */
export default function AiThemesPanel({ themes, rows, selected, onSelect }: Props) {
  const by = new Map(rows.map(r => [r.symbol, r]));
  return (
    <section className="flex flex-col gap-2" aria-label="AI themes">
      <h2 className="text-[11px] font-bold uppercase tracking-wider text-zinc-300">AI stack</h2>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
        {themes.map(t => (
          <button key={t.key} onClick={() => onSelect(selected === t.key ? null : t.key)} aria-pressed={selected === t.key} title={t.desc}
            className={cn('text-left rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 flex flex-col gap-1.5 hover:border-zinc-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60',
              selected === t.key && 'ring-2 ring-sky-400')}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-bold text-zinc-100">{t.label}</span>
              <span className={cn('text-sm font-bold tabular-nums', signCls(t.avgPct))}>{pctText(t.avgPct)}</span>
            </div>
            <div className="flex items-baseline justify-between gap-2 text-[10px]">
              <span className="text-zinc-500 truncate">{t.desc}</span>
              <span className="text-zinc-400 tabular-nums shrink-0">{t.adv}▲ {t.dec}▼{t.etf ? ` · ${t.etf} ${pctText(t.etfPct, 1)}` : ''}</span>
            </div>
            <div className="flex flex-wrap gap-1">
              {t.symbols.map(s => {
                const p = by.get(s)?.changePct ?? null;
                return (
                  <span key={s} className="text-[10px] px-1.5 py-0.5 rounded border border-zinc-800 bg-zinc-950 tabular-nums">
                    <span className="font-bold text-zinc-200">{s}</span> <span className={signCls(p)}>{pctText(p, 1)}</span>
                  </span>
                );
              })}
            </div>
          </button>
        ))}
      </div>
    </section>
  );
}
