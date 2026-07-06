'use client';

import { StrategyTemplate } from '@/lib/optionsStrategy';

interface StrategyCardGridProps {
  templates: StrategyTemplate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}

export default function StrategyCardGrid({ templates, selectedId, onSelect }: StrategyCardGridProps) {
  return (
    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
      {templates.map((t) => {
        const active = t.id === selectedId;
        return (
          <button
            key={t.id}
            onClick={() => onSelect(t.id)}
            className={`text-left rounded-2xl border p-4 transition-colors ${
              active
                ? 'bg-sky-950 border-sky-600'
                : 'bg-zinc-900/60 border-zinc-800 hover:border-zinc-600'
            }`}
          >
            <div className="text-sm font-semibold text-white">{t.name}</div>
            {t.undefinedRisk && (
              <div className="mt-1 text-[10px] font-medium text-amber-400 uppercase tracking-wide">
                Undefined risk
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}
