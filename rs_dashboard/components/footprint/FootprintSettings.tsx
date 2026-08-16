'use client';

import React, { useMemo, useState } from 'react';
import { RefreshCw, Search, SlidersHorizontal } from 'lucide-react';
import type { VolumeEngine } from '@/lib/volumeProfile';
import type { UniverseIndex } from '@/app/api/volume-footprint/universe/route';

export type Universe = 'indices' | 'stocks';

export interface FootprintConfig {
  universe: Universe;
  symbol: string;
  tfMinutes: number;
  engine: VolumeEngine;
  days: number;
  windowBars: number;
  ticksAboveBelow: number;
  volumeConcentration: number;
  tickSize: number;
  imbalancePct: number;
  valueAreaPct: number;
  profilePeriod: number;
  profileResolution: number;
  balanceTiltPct: number;
  residualTolerancePpm: number;
  showTable: boolean;
}

export const DEFAULT_CONFIG: FootprintConfig = {
  universe: 'indices',
  symbol: 'NIFTY',
  tfMinutes: 15,
  engine: 'geometric',
  days: 5,
  windowBars: 5,
  ticksAboveBelow: 8,
  volumeConcentration: 3,
  tickSize: 0.05,
  imbalancePct: 300,
  valueAreaPct: 70,
  profilePeriod: 80,
  profileResolution: 160,
  balanceTiltPct: 5,
  residualTolerancePpm: 1,
  showTable: true,
};

const TIMEFRAMES = [1, 3, 5, 15, 30, 60];

function Slider({
  label, value, min, max, step, onChange,
}: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between">
        <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium">{label}</span>
        <span className="text-[11px] font-mono font-semibold text-zinc-200">{value}</span>
      </div>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full h-1 accent-emerald-400 bg-zinc-800 rounded-full appearance-none cursor-pointer"
      />
    </div>
  );
}

function SegButton({
  active, onClick, children,
}: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 px-2 py-1 rounded text-[11px] font-semibold transition border ${
        active
          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
          : 'bg-zinc-950 text-zinc-400 border-zinc-800 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

interface Props {
  config: FootprintConfig;
  onChange: (patch: Partial<FootprintConfig>) => void;
  indices: UniverseIndex[];
  stocks: string[];
  onRefresh: () => void;
  loading: boolean;
  /** Tick size derived from the loaded bars; 0 while nothing is loaded. */
  suggestedTickSize: number;
}

export default function FootprintSettings({
  config, onChange, indices, stocks, onRefresh, loading, suggestedTickSize,
}: Props) {
  const [query, setQuery] = useState('');

  const options = useMemo(() => {
    const list =
      config.universe === 'indices'
        ? indices.map((i) => ({ value: i.symbol, label: i.label }))
        : stocks.map((s) => ({ value: s, label: s }));
    const q = query.trim().toUpperCase();
    return q ? list.filter((o) => o.value.includes(q) || o.label.toUpperCase().includes(q)) : list;
  }, [config.universe, indices, stocks, query]);

  const count = config.universe === 'indices' ? indices.length : stocks.length;

  return (
    <aside className="w-64 shrink-0 border-r border-zinc-800 bg-zinc-950 flex flex-col max-h-screen overflow-y-auto">
      <div className="flex items-center gap-2 px-3 py-3 border-b border-zinc-800 sticky top-0 bg-zinc-950 z-10">
        <SlidersHorizontal className="w-4 h-4 text-emerald-400" />
        <span className="text-xs font-bold text-white">Settings</span>
      </div>

      <div className="p-3 flex flex-col gap-4">
        {/* Universe */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium">Universe</span>
          <div className="flex gap-1.5">
            <SegButton active={config.universe === 'indices'} onClick={() => onChange({ universe: 'indices' })}>
              Indices
            </SegButton>
            <SegButton active={config.universe === 'stocks'} onClick={() => onChange({ universe: 'stocks' })}>
              F&amp;O stocks
            </SegButton>
          </div>
        </div>

        {/* Symbol */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium">
            {config.universe === 'indices' ? 'Index' : 'F&O stock'} ({count})
          </span>
          <div className="relative">
            <Search className="w-3 h-3 text-zinc-500 absolute left-2 top-1/2 -translate-y-1/2" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search RELIANCE, TCS…"
              className="w-full bg-zinc-900 border border-zinc-800 rounded pl-6 pr-2 py-1.5 text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-emerald-600"
            />
          </div>
          <select
            value={config.symbol}
            onChange={(e) => onChange({ symbol: e.target.value })}
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-emerald-600"
          >
            {!options.some((o) => o.value === config.symbol) && (
              <option value={config.symbol}>{config.symbol}</option>
            )}
            {options.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        {/* Timeframe */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium">Chart timeframe</span>
          <select
            value={config.tfMinutes}
            onChange={(e) => onChange({ tfMinutes: Number(e.target.value) })}
            className="w-full bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[11px] text-zinc-200 focus:outline-none focus:border-emerald-600"
          >
            {TIMEFRAMES.map((m) => (
              <option key={m} value={m}>{m}m</option>
            ))}
          </select>
        </div>

        {/* Engine */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium">Volume engine</span>
          <div className="flex gap-1.5">
            <SegButton active={config.engine === 'geometric'} onClick={() => onChange({ engine: 'geometric' })}>
              Geometric
            </SegButton>
            <SegButton active={config.engine === 'intrabar'} onClick={() => onChange({ engine: 'intrabar' })}>
              Intrabar
            </SegButton>
          </div>
          <p className="text-[10px] text-zinc-500 leading-snug">
            Dhan serves no bid/ask tick history, so the buy/sell split is estimated, not
            observed. Geometric models each candle&apos;s o→h→l→c path; Intrabar attributes each
            1-minute print by its own direction.
          </p>
        </div>

        {/* Data depth */}
        <div className="flex flex-col gap-1.5">
          <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium">Sessions loaded</span>
          <div className="flex gap-1.5">
            {[1, 3, 5, 10].map((d) => (
              <SegButton key={d} active={config.days === d} onClick={() => onChange({ days: d })}>
                {d}D
              </SegButton>
            ))}
          </div>
        </div>

        <div className="border-t border-zinc-800 pt-3 flex flex-col gap-3">
          <Slider label="Window bars" value={config.windowBars} min={1} max={30} step={1}
            onChange={(v) => onChange({ windowBars: v })} />
          <Slider label="Ticks above/below" value={config.ticksAboveBelow} min={2} max={40} step={1}
            onChange={(v) => onChange({ ticksAboveBelow: v })} />
          <Slider label="Volume concentration" value={config.volumeConcentration} min={0} max={10} step={0.5}
            onChange={(v) => onChange({ volumeConcentration: v })} />

          <div className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-wide text-zinc-400 font-medium">Tick size</span>
            <div className="flex gap-1.5">
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={config.tickSize}
                onChange={(e) => onChange({ tickSize: Math.max(Number(e.target.value) || 0.05, 0.01) })}
                className="flex-1 min-w-0 bg-zinc-900 border border-zinc-800 rounded px-2 py-1.5 text-[11px] font-mono text-zinc-200 focus:outline-none focus:border-emerald-600"
              />
              <button
                onClick={() => onChange({ tickSize: suggestedTickSize })}
                disabled={!suggestedTickSize}
                title={`Size the ladder to this instrument (${suggestedTickSize || '—'})`}
                className="px-2 rounded text-[11px] font-semibold border bg-zinc-950 text-zinc-300 border-zinc-800 hover:text-emerald-300 hover:border-emerald-700 disabled:opacity-40 transition"
              >
                Auto
              </button>
            </div>
            <p className="text-[10px] text-zinc-500 leading-snug">
              NSE&apos;s real tick is 0.05 for every symbol, which on a ₹3,000 stock leaves almost
              all of a bar&apos;s volume outside the visible rows. Auto sizes it to the instrument.
            </p>
          </div>

          <Slider label="Imbalance %" value={config.imbalancePct} min={100} max={600} step={10}
            onChange={(v) => onChange({ imbalancePct: v })} />
          <Slider label="Value area %" value={config.valueAreaPct} min={30} max={100} step={1}
            onChange={(v) => onChange({ valueAreaPct: v })} />
          <Slider label="Profile period (bars)" value={config.profilePeriod} min={10} max={400} step={5}
            onChange={(v) => onChange({ profilePeriod: v })} />
          <Slider label="Profile resolution" value={config.profileResolution} min={20} max={400} step={10}
            onChange={(v) => onChange({ profileResolution: v })} />
          <Slider label="Balance tilt %" value={config.balanceTiltPct} min={1} max={50} step={1}
            onChange={(v) => onChange({ balanceTiltPct: v })} />
          <Slider label="Residual tolerance ppm" value={config.residualTolerancePpm} min={0} max={100} step={1}
            onChange={(v) => onChange({ residualTolerancePpm: v })} />
        </div>

        <label className="flex items-center justify-between cursor-pointer border-t border-zinc-800 pt-3">
          <span className="text-[11px] text-zinc-300">Show footprint table</span>
          <input
            type="checkbox"
            checked={config.showTable}
            onChange={(e) => onChange({ showTable: e.target.checked })}
            className="accent-emerald-500 w-4 h-4 cursor-pointer"
          />
        </label>

        <button
          onClick={onRefresh}
          disabled={loading}
          className="flex items-center justify-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-zinc-950 font-bold px-3 py-1.5 rounded text-[11px] transition"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh data
        </button>
      </div>
    </aside>
  );
}
