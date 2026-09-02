'use client';

import React, { useState, useEffect, useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts';
import type { StrikeHistoryPoint } from '@/app/api/options/strike-history/route';

interface Row extends StrikeHistoryPoint {
  idx: number;
  date: string;
  time: string;
}

interface DayBoundary {
  idx: number;
  date: string;
}

function fmtPrice(n: number): string {
  return `₹${n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtOi(n: number): string {
  if (n >= 1e7) return `${(n / 1e7).toFixed(2)}Cr`;
  if (n >= 1e5) return `${(n / 1e5).toFixed(2)}L`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString('en-IN');
}

function ChartHeader({
  eyebrow, title, sub,
}: { eyebrow: string; title: string; sub: string }) {
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">{eyebrow}</p>
        <p className="text-sm font-bold text-white tracking-tight">{title}</p>
        <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>
      </div>
    </div>
  );
}

function PulseStat({
  label, value, sub, color = 'text-white',
}: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="flex flex-col min-w-0">
      <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em] mb-0.5">{label}</span>
      <span className={`text-2xl font-mono font-bold tabular-nums leading-none ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-500 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

const StrikeHistoryTooltip = ({ active, payload }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: Row }>)[0]?.payload;
  if (!row) return null;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[190px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">{row.date} {row.time}</p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-sans">Close</span>
        <span className="text-white font-bold tabular-nums">{fmtPrice(row.close)}</span>
      </div>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-sans">Strike</span>
        <span className="text-zinc-200 font-bold tabular-nums">{row.strike.toLocaleString('en-IN')}</span>
      </div>
      <div className="flex justify-between gap-8 mb-2">
        <span className="text-zinc-400 font-sans">Spot</span>
        <span className="text-zinc-200 font-bold tabular-nums">{row.spot.toLocaleString('en-IN')}</span>
      </div>
      <div className="pt-2 border-t border-zinc-800 flex justify-between gap-8 mb-1">
        <span className="text-amber-400 font-semibold font-sans">OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOi(row.oi)}</span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-cyan-400 font-semibold font-sans">IV</span>
        <span className="text-white font-bold tabular-nums">{row.iv ? `${row.iv.toFixed(2)}%` : '—'}</span>
      </div>
    </div>
  );
};

export default function StrikeHistoryTab({
  expiry, strikeRelative, optionType,
}: { expiry: string; strikeRelative: string; optionType: 'CE' | 'PE' }) {
  const [points, setPoints] = useState<StrikeHistoryPoint[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!expiry || !strikeRelative || !optionType) return;
    setLoading(true);
    setError('');
    const controller = new AbortController();

    fetch(`/api/options/strike-history?expiry=${expiry}&strikeRelative=${strikeRelative}&optionType=${optionType}`, {
      signal: controller.signal,
    })
      .then(r => r.json())
      .then((j: { success: boolean; points?: StrikeHistoryPoint[]; error?: string }) => {
        if (j.success && j.points) {
          setPoints(j.points);
        } else {
          setError(j.error ?? 'Failed to load strike history');
          setPoints([]);
        }
      })
      .catch(e => {
        if (e instanceof DOMException && e.name === 'AbortError') return;
        setError(String(e));
      })
      .finally(() => setLoading(false));

    return () => controller.abort();
  }, [expiry, strikeRelative, optionType]);

  const { rows, dayBoundaries } = useMemo(() => {
    const r: Row[] = points.map((p, idx) => ({
      ...p,
      idx,
      date: p.datetime.slice(0, 10),
      time: p.datetime.slice(11, 16),
    }));
    const boundaries: DayBoundary[] = [];
    let lastDate = '';
    for (const row of r) {
      if (row.date !== lastDate) {
        boundaries.push({ idx: row.idx, date: row.date });
        lastDate = row.date;
      }
    }
    return { rows: r, dayBoundaries: boundaries };
  }, [points]);

  const closes = rows.map(r => r.close);
  const minClose = closes.length ? Math.min(...closes) : 0;
  const maxClose = closes.length ? Math.max(...closes) : 0;
  const first = rows[0];
  const last = rows[rows.length - 1];

  const accent = optionType === 'CE' ? { line: '#60a5fa', fillFrom: '#60a5fa', text: 'text-blue-400' }
                                      : { line: '#f87171', fillFrom: '#f87171', text: 'text-red-400' };

  const gridProps = { strokeDasharray: '3 6', stroke: '#20202399', vertical: false as const };
  const xAxisProps = {
    dataKey: 'idx' as const,
    tickFormatter: (idx: number) => rows[idx]?.time ?? '',
    tick:      { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const, fontFamily: 'var(--font-mono)' },
    tickLine:  false,
    axisLine:  { stroke: '#27272a' },
    interval:  'preserveStartEnd' as const,
    minTickGap: 40,
  };

  if (loading && !rows.length) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-emerald-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading strike history…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
        {error}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
        No data for this expiry / strike / option type combination.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-emerald-500/[0.06] via-transparent to-blue-500/[0.04]" />
        <div className="relative flex items-stretch gap-6 px-5 py-4 flex-wrap">
          <PulseStat label="Strike" value={`${strikeRelative} · ${optionType}`} color={accent.text} />
          <div className="w-px bg-zinc-800 self-stretch" />
          <PulseStat label="Open" value={first ? fmtPrice(first.close) : '—'} />
          <div className="w-px bg-zinc-800 self-stretch" />
          <PulseStat label="Last" value={last ? fmtPrice(last.close) : '—'} color="text-emerald-400" />
          <div className="w-px bg-zinc-800 self-stretch" />
          <PulseStat label="Range" value={`${fmtPrice(minClose)} – ${fmtPrice(maxClose)}`} />
          <div className="ml-auto flex items-center gap-5 flex-wrap">
            <PulseStat label="Bars" value={rows.length.toLocaleString('en-IN')} />
            <PulseStat label="Trading Days" value={dayBoundaries.length.toLocaleString('en-IN')} />
          </div>
        </div>
      </div>

      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <ChartHeader
          eyebrow="History"
          title={`${strikeRelative} ${optionType} — Close Price`}
          sub={`1-minute close price · ${expiry} expiry · ${dayBoundaries.length} trading days`}
        />
        <ResponsiveContainer width="100%" height={420}>
          <AreaChart data={rows} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
            <defs>
              <linearGradient id="strikeHistoryFill" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={accent.fillFrom} stopOpacity={0.4} />
                <stop offset="100%" stopColor={accent.fillFrom} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid {...gridProps} />
            <XAxis {...xAxisProps} />
            <YAxis
              tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
              tickLine={false}
              axisLine={false}
              width={54}
              tickFormatter={v => `₹${v}`}
            />
            <Tooltip content={<StrikeHistoryTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
            {dayBoundaries.slice(1).map(b => (
              <ReferenceLine
                key={b.idx}
                x={b.idx}
                stroke="#3f3f46"
                strokeDasharray="2 4"
                strokeWidth={1}
                label={{ value: b.date.slice(5), position: 'top', fill: '#71717a', fontSize: 9, fontWeight: 600 }}
              />
            ))}
            <Area
              type="monotone"
              dataKey="close"
              name="Close"
              stroke={accent.line}
              strokeWidth={2}
              fill="url(#strikeHistoryFill)"
              dot={false}
              activeDot={{ r: 4, fill: accent.line, stroke: '#09090b', strokeWidth: 2 }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
