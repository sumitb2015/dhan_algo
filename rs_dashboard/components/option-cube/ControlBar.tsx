'use client';

import { Sparkles, Filter, SlidersHorizontal } from 'lucide-react';
import type { Goal, Signal } from '@/lib/optionScatter3d';
import { SIGNALS, SIGNAL_COLOR, type ColorMode, type SideFilter, type MoneynessFilter } from './shared';

interface ControlBarProps {
  goal: Goal; setGoal: (g: Goal) => void;
  colorMode: ColorMode; setColorMode: (m: ColorMode) => void;
  sideFilter: SideFilter; setSideFilter: (s: SideFilter) => void;
  moneynessFilter: MoneynessFilter; setMoneynessFilter: (m: MoneynessFilter) => void;
  strikeWindow: number; setStrikeWindow: (n: number) => void;
  minOiPct: number; setMinOiPct: (n: number) => void;
  minLtp: number; setMinLtp: (n: number) => void;
  clip: boolean; setClip: (b: boolean) => void;
}

export function ControlBar({
  goal, setGoal, colorMode, setColorMode, sideFilter, setSideFilter, moneynessFilter, setMoneynessFilter,
  strikeWindow, setStrikeWindow, minOiPct, setMinOiPct, minLtp, setMinLtp, clip, setClip,
}: ControlBarProps) {
  return (
      <div className="flex items-center justify-between gap-3 flex-wrap bg-zinc-900/60 border border-zinc-800 p-3 rounded-2xl w-full min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          {/* Goal selection */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            <button
              onClick={() => setGoal('buy')}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 ${
                goal === 'buy' ? 'bg-emerald-600 text-oncolor shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Sparkles className="w-3.5 h-3.5" />
              Find BUYS
            </button>
            <button
              onClick={() => setGoal('sell')}
              className={`px-3 py-1 rounded-md text-xs font-bold transition-all flex items-center gap-1.5 ${
                goal === 'sell' ? 'bg-rose-600 text-oncolor shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <SlidersHorizontal className="w-3.5 h-3.5" />
              Find SELLS
            </button>
          </div>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />

          {/* Color Mode Selector */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {[
              { id: 'signal', label: 'Signal' },
              { id: 'bearish', label: 'Bearish Heat' },
              { id: 'side', label: 'CE / PE' },
              { id: 'score', label: 'Score' },
              { id: 'iv', label: 'IV Heat' },
            ].map(m => (
              <button
                key={m.id}
                onClick={() => setColorMode(m.id as ColorMode)}
                className={`px-2.5 py-1 rounded-md text-xs font-bold transition-colors ${
                  colorMode === m.id
                    ? m.id === 'bearish'
                      ? 'bg-rose-700 text-oncolor'
                      : 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />

          {/* Side Filter */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {[
              { id: 'ALL', label: 'ALL' },
              { id: 'CE', label: 'CE Only' },
              { id: 'PE', label: 'PE Only' },
            ].map(s => (
              <button
                key={s.id}
                onClick={() => setSideFilter(s.id as SideFilter)}
                className={`px-2 py-1 rounded-md text-xs font-bold transition-colors ${
                  sideFilter === s.id
                    ? s.id === 'CE' ? 'bg-blue-600 text-oncolor' : s.id === 'PE' ? 'bg-amber-600 text-oncolor' : 'bg-zinc-700 text-white'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />

          {/* Moneyness Filter */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {[
              { id: 'ALL', label: 'All Money' },
              { id: 'OTM', label: 'OTM' },
              { id: 'ATM', label: 'ATM' },
              { id: 'ITM', label: 'ITM' },
            ].map(m => (
              <button
                key={m.id}
                onClick={() => setMoneynessFilter(m.id as MoneynessFilter)}
                className={`px-2 py-1 rounded-md text-xs font-bold transition-colors ${
                  moneynessFilter === m.id ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Secondary filters & clipping */}
        <div className="flex items-center gap-3 flex-wrap">
          <label className="flex items-center gap-1.5 text-xs text-zinc-400 font-medium">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Strikes ±</span>
            <select
              value={strikeWindow}
              onChange={e => setStrikeWindow(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2 py-1 focus:outline-none focus:border-emerald-500 tabular-nums"
            >
              {[8, 15, 25, 0].map(v => (
                <option key={v} value={v}>{v === 0 ? 'All' : `±${v}`}</option>
              ))}
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-zinc-400 font-medium">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Min OI</span>
            <select
              value={minOiPct}
              onChange={e => setMinOiPct(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2 py-1 focus:outline-none focus:border-emerald-500 tabular-nums"
            >
              <option value={0}>Any</option>
              <option value={2}>≥ 2% max</option>
              <option value={5}>≥ 5% max</option>
              <option value={10}>≥ 10% max</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-zinc-400 font-medium">
            <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider">Min ₹</span>
            <select
              value={minLtp}
              onChange={e => setMinLtp(Number(e.target.value))}
              className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-lg px-2 py-1 focus:outline-none focus:border-emerald-500 tabular-nums"
            >
              <option value={0}>Any</option>
              <option value={3}>₹3</option>
              <option value={5}>₹5</option>
              <option value={10}>₹10</option>
            </select>
          </label>

          <label className="flex items-center gap-1.5 text-xs text-zinc-300 font-semibold cursor-pointer">
            <input
              type="checkbox"
              checked={clip}
              onChange={e => setClip(e.target.checked)}
              className="accent-emerald-500 w-3.5 h-3.5 rounded"
            />
            Clip 2-98%
          </label>
        </div>
      </div>
  );
}

interface PillsProps {
  selectedSignals: Set<Signal>;
  toggleSignal: (s: Signal) => void;
  pointCount: number;
  clip: boolean;
  clippedTotal: number;
}

export function SignalPills({ selectedSignals, toggleSignal, pointCount, clip, clippedTotal }: PillsProps) {
  return (
      <div className="flex items-center justify-between gap-3 px-1 flex-wrap text-xs w-full min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider flex items-center gap-1 mr-1">
            <Filter className="w-3 h-3 text-zinc-400" />
            Signals:
          </span>
          {SIGNALS.map(sig => {
            const active = selectedSignals.has(sig);
            const color = SIGNAL_COLOR[sig];
            return (
              <button
                key={sig}
                onClick={() => toggleSignal(sig)}
                style={{ borderColor: active ? color : 'transparent' }}
                className={`px-2.5 py-0.5 rounded-full border text-[11px] font-semibold transition-all flex items-center gap-1.5 ${
                  active
                    ? 'bg-zinc-900 text-white shadow-sm'
                    : 'bg-zinc-900/40 text-zinc-500 hover:text-zinc-300'
                }`}
              >
                <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: color }} />
                {sig}
              </button>
            );
          })}
        </div>

        <div className="flex items-center gap-2 text-zinc-400 text-xs font-mono">
          <span className="text-zinc-200 font-bold">{pointCount}</span>
          <span className="text-zinc-500">strikes shown</span>
          {clip && clippedTotal > 0 && (
            <span className="text-amber-400 text-[11px]">({clippedTotal} outliers clipped)</span>
          )}
        </div>
      </div>
  );
}
