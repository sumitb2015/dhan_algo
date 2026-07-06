'use client';

import {
  ComposedChart, Area, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ReferenceLine, ResponsiveContainer,
} from 'recharts';

interface PayoffDiagramProps {
  curve: { spot: number; pnl: number }[];
  currentSpot: number;
  breakevens: number[];
}

function PayoffTooltip({ active, payload }: { active?: boolean; payload?: { value: number; payload: { spot: number; pnl: number } }[] }) {
  if (!active || !payload?.length) return null;
  const { spot, pnl } = payload[0].payload;
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-xs shadow-lg">
      <div className="text-zinc-300 font-semibold mb-1">Spot: {spot.toFixed(0)}</div>
      <div className={pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
        P&amp;L: {pnl >= 0 ? '+' : ''}{pnl.toFixed(0)}
      </div>
    </div>
  );
}

export default function PayoffDiagram({ curve, currentSpot, breakevens }: PayoffDiagramProps) {
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={curve} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="pnlPositive" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
            </linearGradient>
            <linearGradient id="pnlNegative" x1="0" y1="1" x2="0" y2="0">
              <stop offset="0%" stopColor="#f43f5e" stopOpacity={0.35} />
              <stop offset="100%" stopColor="#f43f5e" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
          <XAxis
            dataKey="spot" type="number" domain={['dataMin', 'dataMax']}
            tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false}
            tickFormatter={(v: number) => v.toFixed(0)}
          />
          <YAxis tick={{ fill: '#a1a1aa', fontSize: 11 }} axisLine={false} tickLine={false} width={56} />
          <Tooltip content={<PayoffTooltip />} />
          <ReferenceLine y={0} stroke="#71717a" />
          <ReferenceLine x={currentSpot} stroke="#0ea5e9" strokeDasharray="4 3"
            label={{ value: 'Spot', fill: '#0ea5e9', fontSize: 10, position: 'insideTopRight' }} />
          {breakevens.map((be) => (
            <ReferenceLine key={be} x={be} stroke="#f59e0b" strokeDasharray="3 3"
              label={{ value: be.toFixed(0), fill: '#f59e0b', fontSize: 9, position: 'insideBottom' }} />
          ))}
          <Area type="linear" dataKey="pnl" stroke="none" fill="url(#pnlPositive)" baseValue={0} isAnimationActive={false} />
          <Line type="linear" dataKey="pnl" stroke="#e4e4e7" strokeWidth={2} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
