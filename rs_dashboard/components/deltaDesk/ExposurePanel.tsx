'use client';

import React, { useMemo } from 'react';
import { Info } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  DeskLeg, Basis, BASIS_LABEL, BASIS_NOTE, GreekKey, aggregate, fmtGreek, fmtInr, posture, legWeight,
} from '@/lib/deltaDesk';

const BASES: Basis[] = ['exposure', 'lots', 'broker'];

function shortName(l: DeskLeg): string {
  const d = new Date(l.expiry + 'T00:00:00');
  const dd = d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' }).replace(' ', ' ');
  return `${l.strike} ${l.type === 'CE' ? 'CE' : 'PE'} · ${dd}`;
}

/** Net delta drawn as a waterfall: each leg's lot-delta stacks left or right of zero. */
function DeltaRuler({ legs }: { legs: DeskLeg[] }) {
  const parts = legs.map(l => ({ leg: l, v: legWeight(l, 'lots') * l.delta }));
  let cum = 0;
  const segs = parts.map(p => {
    const from = cum;
    cum += p.v;
    return { ...p, from, to: cum };
  });
  const net = cum;
  const extent = Math.max(1, ...segs.flatMap(s => [Math.abs(s.from), Math.abs(s.to)])) * 1.15;
  const pct = (x: number) => 50 + (x / extent) * 50;

  return (
    <div>
      <div className="relative rounded-md bg-zinc-900 border border-zinc-800 overflow-hidden" role="img"
        aria-label={`Net delta ${net.toFixed(2)} lots`} style={{ height: segs.length * 16 + 10 }}>
        <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-600" />
        {segs.map((s, i) => {
          const a = Math.min(pct(s.from), pct(s.to));
          const b = Math.max(pct(s.from), pct(s.to));
          return (
            <div
              key={s.leg.securityId}
              className={cn('absolute h-3 rounded-sm', s.v >= 0 ? 'bg-emerald-500/60' : 'bg-red-500/60')}
              style={{ left: `${a}%`, width: `${Math.max(b - a, 0.6)}%`, top: 5 + i * 16 }}
              title={`${shortName(s.leg)}: ${s.v >= 0 ? '+' : ''}${s.v.toFixed(2)} lots`}
            />
          );
        })}
        <div className="absolute inset-y-0 w-0.5 bg-amber-400" style={{ left: `${pct(net)}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-xs text-zinc-500 tabular-nums">
        <span>−{extent.toFixed(1)} lots (bearish)</span>
        <span>0</span>
        <span>+{extent.toFixed(1)} lots (bullish)</span>
      </div>
      <ul className="mt-2 grid gap-1 text-xs">
        {segs.map(s => (
          <li key={s.leg.securityId} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-1.5 text-zinc-300 min-w-0">
              <span className={cn('h-2 w-2 shrink-0 rounded-sm', s.v >= 0 ? 'bg-emerald-500/70' : 'bg-red-500/70')} />
              <span className="truncate">
                {s.leg.side === 'SELL' ? 'Short' : 'Long'} {Math.abs(s.leg.netQty / (s.leg.lotSize || 1))}× {shortName(s.leg)}
              </span>
            </span>
            <span className={cn('tabular-nums font-semibold', s.v >= 0 ? 'text-emerald-400' : 'text-red-400')}>
              {s.v >= 0 ? '+' : '−'}{Math.abs(s.v).toFixed(2)}
            </span>
          </li>
        ))}
        <li className="flex items-center justify-between gap-3 border-t border-zinc-800 pt-1.5 mt-0.5">
          <span className="flex items-center gap-1.5 text-zinc-100 font-semibold">
            <span className="h-2 w-0.5 bg-amber-400" />Net
          </span>
          <span className="tabular-nums font-bold text-zinc-100">{net >= 0 ? '+' : '−'}{Math.abs(net).toFixed(2)} lots</span>
        </li>
      </ul>
    </div>
  );
}

export default function ExposurePanel({
  legs, basis, onBasis,
}: { legs: DeskLeg[]; basis: Basis; onBasis: (b: Basis) => void }) {
  const real = useMemo(() => aggregate(legs, 'exposure'), [legs]);
  const shown = useMemo(() => aggregate(legs, basis), [legs, basis]);
  const lotsTotal = useMemo(() => legs.reduce((s, l) => s + Math.abs(l.netQty / (l.lotSize || 1)), 0), [legs]);
  const chips = useMemo(() => posture(real, lotsTotal), [real, lotsTotal]);

  // Plain-language lines always use the real rupee exposure, whatever basis the numbers are shown in.
  const lotSize = legs[0]?.lotSize || 65;
  const move100 = real.delta * 100 + 0.5 * real.gamma * 100 * 100;
  const rows: { key: GreekKey; title: string; line: string; dp?: boolean }[] = [
    { key: 'delta', title: 'Delta', line: `Nifty +100 points moves the book ${fmtInr(move100, true)}.` },
    { key: 'gamma', title: 'Gamma', line: `Delta shifts ${(real.gamma * 100 / lotSize).toFixed(2)} lots for every +100 points.` },
    { key: 'theta', title: 'Theta', line: `${real.theta >= 0 ? 'Earns' : 'Pays'} ${fmtInr(Math.abs(real.theta))} each day with no move.` },
    { key: 'vega', title: 'Vega', line: `IV +1 point ${real.vega >= 0 ? 'adds' : 'costs'} ${fmtInr(Math.abs(real.vega))}.` },
  ];

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap gap-1.5">
        {chips.map(c => (
          <span key={c.label} className={cn(
            'px-2 py-0.5 rounded-md border text-xs font-semibold',
            c.tone === 'good' ? 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
              : c.tone === 'bad' ? 'bg-red-500/10 border-red-500/25 text-red-400'
                : 'bg-zinc-800 border-zinc-700 text-zinc-300'
          )}>{c.label}</span>
        ))}
      </div>

      <div>
        <p className="text-xs font-semibold text-zinc-400 mb-2">Where your net delta comes from</p>
        <DeltaRuler legs={legs} />
      </div>

      <div>
        <div className="flex items-center justify-between gap-2 mb-2">
          <p className="text-xs font-semibold text-zinc-400 flex items-center gap-1">
            Portfolio Greeks
            <Tooltip>
              <TooltipTrigger render={<span className="cursor-help" />}>
                <Info className="h-3 w-3 text-zinc-500" aria-label="About the display basis" />
              </TooltipTrigger>
              <TooltipContent>{BASIS_NOTE[basis]}</TooltipContent>
            </Tooltip>
          </p>
          <div role="group" aria-label="Display basis" className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {BASES.map(b => (
              <button
                key={b}
                type="button"
                onClick={() => onBasis(b)}
                aria-pressed={basis === b}
                className={cn(
                  'px-2 py-0.5 text-xs font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400',
                  basis === b ? 'bg-emerald-500/15 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                {BASIS_LABEL[b]}
              </button>
            ))}
          </div>
        </div>
        <dl className="divide-y divide-zinc-800 border-y border-zinc-800">
          {rows.map(r => (
            <div key={r.key} className="grid grid-cols-[1fr_auto] items-baseline gap-x-4 py-2.5">
              <dt className="min-w-0">
                <span className="text-sm font-bold text-zinc-100">{r.title}</span>
                <span className="block text-xs text-zinc-400 mt-0.5">{r.line}</span>
              </dt>
              <dd className={cn('text-xl font-bold tabular-nums tracking-tight text-right',
                shown[r.key] > 0 ? 'text-zinc-100' : shown[r.key] < 0 ? 'text-zinc-100' : 'text-zinc-400')}>
                {shown[r.key] > 0 ? '+' : shown[r.key] < 0 ? '−' : ''}{fmtGreek(Math.abs(shown[r.key]))}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  );
}
