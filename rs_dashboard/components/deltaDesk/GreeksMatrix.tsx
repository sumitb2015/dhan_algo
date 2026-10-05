'use client';

import React, { useMemo } from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import {
  DeskLeg, Basis, GREEKS, GreekKey, aggregate, groupBy, legGreek, legWeight, fmtGreek, fmtInr,
} from '@/lib/deltaDesk';

const TH = 'px-3 py-2 text-xs font-bold text-white bg-zinc-800 whitespace-nowrap';

function Cell({ v }: { v: number | null }) {
  if (v === null) return <td className="px-3 py-2 text-right text-zinc-600">—</td>;
  return (
    <td className={cn('px-3 py-2 text-right tabular-nums', v > 0 ? 'text-zinc-100' : v < 0 ? 'text-zinc-300' : 'text-zinc-500')}>
      {v < 0 ? '−' : ''}{fmtGreek(Math.abs(v))}
    </td>
  );
}

function GreekHead({ g }: { g: (typeof GREEKS)[number] }) {
  return (
    <th scope="col" className={cn(TH, 'text-right', g.order === 'second' && 'border-l border-zinc-700 first-of-type:border-l')}>
      <Tooltip>
        <TooltipTrigger render={<span className="cursor-help underline decoration-dotted decoration-zinc-500 underline-offset-4" />}>
          {g.symbol}
        </TooltipTrigger>
        <TooltipContent>{g.name}: {g.hint}</TooltipContent>
      </Tooltip>
    </th>
  );
}

/** Every Greek, every leg, then the book. Values follow the chosen basis so the rows sum to the total row. */
export function GreeksMatrix({ legs, basis }: { legs: DeskLeg[]; basis: Basis }) {
  const total = useMemo(() => aggregate(legs, basis), [legs, basis]);
  const anyChain = legs.some(l => l.greeksSource === 'chain');

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th scope="col" className={cn(TH, 'text-left sticky left-0 z-10')}>Leg</th>
            <th scope="col" className={cn(TH, 'text-right')}>Lots</th>
            <th scope="col" className={cn(TH, 'text-right')}>LTP</th>
            <th scope="col" className={cn(TH, 'text-right')}>IV %</th>
            {GREEKS.map(g => <GreekHead key={g.key} g={g} />)}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {legs.map(l => {
            const w = legWeight(l, basis);
            const lots = l.lotSize > 0 ? l.netQty / l.lotSize : 0;
            return (
              <tr key={l.securityId} className="hover:bg-zinc-800/40">
                <th scope="row" className="px-3 py-2 text-left font-semibold text-zinc-100 whitespace-nowrap sticky left-0 bg-zinc-950">
                  {l.underlying} {l.strike} {l.type}
                  <span className="ml-2 text-xs font-medium text-zinc-500">
                    {new Date(l.expiry + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })}
                  </span>
                  {l.greeksSource === 'chain' && <span className="ml-2 text-xs text-amber-400">chain</span>}
                </th>
                <td className={cn('px-3 py-2 text-right tabular-nums font-semibold', lots < 0 ? 'text-red-400' : 'text-emerald-400')}>
                  {lots > 0 ? '+' : lots < 0 ? '−' : ''}{Math.abs(lots)}
                </td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{l.ltp ? l.ltp.toFixed(2) : '—'}</td>
                <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{l.iv ? l.iv.toFixed(1) : '—'}</td>
                {GREEKS.map(g => {
                  const v = legGreek(l, g.key);
                  return <Cell key={g.key} v={v === null ? null : w * v} />;
                })}
              </tr>
            );
          })}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-zinc-700 bg-zinc-900">
            <th scope="row" className="px-3 py-2.5 text-left font-bold text-zinc-100 sticky left-0 bg-zinc-900">Portfolio</th>
            <td className="px-3 py-2.5" colSpan={3} />
            {GREEKS.map((g: (typeof GREEKS)[number]) => {
              const v = total[g.key as GreekKey];
              return (
                <td key={g.key} className={cn('px-3 py-2.5 text-right tabular-nums font-bold',
                  v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-zinc-400')}>
                  {v < 0 ? '−' : v > 0 ? '+' : ''}{fmtGreek(Math.abs(v))}
                </td>
              );
            })}
          </tr>
        </tfoot>
      </table>
      <p className="px-3 py-2 text-xs text-zinc-500">
        Delta, gamma, theta, vega, rho are first-order. Vanna, charm and vomma (right of the divider) describe how those exposures themselves change with volatility and time.
        {anyChain && ' Legs marked "chain" had no live price, so first-order Greeks come from Dhan\'s option chain and the second-order ones are blank.'}
      </p>
    </div>
  );
}

function Bar({ v, max, unit }: { v: number; max: number; unit?: string }) {
  const w = max > 0 ? Math.min(Math.abs(v) / max, 1) * 50 : 0;
  return (
    <div className="flex items-center gap-2">
      <div className="relative h-2 w-24 shrink-0 rounded-sm bg-zinc-800">
        <div className="absolute inset-y-0 left-1/2 w-px bg-zinc-600" />
        <div
          className={cn('absolute inset-y-0 rounded-sm', v >= 0 ? 'bg-emerald-500/70' : 'bg-red-500/70')}
          style={v >= 0 ? { left: '50%', width: `${w}%` } : { right: '50%', width: `${w}%` }}
        />
      </div>
      <span className="tabular-nums text-sm text-zinc-200 w-20 text-right">{v < 0 ? '−' : v > 0 ? '+' : ''}{fmtGreek(Math.abs(v))}{unit}</span>
    </div>
  );
}

/** The same book cut by expiry, so a calendar's near/far risk doesn't net away unseen. */
export function ExpiryBreakdown({ legs, basis }: { legs: DeskLeg[]; basis: Basis }) {
  const rows = useMemo(() => groupBy(legs, l => l.expiry, basis), [legs, basis]);
  const maxOf = (k: GreekKey) => Math.max(0, ...rows.map(r => Math.abs(r.totals[k])));
  const cols: GreekKey[] = ['delta', 'gamma', 'theta', 'vega'];

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th scope="col" className={cn(TH, 'text-left')}>Expiry</th>
            <th scope="col" className={cn(TH, 'text-right')}>Legs</th>
            {cols.map(k => (
              <th key={k} scope="col" className={cn(TH, 'text-left')}>{GREEKS.find(g => g.key === k)?.name}</th>
            ))}
            <th scope="col" className={cn(TH, 'text-right')}>P&amp;L</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map(r => (
            <tr key={r.key}>
              <th scope="row" className="px-3 py-2 text-left font-semibold text-zinc-100 whitespace-nowrap">
                {new Date(r.key + 'T00:00:00').toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: '2-digit' })}
              </th>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{r.legs}</td>
              {cols.map(k => (
                <td key={k} className="px-3 py-2"><Bar v={r.totals[k]} max={maxOf(k)} /></td>
              ))}
              <td className={cn('px-3 py-2 text-right tabular-nums font-semibold', r.pnl >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                {fmtInr(r.pnl, true)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
