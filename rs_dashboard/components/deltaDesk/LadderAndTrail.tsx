'use client';

import React, { useMemo } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import { cn } from '@/lib/utils';
import { DeskLeg, ladder, fmtInr } from '@/lib/deltaDesk';

export interface TrailPoint {
  t: number;        // epoch ms
  netLotDelta: number;
  pnl: number;
  spot: number;
}

/** What a move in the index does to P&L and to net delta, repriced right now. */
export function ScenarioLadder({ legs, spot }: { legs: DeskLeg[]; spot: number }) {
  const rows = useMemo(() => ladder(legs, spot, 0), [legs, spot]);
  const worst = Math.min(...rows.map(r => r.pnlDelta));
  const best = Math.max(...rows.map(r => r.pnlDelta));

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr>
            <th scope="col" className="px-3 py-2 text-xs font-bold text-white bg-zinc-800 text-left">Nifty move</th>
            <th scope="col" className="px-3 py-2 text-xs font-bold text-white bg-zinc-800 text-right">Level</th>
            <th scope="col" className="px-3 py-2 text-xs font-bold text-white bg-zinc-800 text-right">Book changes by</th>
            <th scope="col" className="px-3 py-2 text-xs font-bold text-white bg-zinc-800 text-right">Net delta (lots)</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-800">
          {rows.map(r => (
            <tr key={r.movePct} className={cn(r.movePct === 0 && 'bg-zinc-800/50')}>
              <th scope="row" className="px-3 py-2 text-left font-semibold text-zinc-100 tabular-nums">
                {r.movePct === 0 ? 'Now' : `${r.movePct > 0 ? '+' : '−'}${Math.abs(r.movePct)}%`}
              </th>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-300">{Math.round(r.spot).toLocaleString('en-IN')}</td>
              <td className="px-3 py-2 text-right">
                <div className="flex items-center justify-end gap-2">
                  {(r.pnlDelta === worst && worst < 0) && <span className="text-xs text-red-400">worst</span>}
                  {(r.pnlDelta === best && best > 0) && <span className="text-xs text-emerald-400">best</span>}
                  <span className={cn('tabular-nums font-semibold', r.pnlDelta > 0 ? 'text-emerald-400' : r.pnlDelta < 0 ? 'text-red-400' : 'text-zinc-400')}>
                    {r.movePct === 0 ? '—' : fmtInr(r.pnlDelta, true)}
                  </span>
                </div>
              </td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-200">
                {r.netLotDelta > 0 ? '+' : r.netLotDelta < 0 ? '−' : ''}{Math.abs(r.netLotDelta).toFixed(2)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="px-3 py-2 text-xs text-zinc-500">
        Repriced now with each leg&apos;s current implied volatility held flat. A sudden move usually changes IV too, so treat this as the delta-and-gamma part of the story.
      </p>
    </div>
  );
}

const hhmm = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' });

/** Net delta and book P&L, one point per refresh since this tab opened. */
export function LiveTrail({ trail }: { trail: TrailPoint[] }) {
  if (trail.length < 2) {
    return (
      <div className="flex h-[260px] items-center justify-center text-center text-sm text-zinc-500 px-6">
        The trail fills in as the page refreshes, one point per refresh. Pick 15s above to watch it build.
      </div>
    );
  }
  return (
    <div className="h-[260px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={trail} margin={{ top: 10, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid vertical={false} />
          <XAxis dataKey="t" type="number" domain={['dataMin', 'dataMax']} tickFormatter={hhmm} minTickGap={40} />
          <YAxis yAxisId="d" width={40} tickFormatter={(v: number) => v.toFixed(1)} />
          <YAxis yAxisId="p" orientation="right" width={52} tickFormatter={(v: number) => `${Math.round(v / 1000)}k`} />
          <ReferenceLine yAxisId="d" y={0} stroke="var(--color-zinc-600)" />
          <Line yAxisId="d" type="monotone" dataKey="netLotDelta" name="Net delta (lots)" stroke="var(--color-amber-400)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line yAxisId="p" type="monotone" dataKey="pnl" name="P&L" stroke="var(--color-sky-400)" strokeWidth={2} dot={false} isAnimationActive={false} />
          <RTooltip
            cursor={{ stroke: 'var(--chart-cursor-line)' }}
            labelFormatter={(t) => hhmm(Number(t))}
            formatter={(v, name) => [name === 'P&L' ? fmtInr(Number(v), true) : Number(v).toFixed(3), String(name)] as [string, string]}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
