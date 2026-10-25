'use client';

import { X, Plus, Trash2 } from 'lucide-react';
import { atmOffsetLabel } from '@/lib/priceLadder';
import { validateDraft, MAX_BASKET_LEGS, MAX_BASKET_RATIO, type DraftLeg } from '@/lib/priceLadderBasket';
import { FOCUS_RING } from '@/components/Scalper';

// The Basket ladder's "Edit legs" pop-up: change a leg's side, CE / PE, strike or ratio, remove it, or add one. The page
// holds the draft; every change re-prices the ladder at once. The server re-validates the legs (never trusts this list).

interface Props {
  name: string;
  legs: DraftLeg[];
  strikes: readonly number[];
  atmStrike: number | null;
  /** Live premium per leg, in the order of `legs` (null = no price yet). */
  prices: readonly (number | null)[];
  /** The legs are in an armed / open basket: the draft cannot change under it. */
  locked: boolean;
  /** The far expiry of a calendar / diagonal (null = single-expiry basket): a leg can be set to it. */
  farExpiry?: string | null;
  onChange: (legs: DraftLeg[]) => void;
  onReset: () => void;
  onClose: () => void;
}

const cell = 'px-1.5 py-1';
const sel = `px-1.5 py-0.5 rounded bg-zinc-900 border border-zinc-700 text-zinc-100 text-xs ${FOCUS_RING}`;

export function BasketLegsModal({ name, legs, strikes, atmStrike, prices, locked, farExpiry, onChange, onReset, onClose }: Props) {
  const set = (i: number, patch: Partial<DraftLeg>) => onChange(legs.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const add = () => {
    const last = legs[legs.length - 1];
    onChange([...legs, { side: 'BUY', opt: last?.opt ?? 'CE', strike: atmStrike ?? last?.strike ?? strikes[0] ?? 0, ratio: 1 }]);
  };
  const problem = validateDraft(legs);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 p-4" role="dialog" aria-modal="true" aria-label="Edit basket legs">
      <div className="w-full max-w-2xl rounded-xl border border-zinc-800 bg-zinc-950 p-4 flex flex-col gap-3 shadow-2xl">
        <div className="flex items-center justify-between">
          <p className="text-sm font-bold text-white">Edit legs · {name}</p>
          <button type="button" onClick={onClose} aria-label="Close" className={`p-1 rounded text-zinc-400 hover:text-white ${FOCUS_RING}`}><X className="w-4 h-4" /></button>
        </div>
        {locked && <p className="text-xs text-amber-300">These legs are in an armed or open basket — cancel or exit it to change them.</p>}
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-left text-zinc-400">
                <th className={`${cell} font-bold`}>Side</th><th className={`${cell} font-bold`}>Type</th><th className={`${cell} font-bold`}>Strike</th>
                <th className={`${cell} font-bold`}>Ratio</th>{farExpiry && <th className={`${cell} font-bold`}>Expiry</th>}<th className={`${cell} font-bold text-right`}>Premium</th><th className={cell} />
              </tr>
            </thead>
            <tbody>
              {legs.map((l, i) => (
                <tr key={i} className="border-t border-zinc-800">
                  <td className={cell}>
                    <select aria-label={`Leg ${i + 1} side`} disabled={locked} value={l.side} onChange={e => set(i, { side: e.target.value as DraftLeg['side'] })}
                      className={`${sel} ${l.side === 'BUY' ? 'text-emerald-400' : 'text-red-400'}`}>
                      <option value="BUY">BUY</option><option value="SELL">SELL</option>
                    </select>
                  </td>
                  <td className={cell}>
                    <select aria-label={`Leg ${i + 1} type`} disabled={locked} value={l.opt} onChange={e => set(i, { opt: e.target.value as DraftLeg['opt'] })} className={sel}>
                      <option value="CE">CE</option><option value="PE">PE</option>
                    </select>
                  </td>
                  <td className={cell}>
                    <select aria-label={`Leg ${i + 1} strike`} disabled={locked} value={l.strike} onChange={e => set(i, { strike: Number(e.target.value) })} className={`${sel} font-mono`}>
                      {!strikes.includes(l.strike) && <option value={l.strike}>{l.strike}</option>}
                      {strikes.map(k => { const off = atmOffsetLabel([...strikes], atmStrike, k); return <option key={k} value={k}>{off ? `${k} · ${off}` : k}</option>; })}
                    </select>
                  </td>
                  <td className={cell}>
                    <select aria-label={`Leg ${i + 1} ratio`} disabled={locked} value={l.ratio} onChange={e => set(i, { ratio: Number(e.target.value) })} className={`${sel} font-mono`}>
                      {Array.from({ length: MAX_BASKET_RATIO }, (_, n) => n + 1).map(n => <option key={n} value={n}>×{n}</option>)}
                    </select>
                  </td>
                  {farExpiry && (
                    <td className={cell}>
                      <select aria-label={`Leg ${i + 1} expiry`} disabled={locked} value={l.far ? 'far' : 'near'} onChange={e => set(i, { far: e.target.value === 'far' })} className={sel}>
                        <option value="near">Near</option><option value="far">Far {farExpiry}</option>
                      </select>
                    </td>
                  )}
                  <td className={`${cell} text-right font-mono text-zinc-300`}>{prices[i] != null ? prices[i]!.toFixed(2) : '—'}</td>
                  <td className={`${cell} text-right`}>
                    <button type="button" disabled={locked || legs.length <= 1} onClick={() => onChange(legs.filter((_, j) => j !== i))}
                      aria-label={`Remove leg ${i + 1}`} title="Remove this leg"
                      className={`p-1 rounded text-zinc-400 hover:text-red-400 disabled:opacity-30 ${FOCUS_RING}`}><Trash2 className="w-3.5 h-3.5" /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {problem && <p className="text-xs text-red-300" role="alert">{problem}</p>}
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <button type="button" disabled={locked || legs.length >= MAX_BASKET_LEGS} onClick={add}
              className={`flex items-center gap-1 px-2.5 py-1 rounded-md border border-zinc-700 text-xs font-semibold text-zinc-200 hover:text-white disabled:opacity-40 ${FOCUS_RING}`}>
              <Plus className="w-3.5 h-3.5 text-emerald-400" /> Add leg
            </button>
            <button type="button" disabled={locked} onClick={onReset}
              className={`px-2.5 py-1 rounded-md border border-zinc-700 text-xs text-zinc-300 hover:text-white disabled:opacity-40 ${FOCUS_RING}`}>Reset to template</button>
          </div>
          <button type="button" onClick={onClose} className={`px-3 py-1.5 rounded-md bg-emerald-600 hover:bg-emerald-500 text-oncolor text-xs font-bold ${FOCUS_RING}`}>Done</button>
        </div>
      </div>
    </div>
  );
}
