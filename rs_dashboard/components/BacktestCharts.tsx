'use client';

import React from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
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

function formatDateLabel(dateStr: any) {
  if (!dateStr || typeof dateStr !== 'string') return String(dateStr || '');
  const parts = dateStr.split('-');
  if (parts.length !== 3) return dateStr;
  const year = parts[0];
  const monthIdx = parseInt(parts[1], 10) - 1;
  const day = parts[2];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${day} ${months[monthIdx]} ${year}`;
}

export default function BacktestCharts({ equityCurve }: { equityCurve: EquityPoint[] }) {
  return (
    <>
      {/* ── Equity Curve & Underlying Value ── */}
      <div>
        <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Equity Curve vs Underlying Value</div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={equityCurve} margin={{ top: 4, right: 12, left: 12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9, fill: '#71717a' }}
                tickFormatter={formatDateLabel}
                interval="preserveStartEnd"
              />
              <YAxis
                yAxisId="left"
                tick={{ fontSize: 9, fill: '#71717a' }}
                tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`}
                width={52}
              />
              <YAxis
                yAxisId="right"
                orientation="right"
                tick={{ fontSize: 9, fill: '#71717a' }}
                tickFormatter={v => v.toLocaleString('en-IN')}
                width={60}
                domain={['auto', 'auto']}
              />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: '#a1a1aa' }}
                labelFormatter={formatDateLabel}
                formatter={(v: unknown, name: any) => {
                  if (name === 'spot') return [`${(v as number).toLocaleString('en-IN')}`, 'Underlying Value'];
                  if (name === 'cumulative_pnl') return [`₹${(v as number).toLocaleString('en-IN')}`, 'Cumulative PnL'];
                  return [`${v}`, String(name || '')];
                }}
              />
              <Legend verticalAlign="top" height={32} iconType="rect" wrapperStyle={{ fontSize: 10, fontWeight: 'bold' }} />
              <ReferenceLine yAxisId="left" y={0} stroke="#52525b" strokeDasharray="4 2" />
              <Line
                yAxisId="left"
                type="monotone"
                dataKey="cumulative_pnl"
                name="cumulative_pnl"
                stroke="#10b981"
                dot={false}
                strokeWidth={1.5}
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
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ── Drawdown Chart ── */}
      <div>
        <div className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-3">Drawdown</div>
        <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 h-64">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={equityCurve} margin={{ top: 4, right: 12, left: 12, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" />
              <XAxis
                dataKey="date"
                tick={{ fontSize: 9, fill: '#71717a' }}
                tickFormatter={formatDateLabel}
                interval="preserveStartEnd"
              />
              <YAxis
                tick={{ fontSize: 9, fill: '#71717a' }}
                tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`}
                width={52}
              />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: '#a1a1aa' }}
                labelFormatter={formatDateLabel}
                formatter={(v: unknown) => [`₹${(v as number).toLocaleString('en-IN')}`, 'Drawdown']}
              />
              <Line
                type="monotone"
                dataKey="drawdown"
                name="drawdown"
                stroke="#ef4444"
                dot={false}
                strokeWidth={1.5}
                isAnimationActive={false}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
    </>
  );
}
