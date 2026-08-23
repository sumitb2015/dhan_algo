'use client';

import { StrategyTemplate } from '@/lib/optionsStrategy';
import { cn } from '@/lib/utils';

interface StrategyCardGridProps {
  templates: StrategyTemplate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function StrategyCardGrid({ templates, selectedId, onSelect }: StrategyCardGridProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3" role="radiogroup" aria-label="Strategy template">
      {templates.map((t) => {
        const active = t.id === selectedId;
        return (
          <button
            key={t.id}
            role="radio"
            aria-checked={active}
            onClick={() => onSelect(t.id)}
            className={cn(
              'group relative flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-all outline-none',
              'bg-zinc-900/60 border-zinc-800',
              'hover:border-zinc-700 focus-visible:ring-2 focus-visible:ring-emerald-500/50',
              active && 'bg-emerald-500/10 border-emerald-500/50 hover:border-emerald-500',
            )}
          >
            <span
              className={cn(
                'text-sm font-semibold leading-tight',
                active ? 'text-emerald-400' : 'text-zinc-100',
              )}
            >
              {t.name}
            </span>
            {t.undefinedRisk ? (
              <span className="inline-flex items-center rounded-md border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                Undefined risk
              </span>
            ) : (
              <span className="inline-flex items-center rounded-md border border-zinc-700 bg-zinc-800/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                Defined risk
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
