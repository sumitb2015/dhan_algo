'use client';

import React, { useEffect, useState } from 'react';
import type { SymbolType } from '@/app/api/level-chart/route';

// NIFTY/BANKNIFTY/SENSEX are the only indices level_chart_fetch.py can resolve to an intraday
// spot series (see its _resolve()) — deliberately NOT the broader KNOWN_INDICES list /api/symbols
// exposes elsewhere (sector indices like "Nifty IT" have no tradable spot security to chart).
const INDEX_OPTIONS: { key: string; label: string }[] = [
  { key: 'NIFTY', label: 'Nifty 50' },
  { key: 'BANKNIFTY', label: 'Bank Nifty' },
  { key: 'SENSEX', label: 'Sensex' },
];

interface SymbolsResponse {
  success: boolean;
  symbols: string[];
  commodities: { key: string; label: string }[];
}

export interface SymbolSelection {
  symbolType: SymbolType;
  symbol: string;
}

interface Props {
  value: SymbolSelection;
  onChange: (next: SymbolSelection) => void;
}

export default function SymbolPicker({ value, onChange }: Props) {
  const [equities, setEquities] = useState<string[]>([]);
  const [commodities, setCommodities] = useState<{ key: string; label: string }[]>([]);

  useEffect(() => {
    fetch('/api/symbols')
      .then((r) => r.json())
      .then((j: SymbolsResponse) => {
        if (j.success) {
          setEquities(j.symbols ?? []);
          setCommodities(j.commodities ?? []);
        }
      })
      .catch(() => {});
  }, []);

  const optionValue = `${value.symbolType}:${value.symbol}`;

  return (
    <select
      value={optionValue}
      onChange={(e) => {
        const [symbolType, ...rest] = e.target.value.split(':');
        onChange({ symbolType: symbolType as SymbolType, symbol: rest.join(':') });
      }}
      className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold
                 rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 max-w-[220px]"
    >
      <optgroup label="Indices">
        {INDEX_OPTIONS.map((o) => (
          <option key={o.key} value={`index:${o.key}`}>{o.label}</option>
        ))}
      </optgroup>
      <optgroup label="Commodities">
        {commodities.map((o) => (
          <option key={o.key} value={`${o.key === 'CRUDEOIL' ? 'crudeoil' : 'crudeoilm'}:${o.key}`}>{o.label}</option>
        ))}
      </optgroup>
      <optgroup label="Stocks">
        {equities.map((s) => (
          <option key={s} value={`equity:${s}`}>{s}</option>
        ))}
      </optgroup>
    </select>
  );
}
