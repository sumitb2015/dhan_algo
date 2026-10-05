'use client';

import React, { useMemo } from 'react';
import type { BasketLeg } from '@/lib/basketStrategies';
import { lookupChainLegData, type ChainOc } from '@/lib/optionsStrategy';
import { bookGreeks } from '@/lib/optionsPayoff';
import { rollForward } from '@/lib/optionsPricing';

interface Props {
  legs: BasketLeg[];
  /** Front-expiry chain, plus off-expiry chains keyed by expiry (each leg is joined to ITS OWN expiry's chain). */
  frontExpiry: string;
  frontChain: ChainOc;
  farChains: Record<string, ChainOc>;
  /** Units per lot x basket multiplier. */
  unitsPerLot: number;
  multiplier: number;
  /** Live index level (Greeks are computed from each leg's live price, not read from the chain). */
  spot: number;
  /** The nearest monthly future and ITS expiry date: rolled to each leg's own expiry as the Black-76 forward. Omit to use spot·e^{rT}. */
  future?: { price: number; expiry: string } | null;
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
 * Greeks of the staged basket, computed through the central payoff library (lib/optionsPayoff.ts bookGreeks): each leg at its own expiry,
 * IV solved from the leg's live chain price (the chain's IV only if there is no live price), one signed multiplier on all four Greeks so
 * the rows sum to the net row. A leg with neither a live price nor a chain IV shows "—" and is left out of the net instead of counted as 0.
 */
export default function BasketGreeksPanel({ legs, frontExpiry, frontChain, farChains, unitsPerLot, multiplier, spot, future }: Props) {
  const { rows, net, missing } = useMemo(() => {
    const info = legs.map(l => {
      const expiry = l.expiry || frontExpiry;
      const oc = !l.expiry || l.expiry === frontExpiry ? frontChain : (farChains[l.expiry] ?? {});
      const c = lookupChainLegData(oc, l.strike, l.option);
      const units = l.lots * multiplier * unitsPerLot * (l.side === 'S' ? -1 : 1);
      const mark = c && typeof c.last_price === 'number' && c.last_price > 0 ? c.last_price : undefined;
      const chainIv = typeof c?.implied_volatility === 'number' && c.implied_volatility > 0 ? c.implied_volatility / 100 : undefined;
      return { l, expiry, units, mark, chainIv };
    });
    const res = spot > 0 ? bookGreeks({
      spot,
      legs: info.map(i => ({
        type: i.l.option, strike: i.l.strike, expiry: i.expiry, qty: i.units, entryPrice: 1, mark: i.mark, chainIv: i.chainIv,
        forward: future && future.price > 0 ? rollForward(future.price, future.expiry, i.expiry) : undefined,
      })),
    }) : null;
    const rows: Row[] = info.map((i, k) => {
      const g = res?.legs[k];
      const usable = !!g && g.ivSource !== 'assumed';
      const scale = (v: number | undefined) => (usable && typeof v === 'number' ? v * i.units : null);
      return {
        id: i.l.id,
        label: `${i.l.side === 'B' ? 'BUY' : 'SELL'} ${i.l.strike} ${i.l.option}`,
        expiry: i.l.expiry,
        units: i.units,
        iv: usable ? g!.iv * 100 : null,
        delta: scale(g?.unit.delta), gamma: scale(g?.unit.gamma), theta: scale(g?.unit.theta), vega: scale(g?.unit.vega),
      };
    });
    const sum = (k: 'delta' | 'gamma' | 'theta' | 'vega') => rows.reduce((a, r) => a + (r[k] ?? 0), 0);
    return {
      rows,
      net: { delta: sum('delta'), gamma: sum('gamma'), theta: sum('theta'), vega: sum('vega') },
      missing: rows.filter(r => r.delta == null).length,
    };
  }, [legs, frontExpiry, frontChain, farChains, unitsPerLot, multiplier, spot, future]);

  if (!legs.length) return null;
  const allMissing = missing === rows.length;

  return (
    <div className="px-3.5 py-2.5 border-t border-zinc-800">
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs font-bold text-zinc-300 uppercase tracking-wider">Position Greeks</span>
        <span className="text-[10px] text-zinc-500 font-mono">from live prices · per position · Θ per day · Vega per 1% IV</span>
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
          {missing} leg{missing > 1 ? 's' : ''} with no live price or IV (market closed or contract not loaded) — excluded from NET.
        </p>
      )}
    </div>
  );
}
