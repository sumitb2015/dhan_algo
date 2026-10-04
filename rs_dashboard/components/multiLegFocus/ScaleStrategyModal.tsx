'use client';

/**
 * ScaleStrategyModal — preview and confirm "add N more copies of this strategy".
 *
 * Shows exactly what will be ordered (lots per leg before/after), the estimated extra margin against
 * available funds, and blocks the confirm when margin is unverified or insufficient. The handler in
 * MultiLegFocus.scaleStrategy re-checks all of this live; this dialog is the human-facing preview.
 */

import React, { useEffect, useState } from 'react';
import { X, Minus, Plus, Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FOCUS_RING } from '../Scalper';
import { planScale, scalePlanSignature, type MultiLegBasket } from '@/lib/multiLegFocus';

interface Props {
  isOpen: boolean;
  onClose: () => void;
  basket: MultiLegBasket;
  title: string;
  /** Required margin for the strategy's CURRENT open legs (null until the broker calculator answers). */
  currentMargin?: number | null;
  marginSource?: 'live' | 'estimate';
  /** Available funds on the strategy's own account, null when unknown. */
  availableFunds?: number | null;
  /** `signature` fingerprints the plan the user saw; the handler refuses to run a different one. */
  onConfirm: (delta: number, signature: string) => Promise<void>;
}

const money = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;

export default function ScaleStrategyModal({
  isOpen, onClose, basket, title, currentMargin = null, marginSource, availableFunds = null, onConfirm,
}: Props) {
  const [delta, setDelta] = useState(1);
  const [draft, setDraft] = useState('1');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !submitting) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, submitting, onClose]);

  if (!isOpen) return null;

  const plan = planScale(basket, Math.max(1, delta));
  const clamp = (n: number) => Math.min(Math.max(1, Math.round(n) || 1), Math.max(plan.maxDelta, 1));
  const commit = (n: number) => { const v = clamp(n); setDelta(v); setDraft(String(v)); };

  // Margin is roughly linear in lots for the same structure, so the extra is the current margin scaled
  // by the lots being added. It is an estimate; the live gate in the handler is the authority.
  const extra = currentMargin != null && plan.totalLots > 0 ? currentMargin * (plan.addTotalLots / plan.totalLots) : null;
  const blocked: string | null =
    plan.legs.length === 0 ? 'This strategy has no open legs to scale.'
    : plan.maxDelta < 1 ? 'Already at the 50× limit.'
    : delta > plan.maxDelta ? `At most +${plan.maxDelta}× fits under the 50× limit.`
    : plan.legs.some(p => !(p.addLots >= 1)) ? 'A leg has no valid lot ratio to scale from. Add lots to it directly instead.'
    : extra == null ? 'Margin not verified yet. Wait a moment and reopen.'
    : availableFunds == null ? 'Available funds could not be read for this account.'
    : extra > availableFunds ? `Needs about ${money(extra)} but only ${money(availableFunds)} is available.`
    : null;

  const submit = async () => {
    if (blocked || submitting) return;
    setSubmitting(true);
    try { await onConfirm(delta, scalePlanSignature(plan)); onClose(); } finally { setSubmitting(false); }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Scale strategy">
      <div className="flex w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-950 shadow-2xl">
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900 px-5 py-4">
          <div>
            <h2 className="text-sm font-bold text-zinc-100">Scale {title}</h2>
            <p className="text-xs text-zinc-400">Places real market orders on {basket.underlying} {basket.expiry}.</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className={cn('rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200', FOCUS_RING)}>
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4 text-sm">
          <div className="flex items-center justify-between gap-3">
            <label htmlFor="scale-n" className="text-zinc-300">Add copies of the base strategy</label>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Fewer" onClick={() => commit(delta - 1)} className={cn('h-8 w-8 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800', FOCUS_RING)}><Minus className="mx-auto h-3.5 w-3.5" /></button>
              {/* Free-typed: commits on blur/Enter only, so a half-typed 1 of 12 never reaches the preview. */}
              <input
                id="scale-n" inputMode="numeric" value={draft}
                onChange={e => setDraft(e.target.value.replace(/[^0-9]/g, ''))}
                onBlur={() => commit(Number(draft))}
                onKeyDown={e => { if (e.key === 'Enter') commit(Number(draft)); }}
                className={cn('h-8 w-14 rounded-lg border border-zinc-700 bg-zinc-900 text-center font-mono text-sm font-bold text-white', FOCUS_RING)}
              />
              <button type="button" aria-label="More" onClick={() => commit(delta + 1)} className={cn('h-8 w-8 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800', FOCUS_RING)}><Plus className="mx-auto h-3.5 w-3.5" /></button>
            </div>
          </div>

          <div className="overflow-hidden rounded-lg border border-zinc-800">
            <table className="w-full text-xs">
              <thead>
                <tr className="bg-zinc-800 font-bold text-white">
                  <th className="px-3 py-2 text-left">Leg</th>
                  <th className="px-3 py-2 text-right">Lots now</th>
                  <th className="px-3 py-2 text-right">Adding</th>
                  <th className="px-3 py-2 text-right">After</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 font-mono tabular-nums">
                {plan.legs.map(({ leg, addLots, newLots }) => (
                  <tr key={leg.id}>
                    <td className="px-3 py-1.5 text-zinc-200">
                      <span className={leg.side === 'B' ? 'text-emerald-400' : 'text-red-400'}>{leg.side === 'B' ? 'Buy' : 'Sell'}</span> {leg.strike} {leg.option}
                    </td>
                    <td className="px-3 py-1.5 text-right text-zinc-300">{leg.lots}</td>
                    <td className="px-3 py-1.5 text-right text-amber-300">+{addLots}</td>
                    <td className="px-3 py-1.5 text-right font-bold text-white">{newLots}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-zinc-500">Estimated extra margin{marginSource === 'estimate' ? ' (estimate only)' : ''}</dt>
            <dd className="text-right font-mono font-bold text-zinc-100">{extra != null ? `~${money(extra)}` : '—'}</dd>
            <dt className="text-zinc-500">Available funds</dt>
            <dd className="text-right font-mono font-bold text-zinc-100">{availableFunds != null ? money(availableFunds) : '—'}</dd>
          </dl>

          <p className="text-xs leading-relaxed text-zinc-500">
            Hedges (bought legs) go first. Sold legs go only if every hedge fills. Orders are market orders, so check
            liquidity on far strikes.{plan.inStep ? ` The strategy multiplier becomes ${plan.newMultiplier}×.` : ' This strategy has uneven legs, so its multiplier badge will not change.'}
          </p>

          {blocked && <p role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{blocked}</p>}
        </div>

        <div className="flex justify-end gap-2 border-t border-zinc-800 bg-zinc-900 px-5 py-3">
          <button type="button" onClick={onClose} className={cn('rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-1.5 text-xs font-bold text-zinc-300 hover:bg-zinc-800', FOCUS_RING)}>Cancel</button>
          <button
            type="button" onClick={submit} disabled={!!blocked || submitting}
            className={cn('inline-flex items-center gap-1.5 rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-bold text-oncolor hover:bg-amber-500 disabled:cursor-not-allowed disabled:opacity-50', FOCUS_RING)}
          >
            {submitting && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
            Place orders (+{delta}×)
          </button>
        </div>
      </div>
    </div>
  );
}
