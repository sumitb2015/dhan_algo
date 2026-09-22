'use client';

import React, { useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ReferenceLine,
} from 'recharts';
import { TrendingUp, Layers, Calendar, HelpCircle } from 'lucide-react';
import type { VolSurfaceData } from '@/app/api/options/volatility-surface/route';

interface Props {
  data: VolSurfaceData;
}

const EXPIRY_COLORS = ['#10b981', '#0ea5e9', '#8b5cf6', '#f59e0b', '#ec4899', '#14b8a6'];

export default function TermStructureChart({ data }: Props) {
  const [activeExpiryIdx, setActiveExpiryIdx] = useState<number | null>(null);

  // 1. Data for Term Structure (ATM IV vs Days to Expiry)
  const termStructureData = useMemo(() => {
    return data.expiries.map((exp, idx) => ({
      expiry: exp.expiry.slice(5), // MM-DD
      fullExpiry: exp.expiry,
      dte: exp.dte <= 1 ? 0.5 : Math.round(exp.dte),
      atmIv: exp.atm_iv,
      p25Iv: exp.p25_iv,
      c25Iv: exp.c25_iv,
      rr25d: exp.rr_25d,
      pcr: exp.pcr,
      color: EXPIRY_COLORS[idx % EXPIRY_COLORS.length],
    }));
  }, [data.expiries]);

  // 2. Data for Volatility Smile (IV vs Strikes across expiries)
  const smileData = useMemo(() => {
    return data.strikes.map((strike, sIdx) => {
      const point: Record<string, number> = { strike };
      data.expiries.forEach((exp, eIdx) => {
        point[exp.expiry] = data.surface[eIdx]?.[sIdx] ?? 0;
      });
      return point;
    });
  }, [data.strikes, data.expiries, data.surface]);

  const atmStrike = data.expiries[0]?.atm_strike ?? data.spot;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 w-full">
      {/* 2D Panel 1: Volatility Smile & Skew (Strike vs IV) */}
      <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400">
              <Layers className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                Volatility Smile &amp; Skew (2D Cross-Section)
              </h3>
              <p className="text-[11px] text-zinc-400">
                Implied Volatility (%) across strikes for each expiration tenor
              </p>
            </div>
          </div>
          <span className="text-[11px] font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 px-2 py-0.5 rounded">
            ATM: ₹{atmStrike}
          </span>
        </div>

        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={smileData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
              <XAxis
                dataKey="strike"
                tick={{ fontSize: 10 }}
                tickFormatter={(v) => `₹${v}`}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 10 }}
                domain={['auto', 'auto']}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                formatter={(val, name) => [`${Number(val).toFixed(2)}%`, `Exp ${name}`]}
                labelFormatter={(label) => `Strike: ₹${label}`}
              />
              <ReferenceLine
                x={atmStrike}
                stroke="#10b981"
                strokeDasharray="3 3"
                label={{
                  value: 'ATM',
                  fill: '#10b981',
                  fontSize: 10,
                  position: 'top',
                }}
              />
              {data.expiries.map((exp, idx) => (
                <Line
                  key={exp.expiry}
                  type="monotone"
                  dataKey={exp.expiry}
                  name={exp.expiry}
                  stroke={EXPIRY_COLORS[idx % EXPIRY_COLORS.length]}
                  strokeWidth={activeExpiryIdx === null || activeExpiryIdx === idx ? 2 : 1}
                  strokeOpacity={activeExpiryIdx === null || activeExpiryIdx === idx ? 1 : 0.25}
                  dot={false}
                  isAnimationActive={false}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Expiry Selector / Legend */}
        <div className="flex items-center gap-1.5 flex-wrap mt-2 pt-2 border-t border-zinc-900">
          <span className="text-[10px] text-zinc-500 font-medium mr-1">Filter Tenor:</span>
          <button
            type="button"
            onClick={() => setActiveExpiryIdx(null)}
            className={`text-[10px] px-2 py-0.5 rounded border transition-colors ${
              activeExpiryIdx === null
                ? 'bg-zinc-800 text-white border-zinc-700'
                : 'text-zinc-400 border-zinc-800/80 hover:text-zinc-200'
            }`}
          >
            All Expiries
          </button>
          {data.expiries.map((exp, idx) => (
            <button
              key={exp.expiry}
              type="button"
              onClick={() => setActiveExpiryIdx(activeExpiryIdx === idx ? null : idx)}
              className={`flex items-center gap-1 text-[10px] px-2 py-0.5 rounded border transition-colors ${
                activeExpiryIdx === idx
                  ? 'bg-zinc-800 text-white border-zinc-600'
                  : 'text-zinc-400 border-zinc-800/80 hover:text-zinc-200'
              }`}
            >
              <span
                className="w-2 h-2 rounded-full shrink-0"
                style={{ backgroundColor: EXPIRY_COLORS[idx % EXPIRY_COLORS.length] }}
              />
              <span>{exp.expiry.slice(5)}</span>
              <span className="text-zinc-500">({Math.round(exp.dte)}d)</span>
            </button>
          ))}
        </div>
      </div>

      {/* 2D Panel 2: Term Structure & Calendar Spread (DTE vs ATM IV) */}
      <div className="flex flex-col rounded-xl border border-zinc-800 bg-zinc-950 p-4">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
              <TrendingUp className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-xs font-bold text-white uppercase tracking-wider">
                Implied Volatility Term Structure
              </h3>
              <p className="text-[11px] text-zinc-400">
                ATM IV curve across expiration days — Contango vs Backwardation
              </p>
            </div>
          </div>
          <span
            className={`text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded border ${
              data.term_structure.regime === 'BACKWARDATION'
                ? 'bg-amber-500/10 border-amber-500/30 text-amber-400'
                : data.term_structure.regime === 'CONTANGO'
                ? 'bg-sky-500/10 border-sky-500/30 text-sky-400'
                : 'bg-zinc-800 border-zinc-700 text-zinc-300'
            }`}
          >
            {data.term_structure.regime}
          </span>
        </div>

        <div className="h-[280px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={termStructureData} margin={{ top: 10, right: 10, left: -15, bottom: 0 }}>
              <XAxis
                dataKey="expiry"
                tick={{ fontSize: 10 }}
                tickFormatter={(v, idx) => `${v} (${termStructureData[idx]?.dte ?? 0}d)`}
              />
              <YAxis
                tick={{ fontSize: 10 }}
                domain={['auto', 'auto']}
                tickFormatter={(v) => `${v}%`}
              />
              <Tooltip
                formatter={(val, name) => [
                  `${Number(val).toFixed(2)}%`,
                  name === 'atmIv' ? 'ATM Implied Vol' : name === 'p25Iv' ? '25Δ Put IV' : '25Δ Call IV',
                ]}
                labelFormatter={(_, payload) => {
                  const p = payload?.[0]?.payload;
                  return p ? `${p.fullExpiry} (${p.dte} DTE)` : '';
                }}
              />
              <Legend
                verticalAlign="bottom"
                height={28}
                formatter={(value) => (
                  <span className="text-[10px] text-zinc-400">
                    {value === 'atmIv' ? 'ATM IV' : value === 'p25Iv' ? '25Δ Put IV' : '25Δ Call IV'}
                  </span>
                )}
              />
              <Line
                type="monotone"
                dataKey="atmIv"
                name="atmIv"
                stroke="#10b981"
                strokeWidth={2.5}
                dot={{ r: 4, fill: '#10b981' }}
                activeDot={{ r: 6 }}
              />
              <Line
                type="monotone"
                dataKey="p25Iv"
                name="p25Iv"
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
              <Line
                type="monotone"
                dataKey="c25Iv"
                name="c25Iv"
                stroke="#0ea5e9"
                strokeWidth={1.5}
                strokeDasharray="4 4"
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Strategy Context Callout */}
        <div className="flex items-start gap-2 mt-2 pt-2 border-t border-zinc-900 text-[11px]">
          <HelpCircle className="w-3.5 h-3.5 text-zinc-400 shrink-0 mt-0.5" />
          <div className="text-zinc-300">
            <span className="font-bold text-white">Calendar Vol Opportunity: </span>
            {data.term_structure.regime_desc}
            <div className="mt-1 font-mono text-[10px] text-emerald-400">
              Front IV: {data.term_structure.front_iv.toFixed(2)}% · Back IV: {data.term_structure.back_iv.toFixed(2)}% · Spread:{' '}
              {data.term_structure.spread > 0 ? '+' : ''}
              {data.term_structure.spread.toFixed(2)}%
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
