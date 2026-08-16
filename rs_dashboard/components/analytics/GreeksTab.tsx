'use client';

import React, { useMemo } from 'react';
import { AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { PositionLeg } from '@/lib/positionLegs';
import { StatChip } from './PayoffMetricStrip';

const TH = 'bg-zinc-800 px-2.5 py-2 text-xs font-bold text-white whitespace-nowrap';
const TD = 'px-2.5 py-2 font-mono text-xs tabular-nums text-zinc-200 whitespace-nowrap';

/** Signed multiplier taking a per-contract greek to a position greek. */
const posSign = (leg: PositionLeg) => (leg.side === 'SELL' ? -1 : 1) * leg.qtyLots;

export interface NetGreeks {
  delta: number; gamma: number; theta: number; vega: number;
  /** Legs whose greeks the chain did not supply — excluded from the sums above. */
  missing: PositionLeg[];
}

export function computeNetGreeks(legs: PositionLeg[]): NetGreeks {
  let delta = 0, gamma = 0, theta = 0, vega = 0;
  const missing: PositionLeg[] = [];

  for (const leg of legs) {
    // Dhan's chain returns all-zero greeks often enough that a leg with no delta
    // AND no gamma is almost certainly unpopulated rather than genuinely neutral.
    // Summing those zeros silently understates net exposure, so they are excluded
    // and reported instead.
    if (leg.delta === null && leg.gamma === null) { missing.push(leg); continue; }
    const k = posSign(leg);
    delta += (leg.delta ?? 0) * k;
    gamma += (leg.gamma ?? 0) * k;
    theta += (leg.theta ?? 0) * k;
    vega += (leg.vega ?? 0) * k;
  }
  return { delta, gamma, theta, vega, missing };
}

function fmt(n: number | null, dec: number): string {
  return n === null ? '—' : n.toFixed(dec);
}

export default function GreeksTab({ legs, lotSize, spot }: { legs: PositionLeg[]; lotSize: number; spot: number }) {
  const net = useMemo(() => computeNetGreeks(legs), [legs]);

  if (!legs.length) {
    return <p className="py-10 text-center text-xs text-zinc-500">No open legs to show greeks for.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-y-3 rounded-xl border border-zinc-800 bg-zinc-900 px-2 py-3">
        <StatChip
          label="Net Delta"
          value={net.delta.toFixed(2)}
          sub={`≈ ${(net.delta * spot).toLocaleString('en-IN', { maximumFractionDigits: 0 })} rupee-equivalent`}
          color={net.delta > 0 ? 'text-emerald-400' : net.delta < 0 ? 'text-red-400' : 'text-zinc-100'}
          title="Sum of per-contract delta × signed quantity. Positive = long the underlying."
        />
        <StatChip label="Net Gamma" value={net.gamma.toFixed(4)}
          color={net.gamma < 0 ? 'text-rose-400' : 'text-zinc-100'}
          title="Negative gamma means delta moves against you as spot moves — the short-option regime." />
        <StatChip label="Net Theta" value={`₹${net.theta.toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
          sub="per day, per contract set"
          color={net.theta > 0 ? 'text-emerald-400' : 'text-red-400'} />
        <StatChip label="Net Vega" value={net.vega.toFixed(2)}
          sub="per 1 vol point"
          color={net.vega < 0 ? 'text-rose-400' : 'text-zinc-100'} />
        <StatChip label="Lot Size" value={String(lotSize)} />
      </div>

      {net.missing.length > 0 && (
        <div className="flex items-start gap-2 rounded border border-amber-800 bg-amber-950 px-3 py-2 text-[11px] text-amber-300">
          <AlertTriangle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            {net.missing.length} leg{net.missing.length > 1 ? 's' : ''} had no greeks in the option chain
            ({net.missing.map((l) => `${l.strike} ${l.type}`).join(', ')}) and {net.missing.length > 1 ? 'are' : 'is'} excluded
            from the net figures above — real exposure is larger.
          </span>
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full border-collapse">
          <thead>
            <tr>
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
          <tbody>
            {legs.map((l) => {
              const k = posSign(l);
              return (
                <tr key={`${l.display.tradingSymbol}|${l.display.productType}`} className="border-b border-zinc-800 hover:bg-zinc-900">
                  <td className={cn(TD, 'text-left')}>
                    <span className={cn('mr-1.5 text-[10px] font-bold', l.side === 'SELL' ? 'text-rose-300' : 'text-sky-300')}>
                      {l.side}
                    </span>
                    {l.strike.toLocaleString('en-IN')} {l.type}
                  </td>
                  <td className={TD}>{l.display.netQty.toLocaleString('en-IN')}</td>
                  <td className={TD}>{l.iv === null ? '—' : `${(l.iv * 100).toFixed(1)}%`}</td>
                  <td className={TD}>{fmt(l.delta, 4)}</td>
                  <td className={cn(TD, 'font-bold', l.delta === null ? 'text-zinc-500' : (l.delta * k) > 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {l.delta === null ? '—' : (l.delta * k).toFixed(2)}
                  </td>
                  <td className={TD}>{fmt(l.gamma, 5)}</td>
                  <td className={TD}>{fmt(l.theta === null ? null : l.theta * k, 1)}</td>
                  <td className={TD}>{fmt(l.vega === null ? null : l.vega * k, 2)}</td>

                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
