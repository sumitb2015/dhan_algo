'use client';

import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PositionLeg } from '@/lib/positionLegs';
import { positionNetGreeks, type FutureRef } from '@/lib/positionPayoff';
import { StatChip } from './PayoffMetricStrip';

const TH = 'bg-zinc-800 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-white whitespace-nowrap text-center';
const TD = 'px-3 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap text-center';

/** Signed multiplier taking a per-unit greek to a position greek. */
const posSign = (leg: PositionLeg) => (leg.side === 'SELL' ? -1 : 1) * leg.qtyLots;

function fmt(n: number | null, dec: number): string {
  return n === null ? '—' : n.toFixed(dec);
}

export default function GreeksTab({ legs, lotSize, spot, future }: { legs: PositionLeg[]; lotSize: number; spot: number; future?: FutureRef | null }) {
  // Greeks computed through the central pricing library from each leg's live mark (not Dhan's chain Greeks), so they agree with the
  // payoff curves and every other page.
  const net = useMemo(() => positionNetGreeks(legs, spot, { future }), [legs, spot, future]);

  if (!legs.length) {
    return <p className="py-10 text-center text-xs text-zinc-500">No open legs to show greeks for.</p>;
  }

  return (
    <div className="space-y-3.5">
      <div className="flex flex-wrap items-center gap-y-3 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-3 shadow-inner">
        <StatChip
          label="Net Delta"
          value={net.delta.toFixed(2)}
          sub={`≈ ${(net.delta * spot).toLocaleString('en-IN', { maximumFractionDigits: 0 })} rupee-eq`}
          color={net.delta > 0 ? 'text-emerald-400' : net.delta < 0 ? 'text-red-400' : 'text-zinc-100'}
          title="Sum of per-unit delta × signed quantity, from each leg's live price. Positive = long the underlying."
        />
        <StatChip label="Net Gamma" value={net.gamma.toFixed(4)}
          color={net.gamma < 0 ? 'text-rose-400' : 'text-zinc-100'}
          title="Negative gamma means delta moves against you as spot moves — the short-option regime." />
        <StatChip label="Net Theta" value={`₹${net.theta.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
          sub="per day, per set"
          color={net.theta > 0 ? 'text-emerald-400' : 'text-red-400'} />
        <StatChip label="Net Vega" value={net.vega.toFixed(2)}
          sub="per 1% IV"
          color={net.vega < 0 ? 'text-rose-400' : 'text-zinc-100'} />
        <StatChip label="Lot Size" value={String(lotSize)} />
      </div>

      {net.assumed.length > 0 && (
        <div className="flex items-start gap-2 rounded-xl border border-amber-800/80 bg-amber-950/40 px-3.5 py-2.5 text-[11px] text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
          <span>
            {net.assumed.length} leg{net.assumed.length > 1 ? 's' : ''} ({net.assumed.map((l) => `${l.strike} ${l.type}`).join(', ')}) had no live
            price or chain IV and {net.assumed.length > 1 ? 'are' : 'is'} priced on an assumed 15% IV, so {net.assumed.length > 1 ? 'their' : 'its'} Greeks are indicative.
          </span>
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-zinc-800/80 bg-zinc-950/40 shadow-inner">
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-zinc-800">
              <th className={cn(TH, 'text-left')}>Leg</th>
              <th className={TH}>Qty</th>
              <th className={TH}>IV</th>
              <th className={TH}>Delta</th>
              <th className={TH}>Pos Delta</th>
              <th className={TH}>Gamma</th>
              <th className={TH}>Theta</th>
              <th className={TH}>Vega</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-850/60">
            {legs.map((l, i) => {
              const k = posSign(l);
              const g = net.perLeg[i];
              return (
                <tr key={`${l.display.tradingSymbol}|${l.display.productType}`} className="transition-colors even:bg-zinc-900/25 hover:bg-zinc-800/40">
                  <td className={cn(TD, 'text-left')}>
                    <span className={cn(
                      'mr-1.5 inline-flex items-center justify-center rounded px-1 py-0.25 text-[8.5px] font-bold leading-none',
                      l.side === 'SELL'
                        ? 'border border-rose-500/30 bg-rose-500/15 text-rose-300'
                        : 'border border-sky-500/30 bg-sky-500/15 text-sky-300',
                    )}>
                      {l.side}
                    </span>
                    <span className="font-semibold text-zinc-100">{l.strike.toLocaleString('en-IN')} {l.type}</span>
                  </td>
                  <td className={TD}>{l.display.netQty.toLocaleString('en-IN')}</td>
                  <td className={TD}>{g ? `${(g.iv * 100).toFixed(1)}%` : '—'}</td>
                  <td className={TD}>{fmt(g ? g.delta : null, 4)}</td>
                  <td className={cn(TD, 'font-bold', !g ? 'text-zinc-500' : (g.delta * k) > 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {!g ? '—' : (g.delta * k).toFixed(2)}
                  </td>
                  <td className={TD}>{fmt(g ? g.gamma * k : null, 5)}</td>
                  <td className={TD}>{fmt(g ? g.theta * k : null, 1)}</td>
                  <td className={TD}>{fmt(g ? g.vega * k : null, 2)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
