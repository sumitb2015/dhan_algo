'use client';

// Trailing stop loss (TSL) for one position, beside its TP / SL: a distance in the instrument's own points (premium
// points for an option, futures points for the future). The stop follows the best price reached and never loosens
// (the XY ladder's continuous trail, lib/indexScalperTrail.ts). Browser-only: the tab that holds it sends a market exit
// when the price crosses it; no order rests at the broker, so closing the tab or the dashboard stops it.

import { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import type { ScalperLeg } from '@/lib/indexScalperPositions';
import { premiumPnlAt } from '@/lib/indexScalperPremiumBrackets';
import { armTrail, parseTrailPoints, retrail, type TrailState } from '@/lib/indexScalperTrail';
import { cn } from '@/lib/utils';

const inr = (n: number) => `${n >= 0 ? '+' : '-'}${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const NOTE = 'Runs in this browser tab: no order at the broker; closing the tab or the dashboard stops it.';

interface Props {
  leg: ScalperLeg;
  /** Contract units of the position (P&L per point). */
  units: number;
  tick: number;
  trail?: TrailState;
  onSet: (pts: number) => void;
  onCancel: () => void;
}

export default function TrailControl({ leg, units, tick, trail, onSet, onCancel }: Props) {
  const isLong = leg.netQty > 0;
  const name = `${leg.type}${leg.type === 'FUT' ? '' : ` ${leg.strike}`}`;
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const boxRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (open) { setOpen(false); return; }
    setDraft(trail ? String(trail.pts) : '');
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (!boxRef.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // The draft is only a form value: nothing reads it until Set / Enter (dhan-commit-on-blur).
  const parsed = open ? parseTrailPoints(draft, tick) : null;
  const preview = parsed?.pts
    ? (trail ? retrail(trail, parsed.pts, tick) : armTrail(leg, leg.ltp, parsed.pts, tick, 'SIM', ''))
    : null;
  const err = !open ? null : draft.trim() === '' ? 'Enter the trail distance in points' : parsed?.error ?? (typeof preview === 'string' ? preview : null);
  const submit = () => {
    if (err || !parsed?.pts) return;
    if (trail && trail.pts === parsed.pts) { setOpen(false); return; }
    onSet(parsed.pts);
    setOpen(false);
  };
  const stop = preview && typeof preview !== 'string' ? preview.sl : null;

  return (
    <div ref={boxRef} className="relative flex items-center">
      {trail ? (
        <span data-testid="trail-badge"
          className="h-[18px] pl-1 pr-0.5 flex items-center gap-1 rounded border border-amber-500/60 text-amber-300 text-[10px] font-semibold">
          <button type="button" aria-label={`Edit TSL ${name}`} aria-expanded={open} onClick={e => { e.stopPropagation(); toggle(); }}
            className={cn('flex items-center gap-1 rounded px-0.5 hover:bg-zinc-800', open && 'ring-1 ring-sky-400')}>
            TSL {trail.sl.toFixed(2)} <span className="text-zinc-400">· {trail.pts}</span>
          </button>
          <button type="button" aria-label={`Cancel TSL ${name}`} onClick={e => { e.stopPropagation(); onCancel(); }}
            className="w-3.5 h-3.5 flex items-center justify-center rounded text-zinc-400 hover:text-white hover:bg-zinc-700"><X className="w-2.5 h-2.5" /></button>
        </span>
      ) : (
        <button type="button" aria-label={`Trailing stop for ${name}`} aria-expanded={open}
          onClick={e => { e.stopPropagation(); toggle(); }}
          className={cn('h-[18px] px-1.5 rounded bg-zinc-800 border border-amber-500/50 text-amber-300 hover:bg-amber-600/30 text-[10px] font-bold transition-colors',
            open && 'ring-1 ring-sky-400')}>TSL</button>
      )}
      {open && (
        <div role="dialog" aria-label={`Trailing stop for ${name}`} onMouseDown={e => e.stopPropagation()}
          className="absolute right-0 top-[22px] z-[70] w-[250px] rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl p-2 flex flex-col gap-1.5 font-sans">
          <div className="flex items-center justify-between text-[11px]">
            <span className="font-bold text-amber-300">Trailing stop</span>
            <span className="text-zinc-400 font-mono">Entry {leg.avg > 0 ? leg.avg.toFixed(2) : '—'} · LTP {leg.ltp !== null ? leg.ltp.toFixed(2) : '—'}</span>
          </div>
          <div className="flex items-center gap-1">
            <input autoFocus inputMode="decimal" aria-label="Trail points" value={draft} placeholder="Points, e.g. 10"
              onChange={e => setDraft(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') submit(); if (e.key === 'Escape') setOpen(false); e.stopPropagation(); }}
              className="h-7 w-full px-1.5 rounded border border-zinc-700 bg-zinc-950 text-xs font-mono text-zinc-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-500/60" />
            <button type="button" disabled={!!err} onClick={submit}
              className="h-7 px-2 rounded text-xs font-bold text-oncolor bg-amber-600 hover:bg-amber-500 disabled:opacity-40">Set</button>
          </div>
          <div className={cn('text-[10px] leading-snug', err ? 'text-amber-400' : 'text-zinc-400')}>
            {err ?? (stop !== null ? `Stop starts at ${stop.toFixed(2)} and follows the ${isLong ? 'high' : 'low'}: books about ${inr(premiumPnlAt(stop, leg.avg, units, isLong))} there${leg.sim ? ' (SIM)' : ''}` : '')}
          </div>
          <div className="text-[10px] leading-snug text-zinc-500">{NOTE}</div>
        </div>
      )}
    </div>
  );
}
