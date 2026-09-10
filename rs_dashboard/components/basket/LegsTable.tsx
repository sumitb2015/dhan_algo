'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trash2, X, ShoppingBasket } from 'lucide-react';
import type { BasketLeg, OptionType } from '@/lib/basketStrategies';

/** Commit-on-blur input adhering to dhan-commit-on-blur skill */
function PriceInput({
  value,
  placeholder,
  onCommit,
}: {
  value: string;
  placeholder: string;
  onCommit: (val: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const focusedRef = useRef(false);

  useEffect(() => {
    if (!focusedRef.current) setDraft(value);
  }, [value]);

  const commit = (next: string) => {
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="number"
      min="0"
      step="0.05"
      value={draft}
      placeholder={placeholder}
      onFocus={() => { focusedRef.current = true; }}
      onChange={e => setDraft(e.target.value)}
      onBlur={e => {
        focusedRef.current = false;
        commit(e.currentTarget.value);
      }}
      onKeyDown={e => {
        if (e.key === 'Enter') {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur();
        }
        if (e.key === 'Escape') {
          setDraft(value);
          (e.target as HTMLInputElement).blur();
        }
      }}
      className="h-7 w-20 ml-auto bg-zinc-950 border border-zinc-700 rounded-md px-1.5 py-0.5 text-[11px] font-mono tabular-nums text-right text-zinc-200 placeholder:text-zinc-600 focus:outline-none focus:border-amber-500/60 transition-colors"
    />
  );
}

/** Compact −/+ stepper used in the legs table. */
function Stepper({ value, onDec, onInc, valueClass = '' }: {
  value: React.ReactNode; onDec: () => void; onInc: () => void; valueClass?: string;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-950/80 overflow-hidden shadow-inner">
      <button
        type="button"
        onClick={onDec}
        className="w-6 h-7 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
      >
        <span className="text-xs font-bold font-mono">−</span>
      </button>
      <span className={`font-mono font-bold text-xs tabular-nums text-center px-1 ${valueClass}`}>
        {value}
      </span>
      <button
        type="button"
        onClick={onInc}
        className="w-6 h-7 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
      >
        <span className="text-xs font-bold font-mono">+</span>
      </button>
    </div>
  );
}

interface LegsTableProps {
  legs: BasketLeg[];
  atmStrike: number | null;
  allStrikes: number[];
  autoPremium: (strike: number, option: OptionType, legExpiry?: string) => number;
  onUpdateLeg: (id: string, patch: Partial<BasketLeg>) => void;
  onStepStrike: (id: string, dir: 1 | -1) => void;
  onAddLeg: () => void;
  onRemoveLeg: (id: string) => void;
  onClearAll: () => void;
  /** Front (main) expiry — legs matching it show "FRONT"; anything else shows "FAR". */
  frontExpiry: string;
  /** Far-month expiry a leg toggles to, when it differs from frontExpiry. */
  farExpiry: string;
}

export default function LegsTable({
  legs, atmStrike, autoPremium, onUpdateLeg, onStepStrike, onAddLeg, onRemoveLeg, onClearAll,
  frontExpiry, farExpiry,
}: LegsTableProps) {
  return (
    <div className="flex flex-col">
      {/* Sub-header inside panel */}
      <div className="flex items-center justify-between gap-2 px-3.5 py-2 border-b border-zinc-800 bg-zinc-950/60 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-400">
            CONFIGURED LEGS ({legs.length})
          </span>
          {atmStrike && (
            <span className="font-mono text-[10px] text-zinc-500">
              ATM: <span className="text-amber-400 font-bold">{atmStrike}</span>
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onAddLeg}
            className="flex items-center gap-1 px-2.5 py-1 text-[11px] font-mono font-bold rounded-md border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-all cursor-pointer"
          >
            <Plus className="w-3 h-3" />
            <span>ADD LEG</span>
          </button>
          {legs.length > 0 && (
            <button
              type="button"
              onClick={onClearAll}
              className="flex items-center gap-1 px-2 py-1 text-[11px] font-mono text-zinc-400 hover:text-red-400 hover:bg-red-500/10 rounded-md transition-all cursor-pointer"
            >
              <X className="w-3 h-3" />
              <span>CLEAR</span>
            </button>
          )}
        </div>
      </div>

      {legs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 px-4 gap-2 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900/60 text-zinc-500">
            <ShoppingBasket className="h-5 w-5 text-zinc-400" />
          </div>
          <p className="text-xs font-bold text-zinc-300 font-mono tracking-wide uppercase">No Legs Staged</p>
          <p className="text-[11px] text-zinc-500 max-w-sm">
            Select a strategy template from the catalog above or click &ldquo;+ Add Leg&rdquo; to build custom multi-leg positions.
          </p>
          <button
            type="button"
            onClick={onAddLeg}
            className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold rounded-lg border border-emerald-500/40 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20 transition-colors cursor-pointer"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Stage First Leg</span>
          </button>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full table-fixed text-xs border-collapse">
            <colgroup>
              <col className="w-[8%]" />
              <col className="w-[20%]" />
              <col className="w-[10%]" />
              <col className="w-[13%]" />
              <col className="w-[10%]" />
              <col className="w-[13%]" />
              <col className="w-[11%]" />
              <col className="w-[10%]" />
              <col className="w-[5%]" />
            </colgroup>
            <thead>
              <tr className="text-xs font-bold text-white border-b border-zinc-800 bg-zinc-800">
                <th className="px-3 py-2 text-left uppercase tracking-wider">Side</th>
                <th className="px-2 py-2 text-center uppercase tracking-wider">Strike</th>
                <th className="px-2 py-2 text-center uppercase tracking-wider">Option</th>
                <th className="px-2 py-2 text-center uppercase tracking-wider">Lots</th>
                <th className="px-2 py-2 text-center uppercase tracking-wider">Type</th>
                <th className="px-2 py-2 text-right uppercase tracking-wider">Price</th>
                <th className="px-3 py-2 text-right uppercase tracking-wider">LTP</th>
                <th className="px-2 py-2 text-center uppercase tracking-wider">Expiry</th>
                <th className="px-2 py-2 text-center uppercase tracking-wider" />
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 font-mono text-xs">
              {legs.map(leg => {
                const ltp = autoPremium(leg.strike, leg.option, leg.expiry);
                const isFar = leg.expiry !== frontExpiry;
                const canToggle = !!farExpiry && farExpiry !== frontExpiry;
                const isAtm = leg.strike === atmStrike;

                return (
                  <tr key={leg.id} className="hover:bg-zinc-800/40 transition-colors">
                    {/* B / S */}
                    <td className="px-3 py-2">
                      <button
                        type="button"
                        onClick={() => onUpdateLeg(leg.id, { side: leg.side === 'B' ? 'S' : 'B' })}
                        title={leg.side === 'B' ? 'Buy — click to flip to Sell' : 'Sell — click to flip to Buy'}
                        className={`w-7 h-7 rounded font-mono font-bold text-xs border transition-all ${
                          leg.side === 'B'
                            ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/40 hover:bg-emerald-500/20'
                            : 'bg-red-500/10 text-red-400 border-red-500/40 hover:bg-red-500/20'
                        }`}
                      >
                        {leg.side}
                      </button>
                    </td>

                    {/* Strike */}
                    <td className="px-2 py-2 text-center">
                      <div className="inline-flex items-center gap-1">
                        <Stepper
                          value={
                            <span className={`w-14 inline-block font-bold ${isAtm ? 'text-amber-400' : 'text-zinc-100'}`}>
                              {leg.strike}
                            </span>
                          }
                          onDec={() => onStepStrike(leg.id, -1)}
                          onInc={() => onStepStrike(leg.id, 1)}
                        />
                        {isAtm && (
                          <span className="hidden xl:inline-block rounded px-1 py-0.5 text-[8px] font-bold border border-amber-500/30 bg-amber-500/10 text-amber-400">
                            ATM
                          </span>
                        )}
                      </div>
                    </td>

                    {/* CE / PE */}
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => onUpdateLeg(leg.id, { option: leg.option === 'CE' ? 'PE' : 'CE', price: '' })}
                        className={`w-9 h-7 rounded font-mono font-bold text-xs border transition-all ${
                          leg.option === 'CE'
                            ? 'bg-sky-500/10 text-sky-400 border-sky-500/40 hover:bg-sky-500/20'
                            : 'bg-amber-500/10 text-amber-400 border-amber-500/40 hover:bg-amber-500/20'
                        }`}
                      >
                        {leg.option}
                      </button>
                    </td>

                    {/* Lots */}
                    <td className="px-2 py-2 text-center">
                      <Stepper
                        value={<span className="w-5 inline-block text-zinc-200">{leg.lots}</span>}
                        onDec={() => onUpdateLeg(leg.id, { lots: Math.max(1, leg.lots - 1) })}
                        onInc={() => onUpdateLeg(leg.id, { lots: Math.min(100, leg.lots + 1) })}
                      />
                    </td>

                    {/* Order Type */}
                    <td className="px-2 py-2 text-center">
                      <select
                        value={leg.type}
                        onChange={e => onUpdateLeg(leg.id, { type: e.target.value as 'MARKET' | 'LIMIT' })}
                        className="h-7 bg-zinc-950 border border-zinc-700 text-zinc-200 text-[10px] font-mono font-semibold rounded-md px-1.5 focus:outline-none focus:border-amber-500/60"
                      >
                        <option value="MARKET">MKT</option>
                        <option value="LIMIT">LMT</option>
                      </select>
                    </td>

                    {/* Price Input (commit-on-blur) */}
                    <td className="px-2 py-2 text-right">
                      <PriceInput
                        value={leg.price}
                        placeholder={ltp > 0 ? ltp.toFixed(2) : '—'}
                        onCommit={val => onUpdateLeg(leg.id, { price: val })}
                      />
                    </td>

                    {/* LTP */}
                    <td className="px-3 py-2 text-right font-mono tabular-nums text-zinc-200 font-bold">
                      {ltp > 0 ? `₹${ltp.toFixed(2)}` : '—'}
                    </td>

                    {/* Expiry */}
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        disabled={!canToggle}
                        onClick={() => onUpdateLeg(leg.id, { expiry: isFar ? frontExpiry : farExpiry, price: '' })}
                        title={canToggle ? 'Toggle between front and far expiry' : leg.expiry}
                        className={`px-1.5 py-1 rounded font-mono font-bold text-[9px] border transition-all disabled:opacity-50 disabled:cursor-default ${
                          isFar
                            ? 'bg-fuchsia-500/10 text-fuchsia-400 border-fuchsia-500/40'
                            : 'bg-zinc-800 text-zinc-400 border-zinc-700'
                        }`}
                      >
                        {isFar ? 'FAR' : 'FRONT'}
                      </button>
                    </td>

                    {/* Remove Action */}
                    <td className="px-2 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => onRemoveLeg(leg.id)}
                        className="text-zinc-500 hover:text-red-400 hover:bg-red-500/10 p-1 rounded transition-all cursor-pointer"
                        aria-label="Remove leg"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
