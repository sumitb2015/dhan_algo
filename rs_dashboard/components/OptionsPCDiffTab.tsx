'use client';

import React from 'react';
import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ReferenceLine, ResponsiveContainer,
} from 'recharts';

interface CandleRow {
  time: string;
  'CE OI'?: number;
  'PE OI'?: number;
  'CE LTP'?: number;
  'PE LTP'?: number;
  [key: string]: unknown;
}

interface Props {
  candles: CandleRow[];
  vixCandles: any[];
  interval: '1' | '5';
  isLive: boolean;
  niftyPrice: number;
  niftyChangePct: number | null;
  vixPrice: number;
  vixChangePct: number | null;
  ceChangePct: number | null;
  peChangePct: number | null;
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
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      <p style={{ color: 'var(--chart-tick)', marginBottom: 4 }}>{label}</p>
      <p style={{ color: d >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {(d >= 0 ? '+' : '') + fmtOI(d)}
      </p>
    </div>
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const PremiumDiffTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const d: number = payload[0]?.payload?.diff ?? 0;
  return (
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      <p style={{ color: 'var(--chart-tick)', marginBottom: 4 }}>{label}</p>
      <p style={{ color: d >= 0 ? 'var(--chart-pos)' : 'var(--chart-neg)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        {(d >= 0 ? '+' : '') + d.toFixed(2)}
      </p>
    </div>
  );
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const VixTabTooltip = ({ active, payload, label }: any) => {
  if (!active || !payload?.length) return null;
  const row = payload[0]?.payload;
  return (
    <div style={{ background: 'var(--chart-tooltip-bg)', border: '1px solid var(--chart-tooltip-border)', color: 'var(--chart-tooltip-text)', borderRadius: 8, padding: '6px 10px', fontSize: 11 }}>
      <p style={{ color: 'var(--chart-tick)', marginBottom: 4 }}>{label}</p>
      <p style={{ color: 'var(--a-indigo-400)', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>
        VIX: {Number(row?.close ?? 0).toFixed(2)}
      </p>
      {row?.ma20 != null && (
        <p style={{ color: 'var(--a-amber-400)', fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
          MA (20): {Number(row.ma20).toFixed(2)}
        </p>
      )}
      {row?.nifty && (
        <p style={{ color: '#10b981', fontWeight: 700, fontVariantNumeric: 'tabular-nums', marginTop: 2 }}>
          Nifty: {Number(row.nifty).toLocaleString('en-IN', { maximumFractionDigits: 2 })}
        </p>
      )}
    </div>
  );
};

export default function OptionsPCDiffTab({
  candles, vixCandles, interval, isLive, niftyPrice, niftyChangePct, vixPrice, vixChangePct, ceChangePct, peChangePct
}: Props) {
  const data = candles.map(row => {
    const d = (row['PE OI'] ?? 0) - (row['CE OI'] ?? 0);
    return {
      time: row.time,
      diff: d,
      pos: Math.max(0, d),
      neg: Math.min(0, d),
    };
  });

  const premiumData = candles.map(row => {
    const peLtp = (row['PE LTP'] as number) ?? 0;
    const ceLtp = (row['CE LTP'] as number) ?? 0;
    const d = peLtp - ceLtp;
    return {
      time: row.time,
      diff: d,
      pos: Math.max(0, d),
      neg: Math.min(0, d),
    };
  });

  const vixDataWithMA = vixCandles.map((c, i) => {
    if (i < 19) {
      return { ...c, ma20: null };
    }
    let sum = 0;
    for (let j = 0; j < 20; j++) {
      sum += vixCandles[i - j].close;
    }
    return { ...c, ma20: parseFloat((sum / 20).toFixed(4)) };
  });

  const lastRow = candles[candles.length - 1];
  const ceOI    = lastRow?.['CE OI'] ?? 0;
  const peOI    = lastRow?.['PE OI'] ?? 0;
  const diff    = peOI - ceOI;
  const hasData = candles.some(r => (r['CE OI'] ?? 0) > 0 || (r['PE OI'] ?? 0) > 0);
  const diffPos = diff >= 0;

  const lastCeLtp = lastRow?.['CE LTP'] as number ?? 0;
  const lastPeLtp = lastRow?.['PE LTP'] as number ?? 0;
  const premDiff  = lastPeLtp - lastCeLtp;
  const premDiffPos = premDiff >= 0;

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
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-8 gap-3">
        {([
          {
            label: 'Nifty Spot',
            value: niftyPrice > 0 ? niftyPrice.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—',
            sub: niftyChangePct !== null ? `${niftyChangePct >= 0 ? '+' : ''}${niftyChangePct.toFixed(2)}%` : undefined,
            color: niftyChangePct === null ? 'text-zinc-100' : niftyChangePct >= 0 ? 'text-emerald-400' : 'text-red-400',
            accent: niftyChangePct === null ? 'border-zinc-700/60' : niftyChangePct >= 0 ? 'border-emerald-500/25' : 'border-red-500/25',
          },
          {
            label: 'India VIX',
            value: vixPrice > 0 ? vixPrice.toFixed(2) : '—',
            sub: vixChangePct !== null ? `${vixChangePct >= 0 ? '+' : ''}${vixChangePct.toFixed(2)}%` : undefined,
            color: vixChangePct === null ? 'text-amber-400' : vixChangePct >= 0 ? 'text-red-400' : 'text-emerald-400',
            accent: 'border-zinc-700/60',
          },
          {
            label: 'CE Premium',
            value: lastCeLtp > 0 ? lastCeLtp.toFixed(2) : '—',
            sub: ceChangePct !== null ? `${ceChangePct >= 0 ? '+' : ''}${ceChangePct.toFixed(2)}%` : undefined,
            subColor: ceChangePct !== null && ceChangePct >= 0 ? 'text-emerald-400' : 'text-red-400',
            color: 'text-blue-400',
            accent: 'border-blue-500/25',
          },
          {
            label: 'PE Premium',
            value: lastPeLtp > 0 ? lastPeLtp.toFixed(2) : '—',
            sub: peChangePct !== null ? `${peChangePct >= 0 ? '+' : ''}${peChangePct.toFixed(2)}%` : undefined,
            subColor: peChangePct !== null && peChangePct >= 0 ? 'text-emerald-400' : 'text-red-400',
            color: 'text-red-400',
            accent: 'border-red-500/25',
          },
          {
            label: 'Premium Diff',
            value: hasData ? (premDiff >= 0 ? '+' : '') + premDiff.toFixed(2) : '—',
            color: premDiffPos ? 'text-emerald-400' : 'text-red-400',
            accent: premDiffPos ? 'border-emerald-500/25' : 'border-red-500/25',
          },
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
            label: 'PC Diff (OI)',
            value: hasData ? (diff >= 0 ? '+' : '') + fmtOI(diff) : '—',
            color: diffPos ? 'text-emerald-400' : 'text-red-400',
            accent: diffPos ? 'border-emerald-500/25' : 'border-red-500/25',
          },
        ]).map(({ label, value, sub, subColor, color, accent }) => (
          <div key={label} className={`bg-zinc-900/70 border rounded-xl px-3 py-3 flex flex-col justify-between ${accent}`}>
            <div>
              <p className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mb-1">{label}</p>
              <p className={`text-base font-bold tabular-nums ${color}`}>{value}</p>
            </div>
            {sub && <p className={`text-[10px] font-medium mt-1 ${subColor || color}`}>{sub}</p>}
          </div>
        ))}
      </div>

      {/* OI Difference Chart */}
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

        <ResponsiveContainer width="100%" height={400}>
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

      {/* Premium Difference Chart */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-bold text-white tracking-tight">Put − Call Premium Difference</p>
            <p className="text-[10px] text-zinc-400 mt-0.5">
              Positive (green) = PE higher (Put dominant) · Negative (red) = CE higher (Call dominant) &nbsp;·&nbsp; {interval}m candles
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-semibold">
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
              <span className="text-zinc-300">Put Dominant</span>
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2.5 h-2.5 rounded-sm bg-red-500" />
              <span className="text-zinc-300">Call Dominant</span>
            </span>
            {isLive && (
              <span className="px-2 py-0.5 bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 rounded-full">
                LIVE
              </span>
            )}
          </div>
        </div>

        <ResponsiveContainer width="100%" height={400}>
          <AreaChart data={premiumData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="pcPremGreen" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#10b981" stopOpacity={0.35} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0.04} />
              </linearGradient>
              <linearGradient id="pcPremRed" x1="0" y1="0" x2="0" y2="1">
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
              tickFormatter={v => (Number(v) >= 0 ? '+' : '') + Number(v).toFixed(1)}
            />
            <Tooltip content={<PremiumDiffTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1 }} />
            <ReferenceLine y={0} stroke="#71717a" strokeWidth={1} strokeDasharray="4 3" />
            <Area
              type="monotone"
              dataKey="pos"
              stroke="#10b981"
              strokeWidth={1.5}
              fill="url(#pcPremGreen)"
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
            />
            <Area
              type="monotone"
              dataKey="neg"
              stroke="#ef4444"
              strokeWidth={1.5}
              fill="url(#pcPremRed)"
              dot={false}
              activeDot={false}
              legendType="none"
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {/* India VIX Chart */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col">
        <div className="flex items-center justify-between mb-4">
          <div>
            <p className="text-sm font-bold text-white tracking-tight">India VIX</p>
            <p className="text-[10px] text-zinc-400 mt-0.5">
              Volatility index overlay with 20 MA (orange) · {interval}m candles
            </p>
          </div>
          <div className="flex items-center gap-3 text-[10px] font-semibold">
            {isLive && (
              <span className="px-2 py-0.5 bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 rounded-full">
                LIVE
              </span>
            )}
          </div>
        </div>

        <ResponsiveContainer width="100%" height={320}>
          <AreaChart data={vixDataWithMA} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="pcVixPurple" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor="#818cf8" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#818cf8" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="time"
              tick={{ fill: '#71717a', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              interval={Math.max(0, Math.floor(vixCandles.length / 12) - 1)}
            />
            <YAxis
              tick={{ fill: '#818cf8', fontSize: 10 }}
              tickLine={false}
              axisLine={false}
              width={62}
              domain={['auto', 'auto']}
              tickFormatter={v => Number(v).toFixed(2)}
            />
            <Tooltip content={<VixTabTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1 }} />
            <Area
              type="monotone"
              dataKey="close"
              stroke="#818cf8"
              strokeWidth={1.5}
              fill="url(#pcVixPurple)"
              dot={false}
              activeDot={{ r: 3, fill: '#818cf8' }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="ma20"
              stroke="#f59e0b"
              strokeWidth={1.5}
              strokeDasharray="4 4"
              dot={false}
              activeDot={false}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>

    </div>
  );
}
