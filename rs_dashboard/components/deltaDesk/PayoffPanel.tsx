'use client';

import React, { useMemo, useState } from 'react';
import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip as RTooltip,
  ResponsiveContainer, ReferenceLine, ReferenceArea,
} from 'recharts';
import { cn } from '@/lib/utils';
import { DeskLeg, payoff, ladder, fmtInr } from '@/lib/deltaDesk';

const DAY_STEPS = [
  { label: 'Today', days: 0 },
  { label: '+5 days', days: 5 },
  { label: '+10 days', days: 10 },
] as const;

const axisInr = (v: number) => {
  const a = Math.abs(v);
  const s = a >= 1e5 ? `${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L` : a >= 1e3 ? `${Math.round(a / 1e3)}k` : `${a}`;
  return v < 0 ? `−${s}` : s;
};

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="min-w-0">
      <p className="text-xs text-zinc-500 font-medium">{label}</p>
      <p className={cn('text-lg font-bold tabular-nums tracking-tight',
        tone === 'good' ? 'text-emerald-400' : tone === 'bad' ? 'text-red-400' : 'text-zinc-100')}>
        {value}
      </p>
    </div>
  );
}

export default function PayoffPanel({ legs, spot, spotEstimated }: { legs: DeskLeg[]; spot: number; spotEstimated?: boolean }) {
  const [days, setDays] = useState<number>(0);
  const [showSigma, setShowSigma] = useState(true);

  const res = useMemo(() => (spot > 0 ? payoff(legs, spot, days) : null), [legs, spot, days]);

  if (!res || res.points.length === 0) {
    return (
      <div className="flex h-[420px] items-center justify-center text-sm text-zinc-500">
        Payoff appears once a leg with a live price is open.
      </div>
    );
  }

  const nowPnl = ladder(legs, spot, days).find(r => r.movePct === 0)?.pnlToday ?? 0;
  const frontDays = Math.round(res.frontExpiryYears * 365);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-x-8 gap-y-3">
        <div className="flex flex-wrap gap-x-8 gap-y-2">
          <Stat label="P&L if nothing moves, at the chosen date" value={fmtInr(nowPnl, true)} tone={nowPnl >= 0 ? 'good' : 'bad'} />
          <Stat
            label={res.unlimitedGainUp ? 'Best at expiry: unlimited upside' : 'Best at expiry, within ±8%'}
            value={res.unlimitedGainUp ? 'Unlimited' : fmtInr(res.best, true)}
            tone={res.best > 0 ? 'good' : undefined}
          />
          <Stat
            label={res.unlimitedLossUp || res.unlimitedLossDown ? `Worst at expiry: unlimited ${res.unlimitedLossUp ? 'upside' : 'downside'} risk (${fmtInr(res.worst, true)} within ±8%)` : 'Worst at expiry, within ±8%'}
            value={res.unlimitedLossUp || res.unlimitedLossDown ? 'Unlimited' : fmtInr(res.worst, true)}
            tone={res.worst < 0 ? 'bad' : undefined}
          />
          <Stat
            label={`Break-even at expiry (${frontDays}d)`}
            value={res.breakevens.length ? res.breakevens.map(b => Math.round(b).toLocaleString('en-IN')).join('  ·  ') : 'None in range'}
          />
        </div>
        <div className="flex items-center gap-2">
          <div role="group" aria-label="Date for the Today curve" className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-lg">
            {DAY_STEPS.map(d => (
              <button
                key={d.label}
                type="button"
                onClick={() => setDays(d.days)}
                aria-pressed={days === d.days}
                className={cn(
                  'px-2.5 py-1 text-xs font-semibold rounded-md transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
                  days === d.days ? 'bg-sky-500/15 text-sky-400' : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                {d.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={() => setShowSigma(v => !v)}
            aria-pressed={showSigma}
            className={cn(
              'px-2.5 py-1 text-xs font-semibold rounded-lg border transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400',
              showSigma ? 'bg-zinc-800 border-zinc-700 text-zinc-200' : 'bg-zinc-900 border-zinc-800 text-zinc-500 hover:text-zinc-300'
            )}
          >
            1σ band
          </button>
        </div>
      </div>

      <div className="h-[360px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={res.points} margin={{ top: 12, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid vertical={false} />
            <XAxis
              dataKey="spot"
              type="number"
              domain={['dataMin', 'dataMax']}
              tickFormatter={(v: number) => Math.round(v).toLocaleString('en-IN')}
              tickCount={9}
              minTickGap={24}
              tickMargin={8}
            />
            <YAxis tickFormatter={axisInr} width={52} />
            {showSigma && res.oneSigma && (
              <ReferenceArea x1={res.oneSigma[0]} x2={res.oneSigma[1]} fill="var(--color-sky-400)" fillOpacity={0.07} stroke="none" />
            )}
            <ReferenceLine y={0} stroke="var(--color-zinc-500)" />
            {res.breakevens.map(b => (
              <ReferenceLine key={b} x={b} stroke="var(--color-zinc-500)" strokeDasharray="3 4" />
            ))}
            <Area type="linear" dataKey="expPos" stroke="none" fill="var(--color-emerald-400)" fillOpacity={0.14} isAnimationActive={false} legendType="none" />
            <Area type="linear" dataKey="expNeg" stroke="none" fill="var(--color-red-400)" fillOpacity={0.14} isAnimationActive={false} legendType="none" />
            <Line type="linear" dataKey="expiry" name="At expiry" stroke="var(--color-zinc-300)" strokeWidth={2} dot={false} isAnimationActive={false} />
            <Line type="monotone" dataKey="today" name={days === 0 ? 'Today' : `In ${days} days`} stroke="var(--color-sky-400)" strokeWidth={2.5} dot={false} isAnimationActive={false} />
            <ReferenceLine
              x={spot}
              stroke="var(--color-amber-400)"
              strokeWidth={1.5}
              label={{ value: `Nifty ${spot.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`, position: 'insideTopRight', fill: 'var(--color-amber-400)', fontSize: 11 }}
            />
            <RTooltip
              cursor={{ stroke: 'var(--chart-cursor-line)' }}
              formatter={(v, name) => (name === 'expPos' || name === 'expNeg' ? [null, null] : [fmtInr(Number(v), true), String(name)]) as [string, string]}
              labelFormatter={(l) => `Nifty ${Math.round(Number(l)).toLocaleString('en-IN')}`}
              itemSorter={() => 0}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-xs text-zinc-400">
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-sky-400" />{days === 0 ? 'Today, repriced at each leg\'s own IV' : `In ${days} days, IV held flat`}</span>
        <span className="flex items-center gap-1.5"><span className="h-0.5 w-4 bg-zinc-300" />At the nearest expiry ({frontDays}d); later legs keep time value</span>
        <span className="flex items-center gap-1.5"><span className="h-3 w-3 rounded-sm bg-sky-400/20" />Expected 1σ range to that expiry{res.oneSigmaIv ? ` (ATM IV ${res.oneSigmaIv.toFixed(1)}%)` : ''}</span>
        {spotEstimated && <span className="text-amber-400">Index level is estimated from the futures price (live quote was rate-limited)</span>}
        {res.skipped > 0 && <span className="text-amber-400">{res.skipped} leg(s) without a live price are left out of the curve</span>}
      </div>
    </div>
  );
}
