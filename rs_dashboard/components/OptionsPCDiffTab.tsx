'use client';

import React from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';

interface CandleRow {
  time: string;
  'CE OI'?: number;
  'PE OI'?: number;
  [key: string]: unknown;
}

interface Props {
  candles: CandleRow[];
  interval: '1' | '5';
  isLive: boolean;
}

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const DiffTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const d: number = payload[0]?.payload?.diff ?? 0;
  return (
    <div style={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      <p style={{ color: '#a1a1aa', marginBottom: 4 }}>{label}</p>
      <p style={{ color: d >= 0 ? '#10b981' : '#ef4444', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {(d >= 0 ? '+' : '') + fmtOI(d)}
      </p>
    </div>
  );
};

export default function OptionsPCDiffTab({ candles, interval, isLive }: Props) {
  const data = candles.map(row => {
    const d = (row['PE OI'] ?? 0) - (row['CE OI'] ?? 0);
    return {
      time: row.time,
      diff: d,
      pos: Math.max(0, d),
      neg: Math.min(0, d),
    };
  });

  const lastRow = candles[candles.length - 1];
  const ceOI    = lastRow?.['CE OI'] ?? 0;
  const peOI    = lastRow?.['PE OI'] ?? 0;
  const diff    = peOI - ceOI;
  const hasData = candles.some(r => (r['CE OI'] ?? 0) > 0 || (r['PE OI'] ?? 0) > 0);
  const diffPos = diff >= 0;

  if (!hasData) {
    return (
      <div className="flex items-center justify-center h-40 text-zinc-500 text-sm">
        No OI data — select an expiry and strike above
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">

      {/* Stat tiles */}
      <div className="grid grid-cols-3 gap-3">
        {([
          {
            label: 'CE OI',
            value: ceOI > 0 ? fmtOI(ceOI) : '—',
            color: 'text-blue-400',
            accent: 'border-blue-500/25',
          },
          {
            label: 'PE OI',
            value: peOI > 0 ? fmtOI(peOI) : '—',
            color: 'text-red-400',
            accent: 'border-red-500/25',
          },
          {
            label: 'PC Diff',
            value: hasData ? (diff >= 0 ? '+' : '') + fmtOI(diff) : '—',
            color: diffPos ? 'text-emerald-400' : 'text-red-400',
            accent: diffPos ? 'border-emerald-500/25' : 'border-red-500/25',
          },
        ]).map(({ label, value, color, accent }) => (
          <div key={label} className={`bg-zinc-900/70 border rounded-xl px-3 py-3 ${accent}`}>
            <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1">{label}</p>
            <p className={`text-base font-bold tabular-nums ${color}`}>{value}</p>
          </div>
        ))}
      </div>

      {/* Chart */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-bold text-white tracking-tight">Puts − Calls OI Difference</p>
            <p className="text-[10px] text-zinc-400 mt-0.5">
              Positive (green) = PE dominant · Negative (red) = CE dominant &nbsp;·&nbsp; {interval}m candles
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-semibold">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
              <span className="text-zinc-300">Bullish</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-red-500" />
              <span className="text-zinc-300">Bearish</span>
            </span>
            {isLive && (
              <span className="px-2 py-0.5 bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 rounded-full">
                LIVE
              </span>
            )}
          </div>
        </div>

        <ResponsiveContainer width="100%" height={420}>
          <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="pcDiffGreen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#10b981" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0.04} />
              </linearGradient>
              <linearGradient id="pcDiffRed" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.04} />
                <stop offset="95%" stopColor="#ef4444" stopOpacity={0.35} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
            />
            <YAxis
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={62}
              domain={['auto', 'auto']}
              tickFormatter={v => (Number(v) >= 0 ? '+' : '') + fmtOI(Number(v))}
            />
            <Tooltip content={<DiffTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1 }} />
            <ReferenceLine y={0} stroke="#71717a" strokeWidth={1} strokeDasharray="4 3" />
            {/* Positive area — green above zero */}
            <Area
              type="monotone"
              dataKey="pos"
              stroke="#10b981"
              strokeWidth={1.5}
              fill="url(#pcDiffGreen)"
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
            />
            {/* Negative area — red below zero */}
            <Area
              type="monotone"
              dataKey="neg"
              stroke="#ef4444"
              strokeWidth={1.5}
              fill="url(#pcDiffRed)"
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

    </div>
  );
}
