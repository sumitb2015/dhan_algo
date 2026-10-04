'use client';

import React, { useMemo } from 'react';
import type { BasketLeg } from '@/lib/basketStrategies';
import { lookupChainLegData, type ChainOc } from '@/lib/optionsStrategy';

interface Props {
  legs: BasketLeg[];
  /** Front-expiry chain, plus off-expiry chains keyed by expiry (each leg is joined to ITS OWN expiry's chain). */
  frontExpiry: string;
  frontChain: ChainOc;
  farChains: Record<string, ChainOc>;
  /** Units per lot x basket multiplier. */
  unitsPerLot: number;
  multiplier: number;
}

interface Row {
  id: string;
  label: string;
  expiry: string;
  units: number;
  iv: number | null;
  delta: number | null;
  gamma: number | null;
  theta: number | null;
  vega: number | null;
}

const fmt = (v: number | null, d: number) =>
  v == null ? '—' : (v >= 0 ? '+' : '') + v.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const tone = (v: number | null) => (v == null || v === 0 ? 'text-zinc-400' : v > 0 ? 'text-emerald-400' : 'text-red-400');

/**
 * Chain-supplied Greeks (Dhan's own per-contract values, already per-unit) scaled by signed position units.
 * Same convention as lib/positionGreeks.ts: one signed multiplier applied to all four Greeks, so the rows sum
 * to the net row. Legs the chain has no Greeks for show "—" and are left out of the net instead of counted as 0.
 */
export default function BasketGreeksPanel({ legs, frontExpiry, frontChain, farChains, unitsPerLot, multiplier }: Props) {
  const { rows, net, missing } = useMemo(() => {
    const rows: Row[] = legs.map(l => {
      const oc = !l.expiry || l.expiry === frontExpiry ? frontChain : (farChains[l.expiry] ?? {});
      const c = lookupChainLegData(oc, l.strike, l.option);
      const g = c?.greeks;
      const populated = !!g && [g.delta, g.gamma, g.theta, g.vega].some(v => typeof v === 'number' && v !== 0);
      const units = l.lots * multiplier * unitsPerLot * (l.side === 'S' ? -1 : 1);
      const scale = (v: number | undefined) => (populated && typeof v === 'number' ? v * units : null);
      return {
        id: l.id,
        label: `${l.side === 'B' ? 'BUY' : 'SELL'} ${l.strike} ${l.option}`,
        expiry: l.expiry,
        units,
        iv: typeof c?.implied_volatility === 'number' && c.implied_volatility > 0 ? c.implied_volatility : null,
        delta: scale(g?.delta), gamma: scale(g?.gamma), theta: scale(g?.theta), vega: scale(g?.vega),
      };
    });
    const sum = (k: 'delta' | 'gamma' | 'theta' | 'vega') => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    return {
      rows,
      net: { delta: sum('delta'), gamma: sum('gamma'), theta: sum('theta'), vega: sum('vega') },
      missing: rows.filter(r => r.delta == null).length,
    };
  }, [legs, frontExpiry, frontChain, farChains, unitsPerLot, multiplier]);

  if (!legs.length) return null;
  const allMissing = missing === rows.length;

  return (
    <div className="px-3.5 py-2.5 border-t border-zinc-800">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-bold text-zinc-300 uppercase tracking-wider">Position Greeks</span>
        <span className="text-[10px] text-zinc-500 font-mono">Dhan chain · per position · Θ per day · Vega per 1 vol pt</span>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs font-mono tabular-nums">
          <thead>
            <tr className="bg-zinc-800 text-xs font-bold text-white">
              <th className="px-2 py-1.5 text-left">Leg</th>
              <th className="px-2 py-1.5 text-right">Qty</th>
              <th className="px-2 py-1.5 text-right">IV%</th>
              <th className="px-2 py-1.5 text-right">Delta Δ</th>
              <th className="px-2 py-1.5 text-right">Gamma Γ</th>
              <th className="px-2 py-1.5 text-right">Theta Θ</th>
              <th className="px-2 py-1.5 text-right">Vega ν</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.id} className="border-b border-zinc-800/60">
                <td className="px-2 py-1.5 text-zinc-200">
                  {r.label} <span className="text-zinc-500">{r.expiry}</span>
                </td>
                <td className="px-2 py-1.5 text-right text-zinc-300">{r.units > 0 ? '+' : ''}{r.units}</td>
                <td className="px-2 py-1.5 text-right text-zinc-300">{r.iv == null ? '—' : r.iv.toFixed(2)}</td>
                <td className={`px-2 py-1.5 text-right ${tone(r.delta)}`}>{fmt(r.delta, 2)}</td>
                <td className={`px-2 py-1.5 text-right ${tone(r.gamma)}`}>{fmt(r.gamma, 4)}</td>
                <td className={`px-2 py-1.5 text-right ${tone(r.theta)}`}>{fmt(r.theta, 0)}</td>
                <td className={`px-2 py-1.5 text-right ${tone(r.vega)}`}>{fmt(r.vega, 0)}</td>
              </tr>
            ))}
            <tr className="bg-zinc-900 font-bold">
              <td className="px-2 py-1.5 text-zinc-100">NET</td>
              <td className="px-2 py-1.5" />
              <td className="px-2 py-1.5" />
              <td className={`px-2 py-1.5 text-right ${tone(allMissing ? null : net.delta)}`}>{fmt(allMissing ? null : net.delta, 2)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(allMissing ? null : net.gamma)}`}>{fmt(allMissing ? null : net.gamma, 4)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(allMissing ? null : net.theta)}`}>{fmt(allMissing ? null : net.theta, 0)}</td>
              <td className={`px-2 py-1.5 text-right ${tone(allMissing ? null : net.vega)}`}>{fmt(allMissing ? null : net.vega, 0)}</td>
            </tr>
          </tbody>
        </table>
      </div>
      {missing > 0 && (
        <p className="mt-1 text-[10px] text-amber-400">
          {missing} leg{missing > 1 ? 's' : ''} without chain Greeks (market closed or contract not loaded) — excluded from NET.
        </p>
      )}
    </div>
  );
}
