'use client';

import React from 'react';
import { Plus, Trash2, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { BasketLeg, OptionType } from '@/lib/basketStrategies';

/** Compact −/+ stepper used in the legs table. */
function Stepper({ value, onDec, onInc, valueClass = '' }: {
  value: React.ReactNode; onDec: () => void; onInc: () => void; valueClass?: string;
}) {
  return (
    <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <button onClick={onDec}
        className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
        <span className="text-xs font-bold">−</span>
      </button>
      <span className={`font-mono font-bold text-xs tabular-nums text-center px-1 ${valueClass}`}>{value}</span>
      <button onClick={onInc}
        className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
        <Plus className="w-3 h-3" />
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
    <>
      <div className="flex items-center gap-2 px-4 py-3 border-b border-zinc-800 bg-zinc-900/40 flex-wrap">
        <span className="text-xs font-bold text-zinc-300 uppercase tracking-widest">
          Legs{legs.length > 0 ? ` · ${legs.length}` : ''}
        </span>
        <Button size="sm" onClick={onAddLeg} className="h-7 px-2.5 text-[11px]">
          <Plus className="w-3 h-3" /> Add Leg
        </Button>
        {legs.length > 0 && (
          <Button size="sm" variant="ghost" onClick={onClearAll}
            className="h-7 px-2.5 text-[11px] hover:text-rose-300">
            <X className="w-3 h-3" /> Clear
          </Button>
        )}
      </div>

      {legs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-1.5">
          <p className="text-sm font-semibold text-zinc-400">No legs yet</p>
          <p className="text-xs text-zinc-500">Pick a predefined strategy above or add legs manually</p>
        </div>
      ) : (
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col className="w-[8%]" /><col className="w-[18%]" /><col className="w-[9%]" />
            <col className="w-[10%]" /><col className="w-[11%]" /><col className="w-[13%]" />
            <col className="w-[11%]" /><col className="w-[10%]" /><col className="w-[5%]" />
          </colgroup>
          <thead>
            <tr className="text-xs font-bold text-white border-b border-zinc-800 bg-zinc-800">
              <th className="px-3 py-2.5 text-left">B/S</th>
              <th className="px-2 py-2.5 text-center">Strike</th>
              <th className="px-2 py-2.5 text-center">CE/PE</th>
              <th className="px-2 py-2.5 text-center">Lots</th>
              <th className="px-2 py-2.5 text-center">Type</th>
              <th className="px-2 py-2.5 text-right">Price</th>
              <th className="px-3 py-2.5 text-right">LTP</th>
              <th className="px-2 py-2.5 text-center">Expiry</th>
              <th className="px-2 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {legs.map(leg => {
              const ltp = autoPremium(leg.strike, leg.option, leg.expiry);
              const isFar = leg.expiry !== frontExpiry;
              const canToggle = !!farExpiry && farExpiry !== frontExpiry;
              return (
                <tr key={leg.id} className="border-b border-zinc-800/60 hover:bg-zinc-900/30 transition-colors">
                  <td className="px-3 py-2.5">
                    <button onClick={() => onUpdateLeg(leg.id, { side: leg.side === 'B' ? 'S' : 'B' })}
                      title={leg.side === 'B' ? 'Buy — click to flip to Sell' : 'Sell — click to flip to Buy'}
                      className={`w-8 h-8 rounded-lg font-bold border transition-all ${
                        leg.side === 'B'
                          ? 'bg-emerald-500/10 text-emerald-300 border-emerald-500/40'
                          : 'bg-rose-500/10 text-rose-300 border-rose-500/40'
                      }`}>
                      {leg.side}
                    </button>
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <Stepper
                      value={
                        <span className={`w-14 inline-block ${leg.strike === atmStrike ? 'text-yellow-300' : 'text-zinc-200'}`}>
                          {leg.strike}
                        </span>
                      }
                      onDec={() => onStepStrike(leg.id, -1)}
                      onInc={() => onStepStrike(leg.id, 1)}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <button onClick={() => onUpdateLeg(leg.id, { option: leg.option === 'CE' ? 'PE' : 'CE', price: '' })}
                      className={`w-10 h-8 rounded-lg font-bold border transition-all ${
                        leg.option === 'CE'
                          ? 'bg-sky-500/10 text-sky-300 border-sky-500/40'
                          : 'bg-violet-500/10 text-violet-300 border-violet-500/40'
                      }`}>
                      {leg.option}
                    </button>
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <Stepper
                      value={<span className="w-5 inline-block">{leg.lots}</span>}
                      onDec={() => onUpdateLeg(leg.id, { lots: Math.max(1, leg.lots - 1) })}
                      onInc={() => onUpdateLeg(leg.id, { lots: Math.min(100, leg.lots + 1) })}
                    />
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <select value={leg.type}
                      onChange={e => onUpdateLeg(leg.id, { type: e.target.value as 'MARKET' | 'LIMIT' })}
                      className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-[11px] font-semibold rounded-lg px-1.5 focus:outline-none focus:border-emerald-500">
                      <option value="MARKET">MKT</option>
                      <option value="LIMIT">LMT</option>
                    </select>
                  </td>
                  <td className="px-2 py-2.5 text-right">
                    <Input type="number" min="0" step="0.05" value={leg.price}
                      placeholder={ltp > 0 ? ltp.toFixed(2) : '—'}
                      onChange={e => onUpdateLeg(leg.id, { price: e.target.value })}
                      className="h-8 w-24 max-w-full ml-auto text-[11px] text-right placeholder:text-zinc-500" />
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono tabular-nums text-zinc-300">
                    {ltp > 0 ? ltp.toFixed(2) : '—'}
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <button
                      disabled={!canToggle}
                      onClick={() => onUpdateLeg(leg.id, { expiry: isFar ? frontExpiry : farExpiry, price: '' })}
                      title={canToggle ? 'Toggle between front and far expiry' : leg.expiry}
                      className={`px-1.5 py-1 rounded-md font-bold border text-[10px] transition-all disabled:opacity-50 disabled:cursor-default ${
                        isFar
                          ? 'bg-fuchsia-500/10 text-fuchsia-300 border-fuchsia-500/40'
                          : 'bg-zinc-800/60 text-zinc-400 border-zinc-700'
                      }`}>
                      {isFar ? 'FAR' : 'FRONT'}
                    </button>
                  </td>
                  <td className="px-2 py-2.5 text-center">
                    <button onClick={() => onRemoveLeg(leg.id)}
                      className="text-zinc-600 hover:text-rose-400 transition-all p-1" aria-label="Remove leg">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </>
  );
}
