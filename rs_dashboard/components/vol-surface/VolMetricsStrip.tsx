'use client';

import React from 'react';
import { Activity, Gauge, GitCompare, BarChart3, ShieldCheck, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import type { VolSurfaceData } from '@/app/api/options/volatility-surface/route';
import { formatInr, formatCompact } from '@/lib/volatilitySurface';

interface Props {
  data: VolSurfaceData;
}

export default function VolMetricsStrip({ data }: Props) {
  // rr_25d is null for expiries where no strike in the fetched window landed close
  // enough to +/-0.25 delta to count as a genuine 25-delta point — exclude those
  // from the average rather than treating the missing value as 0.
  const validSkews = data.expiries.filter((e) => e.rr_25d !== null) as (typeof data.expiries[number] & {
    rr_25d: number;
  })[];
  const avgSkew = validSkews.length
    ? validSkews.reduce((acc, curr) => acc + curr.rr_25d, 0) / validSkews.length
    : null;

  return (
    <div className="flex flex-col gap-4 w-full">
      {/* 4 Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 w-full">
        {/* Stat 1: Spot Price */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
          <div className="flex items-center justify-between text-zinc-400 mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider">Spot Price</span>
            <Activity className="w-4 h-4 text-emerald-400" />
          </div>
          <div className="text-xl font-bold font-mono text-white tabular-nums">
            ₹{formatInr(data.spot)}
          </div>
          <div className="flex items-center gap-1.5 mt-1 font-mono text-[11px]">
            <span
              className={`flex items-center font-bold ${
                data.change >= 0 ? 'text-emerald-400' : 'text-rose-400'
              }`}
            >
              {data.change >= 0 ? (
                <ArrowUpRight className="w-3.5 h-3.5 inline" />
              ) : (
                <ArrowDownRight className="w-3.5 h-3.5 inline" />
              )}
              {data.change >= 0 ? '+' : ''}
              {data.change.toFixed(2)} ({data.change_pct >= 0 ? '+' : ''}
              {data.change_pct.toFixed(2)}%)
            </span>
            <span className="text-zinc-500">vs prev close</span>
          </div>
        </div>

        {/* Stat 2: Calendar Vol Spread */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
          <div className="flex items-center justify-between text-zinc-400 mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider">Calendar Vol Spread</span>
            <GitCompare className="w-4 h-4 text-sky-400" />
          </div>
          <div className="text-xl font-bold font-mono text-white tabular-nums">
            {data.term_structure.spread > 0 ? '+' : ''}
            {data.term_structure.spread.toFixed(2)}%
          </div>
          <div className="mt-1 font-mono text-[11px] text-zinc-400">
            Front: <span className="text-white font-bold">{data.term_structure.front_iv.toFixed(1)}%</span> · Back:{' '}
            <span className="text-white font-bold">{data.term_structure.back_iv.toFixed(1)}%</span>
          </div>
        </div>

        {/* Stat 3: Term Structure Regime */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
          <div className="flex items-center justify-between text-zinc-400 mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider">Term Structure</span>
            <Gauge className="w-4 h-4 text-amber-400" />
          </div>
          <div
            className={`text-lg font-bold uppercase tracking-tight truncate ${
              data.term_structure.regime === 'BACKWARDATION'
                ? 'text-amber-400'
                : data.term_structure.regime === 'CONTANGO'
                ? 'text-sky-400'
                : 'text-zinc-200'
            }`}
          >
            {data.term_structure.regime}
          </div>
          <div className="mt-1 text-[11px] text-zinc-400 truncate">
            {data.term_structure.regime_label}
          </div>
        </div>

        {/* Stat 4: 25-Delta Skew */}
        <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-3.5">
          <div className="flex items-center justify-between text-zinc-400 mb-1">
            <span className="text-[11px] font-bold uppercase tracking-wider">25Δ Skew (Risk Reversal)</span>
            <ShieldCheck className="w-4 h-4 text-violet-400" />
          </div>
          <div className="text-xl font-bold font-mono text-white tabular-nums">
            {avgSkew === null ? '—' : `${avgSkew > 0 ? '+' : ''}${avgSkew.toFixed(2)}%`}
          </div>
          <div className="mt-1 text-[11px] text-zinc-400 truncate">
            {avgSkew === null
              ? 'No 25Δ strike in window'
              : avgSkew > 0.5
              ? 'Put skew (downside protection bid)'
              : avgSkew < -0.5
              ? 'Call skew (bullish bid)'
              : 'Symmetric wings'}
          </div>
        </div>
      </div>

      {/* Expiry Details Table */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden">
        <div className="px-4 py-2.5 border-b border-zinc-800 bg-zinc-900/50 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-bold text-white uppercase tracking-wider">
              Expiration Tenors &amp; Smile Surface Matrix
            </h3>
          </div>
          <div className="flex items-center gap-2">
            {data.has_synthetic_data && (
              <span
                className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-400 border border-amber-500/30"
                title="Some surface points had no live IV quote on either side and were filled in from the nearest available value rather than market data."
              >
                Contains filled-in points
              </span>
            )}
            <span className="text-[10px] text-zinc-400 font-mono">
              {data.expiries.length} active expiries loaded
            </span>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-800 text-xs font-bold text-white uppercase tracking-wider">
              <tr>
                <th className="px-3.5 py-2">Expiry Date</th>
                <th className="px-3.5 py-2">DTE</th>
                <th className="px-3.5 py-2 text-right">ATM Strike</th>
                <th className="px-3.5 py-2 text-right">ATM IV (%)</th>
                <th className="px-3.5 py-2 text-right">25Δ Put IV</th>
                <th className="px-3.5 py-2 text-right">25Δ Call IV</th>
                <th className="px-3.5 py-2 text-right">25Δ Skew (RR)</th>
                <th className="px-3.5 py-2 text-right">PCR</th>
                <th className="px-3.5 py-2 text-right">Total OI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/60 font-mono tabular-nums">
              {data.expiries.map((exp, idx) => (
                <tr
                  key={exp.expiry}
                  className={`hover:bg-zinc-900/70 transition-colors ${
                    idx === 0 ? 'bg-emerald-500/[0.03]' : ''
                  }`}
                >
                  <td className="px-3.5 py-2.5 font-bold text-white flex items-center gap-2">
                    {exp.expiry}
                    {idx === 0 && (
                      <span className="text-[9px] font-sans font-bold uppercase tracking-wider px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-400 border border-emerald-500/30">
                        Front
                      </span>
                    )}
                  </td>
                  <td className="px-3.5 py-2.5 text-zinc-300">
                    {exp.dte <= 1 ? '0d (Today)' : `${Math.round(exp.dte)} days`}
                  </td>
                  <td className="px-3.5 py-2.5 text-right font-medium text-white">
                    ₹{exp.atm_strike}
                  </td>
                  <td className="px-3.5 py-2.5 text-right font-bold text-emerald-400">
                    {exp.atm_iv.toFixed(2)}%
                  </td>
                  <td className="px-3.5 py-2.5 text-right text-amber-400">
                    {exp.p25_iv !== null ? `${exp.p25_iv.toFixed(2)}%` : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3.5 py-2.5 text-right text-sky-400">
                    {exp.c25_iv !== null ? `${exp.c25_iv.toFixed(2)}%` : <span className="text-zinc-600">—</span>}
                  </td>
                  <td className="px-3.5 py-2.5 text-right text-zinc-300">
                    {exp.rr_25d !== null ? (
                      <span
                        className={`font-bold ${
                          exp.rr_25d > 0 ? 'text-amber-400' : exp.rr_25d < 0 ? 'text-sky-400' : 'text-zinc-400'
                        }`}
                      >
                        {exp.rr_25d > 0 ? '+' : ''}
                        {exp.rr_25d.toFixed(2)}%
                      </span>
                    ) : (
                      <span className="text-zinc-600">—</span>
                    )}
                  </td>
                  <td className="px-3.5 py-2.5 text-right text-zinc-300 font-medium">
                    {exp.pcr.toFixed(2)}
                  </td>
                  <td className="px-3.5 py-2.5 text-right text-zinc-400">
                    {formatCompact(exp.total_oi)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
