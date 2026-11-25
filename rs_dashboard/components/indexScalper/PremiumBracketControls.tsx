'use client';

// Target / stop loss for an OPTION position from its strike chip on the underlying chart (Quick Trade). The index axis is
// not the option's price, so the level is typed (not dragged): a PREMIUM ("245.50") or a percentage of the entry premium
// ending in "%" ("20%"), turned into a premium on the tick, validated against the live premium, and sent through the
// terminal's onSetBracket: REAL a LIMIT target / SL-M stop on that contract (isx), SIM the paper watcher.
// Rules in lib/indexScalperPremiumBrackets.ts.

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ScalperLeg } from '@/lib/indexScalperPositions';
import {
  defaultPremiumLevel, parseBracketInput, premiumBracketError, premiumPnlAt, snapPremium, type PremiumBrackets,
} from '@/lib/indexScalperPremiumBrackets';
import { cn } from '@/lib/utils';

const inr = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const fmtPct = (n: number) => `${n >= 0 ? '+' : ''}${n.toFixed(2)}%`;

interface Props {
  leg: ScalperLeg;
  units: number;
  tick: number;
  brackets: PremiumBrackets;
  onSet: (kind: 'TP' | 'SL', price: number) => void;
  onCancel: (kind: 'TP' | 'SL', orderId?: string) => void;
}

export default function PremiumBracketControls({ leg, units, tick, brackets, onSet, onCancel }: Props) {
  const isLong = leg.netQty > 0;
  const [edit, setEdit] = useState<'TP' | 'SL' | null>(null);
  const [draft, setDraft] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const open = (kind: 'TP' | 'SL') => {
    if (edit === kind) { setEdit(null); return; }
    const existing = kind === 'TP' ? brackets.tp?.price : brackets.sl?.price;
    const start = defaultPremiumLevel(kind, isLong, leg.ltp, leg.avg, tick, existing);
    setDraft(start === null ? '' : start.toFixed(2));
    setEdit(kind);
  };

  useEffect(() => {
    if (!edit) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setEdit(null); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [edit]);

  // The draft is only a form value: nothing reads it until Set / Enter (dhan-commit-on-blur).
  const parsed = edit ? parseBracketInput(draft, edit, isLong, leg.avg, tick) : null;
  const price = parsed?.price ?? Number.NaN;
  const err = edit && parsed ? (parsed.error ?? premiumBracketError(edit, price, isLong, leg.ltp, tick)) : null;
  const submit = () => {
    if (!edit || err || !(price > 0)) return;
    onSet(edit, snapPremium(price, tick));
    setEdit(null);
  };

  const badge = (kind: 'TP' | 'SL') => {
    const b = kind === 'TP' ? brackets.tp : brackets.sl;
    if (!b) return null;
    const pnl = premiumPnlAt(b.price, leg.avg, units, isLong);
    return (
      <span data-testid={kind === 'TP' ? 'premium-tp' : 'premium-sl'}
        title={`${kind === 'TP' ? 'Target' : 'Stop loss'} at premium ${b.price.toFixed(2)}${leg.avg > 0 ? ` (${fmtPct((b.price - leg.avg) / leg.avg * 100)} from entry ${leg.avg.toFixed(2)})` : ''}${b.sim ? ' (SIM)' : ` (order ${b.orderId})`}: books about ${inr(pnl)}`}
        className={cn('h-[18px] pl-1 pr-0.5 flex items-center gap-1 rounded border text-[10px] font-semibold',
          kind === 'TP' ? 'border-emerald-500/60 text-emerald-400' : 'border-rose-500/60 text-rose-400')}>
        {kind} {b.price.toFixed(2)} <span className="text-zinc-400">{inr(pnl)}</span>
        <button type="button" aria-label={`Cancel ${kind} ${leg.type} ${leg.strike}`} onClick={e => { e.stopPropagation(); onCancel(kind, b.orderId); }}
          className="w-3.5 h-3.5 flex items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-zinc-700"><X className="w-2.5 h-2.5" /></button>
      </span>
    );
  };

  const btn = (kind: 'TP' | 'SL') => (
    <button type="button" aria-label={`${kind === 'TP' ? 'Target' : 'Stop loss'} for ${leg.type} ${leg.strike}`} aria-expanded={edit === kind}
      title={`${kind === 'TP' ? 'Target' : 'Stop loss'}: the option premium to exit at (245.50), or a % of the entry premium (20%)`}
      onClick={e => { e.stopPropagation(); open(kind); }}
      className={cn('h-[18px] px-1.5 rounded bg-zinc-800 border text-[10px] font-bold transition-colors',
        kind === 'TP' ? 'text-emerald-400 border-emerald-500/50 hover:bg-emerald-600/30' : 'text-rose-400 border-rose-500/50 hover:bg-rose-600/30',
        edit === kind && 'ring-1 ring-sky-400')}>{kind}</button>
  );

  return (
    <div ref={boxRef} className="relative flex items-center gap-1">
      {/* Which leg this is: a straddle has two chips on one strike line (B = long, S = short). */}
      <span data-testid="leg-label" className="text-[10px] font-semibold text-zinc-300 whitespace-nowrap" title={`${isLong ? 'Long' : 'Short'} ${leg.type} ${leg.strike}`}>
        <span className={isLong ? 'text-emerald-400' : 'text-rose-400'}>{isLong ? 'B' : 'S'}</span> {leg.type} {leg.strike}
      </span>
      {brackets.tp ? badge('TP') : btn('TP')}
      {brackets.sl ? badge('SL') : btn('SL')}
      {edit && (
        <div role="dialog" aria-label={`${edit === 'TP' ? 'Target' : 'Stop loss'} premium for ${leg.type} ${leg.strike}`}
          className="absolute right-0 top-[22px] z-[70] w-[240px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-2 flex flex-col gap-1.5 font-sans">
          <div className="flex items-center justify-between text-[11px]">
            <span className={cn('font-bold', edit === 'TP' ? 'text-emerald-400' : 'text-rose-400')}>{edit === 'TP' ? 'Target' : 'Stop loss'}</span>
            <span className="text-zinc-400 font-mono">Entry {leg.avg > 0 ? leg.avg.toFixed(2) : '—'} · LTP {leg.ltp !== null ? leg.ltp.toFixed(2) : '—'}</span>
          </div>
          <div className="flex items-center gap-1">
            <input autoFocus inputMode="decimal" aria-label={`${edit} premium`} value={draft} placeholder="245.50 or 20%"
              title="A premium (245.50), or a percentage of the entry premium ending in % (20%)"
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setEdit(null); e.stopPropagation(); }}
              className="h-7 w-full px-1.5 rounded border border-zinc-700 bg-zinc-950 text-xs font-mono text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60" />
            <button type="button" disabled={!!err} onClick={submit}
              className={cn('h-7 px-2 rounded text-xs font-bold text-oncolor disabled:opacity-40', edit === 'TP' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-rose-600 hover:bg-rose-500')}>Set</button>
          </div>
          <div className={cn('text-[10px] leading-snug', err ? 'text-amber-400' : 'text-zinc-400')}>
            {err ?? `${parsed?.pct !== null && parsed?.pct !== undefined ? `${parsed.pct}% of entry → ` : ''}Books about ${inr(premiumPnlAt(price, leg.avg, units, isLong))} at ${price.toFixed(2)}${leg.sim ? ' (SIM)' : ''}`}
          </div>
        </div>
      )}
    </div>
  );
}
