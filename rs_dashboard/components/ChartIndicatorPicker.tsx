'use client';

import { useEffect, useState } from 'react';
import { CHART_INDICATOR_CATALOG, type ChartIndicatorRequest } from '@/lib/optionsChartTypes';

/** Committed on blur/Enter, not per keystroke: the owning panel has `indicators` in its
 * fetch-effect deps, so a raw onChange made typing "200" issue three chart requests (2, 20,
 * 200) - each one a fresh Python spawn - and an emptied box posted period 0, which pandas
 * rejects outright. Local draft state keeps typing responsive without any of that. */
function ParamInput({
  label,
  value,
  onCommit,
}: {
  label: string;
  value: number;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));

  // Re-sync when the value changes from outside (preset applied, indicator re-added).
  useEffect(() => setDraft(String(value)), [value]);

  function commit() {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setDraft(String(value)); // reject empty/zero/negative, restore the last good value
      return;
    }
    if (parsed !== value) onCommit(parsed);
  }

  return (
    <input
      type="number"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        else if (e.key === 'Escape') setDraft(String(value));
      }}
      title={`${label} — press Enter or click away to apply`}
      className="w-11 px-1 py-0.5 rounded tabular-nums text-xs bg-zinc-950 border border-zinc-700 text-zinc-200"
    />
  );
}

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
        <ParamInput
          key={key}
          label={paramLabels[key]}
          value={params[key]}
          onCommit={(value) => onChange({ ...params, [key]: value })}
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
