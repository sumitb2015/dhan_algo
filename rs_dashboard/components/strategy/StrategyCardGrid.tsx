'use client';

import { StrategyTemplate } from '@/lib/optionsStrategy';
import { Badge } from '@/components/ui/badge';
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
              'group relative flex flex-col items-start gap-2 rounded-xl p-4 text-left transition-all outline-none',
              'bg-card ring-1 ring-foreground/10',
              'hover:ring-foreground/25 focus-visible:ring-3 focus-visible:ring-ring/50',
              active && 'bg-primary/10 ring-2 ring-primary hover:ring-primary',
            )}
          >
            <span
              className={cn(
                'text-sm font-semibold leading-tight',
                active ? 'text-primary' : 'text-zinc-100',
              )}
            >
              {t.name}
            </span>
            {t.undefinedRisk ? (
              <Badge variant="outline" className="border-amber-500/40 bg-amber-500/10 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
                Undefined risk
              </Badge>
            ) : (
              <Badge variant="outline" className="border-zinc-700 bg-zinc-800/60 text-[10px] font-semibold uppercase tracking-wide text-zinc-400">
                Defined risk
              </Badge>
            )}
          </button>
        );
      })}
    </div>
  );
}
