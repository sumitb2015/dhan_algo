'use client';

import { CHART_INDICATOR_CATALOG, type ChartIndicatorRequest } from '@/lib/optionsChartTypes';

function ParamInputs({
  paramLabels,
  params,
  onChange,
}: {
  paramLabels: Record<string, string>;
  params: Record<string, number>;
  onChange: (params: Record<string, number>) => void;
}) {
  const keys = Object.keys(paramLabels);
  if (keys.length === 0) return null;
  return (
    <>
      {keys.map((key) => (
        <input
          key={key}
          type="number"
          value={params[key]}
          onChange={(e) => onChange({ ...params, [key]: Number(e.target.value) })}
          title={paramLabels[key]}
          className="w-11 px-1 py-0.5 rounded tabular-nums text-xs bg-zinc-950 border border-zinc-700 text-zinc-200"
        />
      ))}
    </>
  );
}

export function ChartIndicatorPicker({
  indicators,
  onChange,
}: {
  indicators: ChartIndicatorRequest[];
  onChange: (indicators: ChartIndicatorRequest[]) => void;
}) {
  function addIndicator(typeId: string) {
    const entry = CHART_INDICATOR_CATALOG.find((c) => c.id === typeId);
    if (!entry) return;
    onChange([...indicators, { type: entry.id, params: { ...entry.defaultParams } }]);
  }

  function removeIndicator(index: number) {
    onChange(indicators.filter((_, i) => i !== index));
  }

  function updateIndicator(index: number, params: Record<string, number>) {
    onChange(indicators.map((ind, i) => (i === index ? { ...ind, params } : ind)));
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {indicators.map((ind, index) => {
        const entry = CHART_INDICATOR_CATALOG.find((c) => c.id === ind.type);
        if (!entry) return null;
        return (
          <span key={index} className="flex items-center gap-1 pl-2 pr-1 py-1 rounded text-xs border border-zinc-700 bg-zinc-900 text-zinc-200">
            <span className="font-medium">{entry.label}</span>
            <ParamInputs paramLabels={entry.paramLabels} params={ind.params} onChange={(params) => updateIndicator(index, params)} />
            <button type="button" onClick={() => removeIndicator(index)} aria-label={`Remove ${entry.label}`} className="text-zinc-500 hover:text-zinc-300 leading-none px-0.5">
              ×
            </button>
          </span>
        );
      })}
      <select
        value=""
        onChange={(e) => {
          if (e.target.value) addIndicator(e.target.value);
          e.target.value = '';
        }}
        className="px-2 py-1.5 text-xs rounded border border-zinc-700 bg-zinc-900 text-zinc-200"
      >
        <option value="">+ Add indicator…</option>
        {CHART_INDICATOR_CATALOG.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.label}
          </option>
        ))}
      </select>
    </div>
  );
}
