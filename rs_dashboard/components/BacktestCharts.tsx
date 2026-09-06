'use client';

import React from 'react';
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';

// Split out from app/backtest/page.tsx and loaded via next/dynamic so
// recharts stays out of the /backtest initial bundle (charts only render
// after a backtest completes).

interface EquityPoint {
  date: string;
  cumulative_pnl: number;
  spot?: number;
  drawdown?: number;
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function formatDateLabel(dateStr: unknown) {
  if (!dateStr || typeof dateStr !== 'string') return String(dateStr || '');
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const [year, month, day] = parts;
  return `${day} ${MONTHS_SHORT[parseInt(month, 10) - 1]} ${year}`;
}

function fmtRupee(v: number) {
  return `₹${(v / 1000).toFixed(0)}k`;
}

const gridProps = { strokeDasharray: '3 6', vertical: false as const };
const axisTick = { fontSize: 10, fontWeight: 500 as const };

function ChartHeader({ eyebrow, title, sub, legend }: {
  eyebrow: string; title: string; sub: string; legend?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between mb-4 flex-wrap gap-3">
      <div>
        <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] mb-1">{eyebrow}</p>
        <p className="text-sm font-bold text-white tracking-tight">{title}</p>
        <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>
      </div>
      {legend && <div className="flex items-center gap-3 text-[10px] font-semibold">{legend}</div>}
    </div>
  );
}

const EquityTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: EquityPoint }>)[0]?.payload;
  if (!row) return null;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[190px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">{formatDateLabel(String(label))}</p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-emerald-400 font-semibold font-sans">Cumulative P&amp;L</span>
        <span className={`font-bold tabular-nums ${row.cumulative_pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {row.cumulative_pnl >= 0 ? '+' : ''}₹{Math.round(row.cumulative_pnl).toLocaleString('en-IN')}
        </span>
      </div>
      {row.spot != null && (
        <div className="flex justify-between gap-8 pt-2 border-t border-zinc-800">
          <span className="text-blue-400 font-semibold font-sans">Underlying</span>
          <span className="text-white font-bold tabular-nums">{row.spot.toLocaleString('en-IN')}</span>
        </div>
      )}
    </div>
  );
};

const DrawdownTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: EquityPoint }>)[0]?.payload;
  if (!row) return null;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[170px] font-mono">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums font-sans">{formatDateLabel(String(label))}</p>
      <div className="flex justify-between gap-8">
        <span className="text-red-400 font-semibold font-sans">Drawdown</span>
        <span className="text-red-400 font-bold tabular-nums">
          -₹{Math.round(Math.abs(row.drawdown ?? 0)).toLocaleString('en-IN')}
        </span>
      </div>
    </div>
  );
};

export default function BacktestCharts({ equityCurve }: { equityCurve: EquityPoint[] }) {
  return (
    <div className="grid grid-cols-1 gap-4">
      {/* ── Equity Curve & Underlying Value ── */}
      <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-emerald-500/[0.05] via-transparent to-blue-500/[0.04]" />
        <div className="relative">
          <ChartHeader
            eyebrow="Performance"
            title="Equity Curve vs Underlying Value"
            sub="Cumulative strategy P&L against the underlying's own path over the same period"
            legend={<>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded-full bg-emerald-500" />
                <span className="text-zinc-300">Cumulative P&amp;L</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-0.5 rounded-full bg-blue-500" />
                <span className="text-zinc-300">Underlying</span>
              </span>
            </>}
          />
          <ResponsiveContainer width="100%" height={340}>
            <ComposedChart data={equityCurve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="equityFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#10b981" stopOpacity={0.28} />
                  <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridProps} />
              <XAxis
                dataKey="date"
                tick={axisTick}
                tickFormatter={formatDateLabel}
                interval="preserveStartEnd"
                tickLine={false}
              />
              <YAxis
                yAxisId="left"
                tick={axisTick}
                tickFormatter={fmtRupee}
                width={52}
                tickLine={false}
                axisLine={false}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={axisTick}
                tickFormatter={v => v.toLocaleString('en-IN')}
                width={60}
                domain={['auto', 'auto']}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<EquityTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
              <Legend
                verticalAlign="top"
                height={0}
                wrapperStyle={{ display: 'none' }}
              />
              <ReferenceLine yAxisId="left" y={0} strokeDasharray="4 2" />
              <Area
                yAxisId="left"
                type="monotone"
                dataKey="cumulative_pnl"
                name="cumulative_pnl"
                stroke="none"
                fill="url(#equityFill)"
                isAnimationActive={false}
              />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="cumulative_pnl"
                name="cumulative_pnl"
                stroke="#10b981"
                dot={false}
                strokeWidth={1.75}
                isAnimationActive={false}
              />
              <Line
                yAxisId="right"
                type="monotone"
                dataKey="spot"
                name="spot"
                stroke="#3b82f6"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Drawdown Chart ── */}
      <div className="relative bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 overflow-hidden">
        <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-red-500/[0.05] via-transparent to-transparent" />
        <div className="relative">
          <ChartHeader
            eyebrow="Risk"
            title="Drawdown"
            sub="Peak-to-trough decline in cumulative P&L through the backtest window"
          />
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={equityCurve} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <defs>
                <linearGradient id="ddFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#ef4444" stopOpacity={0} />
                  <stop offset="100%" stopColor="#ef4444" stopOpacity={0.32} />
                </linearGradient>
              </defs>
              <CartesianGrid {...gridProps} />
              <XAxis
                dataKey="date"
                tick={axisTick}
                tickFormatter={formatDateLabel}
                interval="preserveStartEnd"
                tickLine={false}
              />
              <YAxis
                tick={axisTick}
                tickFormatter={fmtRupee}
                width={52}
                tickLine={false}
                axisLine={false}
              />
              <Tooltip content={<DrawdownTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }} />
              <Area
                type="monotone"
                dataKey="drawdown"
                name="drawdown"
                stroke="#ef4444"
                fill="url(#ddFill)"
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
