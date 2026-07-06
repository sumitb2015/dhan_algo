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
    <div className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-2 text-xs shadow-2xl backdrop-blur-md">
      <div className="text-zinc-400 mb-0.5">Spot: <span className="font-mono text-zinc-100 font-semibold">{spot.toFixed(1)}</span></div>
      <div className={`font-semibold font-mono ${pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
        P&amp;L: {pnl >= 0 ? '+' : ''}₹{pnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
      </div>
    </div>
  );
}

export default function PayoffDiagram({ curve, currentSpot, breakevens }: PayoffDiagramProps) {
  const minVal = curve.length > 0 ? Math.min(...curve.map((c) => c.pnl)) : 0;
  const maxVal = curve.length > 0 ? Math.max(...curve.map((c) => c.pnl)) : 0;

  let off = 0.5;
  if (maxVal !== minVal) {
    if (maxVal <= 0) {
      off = 0;
    } else if (minVal >= 0) {
      off = 1;
    } else {
      off = maxVal / (maxVal - minVal);
    }
  }

  const offPct = (off * 100).toFixed(1);

  const dataMin = curve.length > 0 ? curve[0].spot : currentSpot * 0.98;
  const dataMax = curve.length > 0 ? curve[curve.length - 1].spot : currentSpot * 1.02;
  const ticks = [
    dataMin,
    dataMin + (currentSpot - dataMin) / 2,
    currentSpot,
    currentSpot + (dataMax - currentSpot) / 2,
    dataMax,
  ];

  return (
    <div className="h-[400px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={curve} margin={{ top: 15, right: 20, bottom: 5, left: 10 }}>
          <defs>
            <linearGradient id="pnlSplit" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#10b981" stopOpacity={0.25} />
              <stop offset={`${offPct}%`} stopColor="#10b981" stopOpacity={0.01} />
              <stop offset={`${offPct}%`} stopColor="#ef4444" stopOpacity={0.01} />
              <stop offset="100%" stopColor="#ef4444" stopOpacity={0.25} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
          <XAxis
            dataKey="spot"
            type="number"
            domain={['dataMin', 'dataMax']}
            ticks={ticks}
            tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={{ stroke: '#27272a' }}
            tickLine={false}
            tickFormatter={(v: number) => v.toFixed(0)}
          />
          <YAxis
            tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={{ stroke: '#27272a' }}
            tickLine={false}
            width={60}
            tickFormatter={(v: number) => {
              if (v === 0) return '0';
              const absVal = Math.abs(v);
              const sign = v > 0 ? '+' : '-';
              if (absVal >= 1000) {
                const kVal = (absVal / 1000).toFixed(1).replace('.0', '');
                return `${sign}₹${kVal}k`;
              }
              return `${sign}₹${absVal}`;
            }}
          />
          <Tooltip content={<PayoffTooltip />} />
          <ReferenceLine y={0} stroke="#3f3f46" strokeWidth={1.5} />
          <ReferenceLine
            x={currentSpot}
            stroke="#0ea5e9"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            label={{
              value: `Spot: ${currentSpot.toFixed(1)}`,
              fill: '#38bdf8',
              fontSize: 10,
              fontFamily: 'monospace',
              fontWeight: 'bold',
              position: 'insideTopRight',
              offset: 10,
            }}
          />
          {breakevens.map((be) => (
            <ReferenceLine
              key={be}
              x={be}
              stroke="#f59e0b"
              strokeWidth={1}
              strokeDasharray="3 3"
              label={{
                value: `BE: ${be.toFixed(0)}`,
                fill: '#fbbf24',
                fontSize: 9,
                fontFamily: 'monospace',
                position: 'insideBottom',
                offset: 15,
              }}
            />
          ))}
          <Area
            type="linear"
            dataKey="pnl"
            stroke="none"
            fill="url(#pnlSplit)"
            baseValue={0}
            isAnimationActive={false}
          />
          <Line
            type="linear"
            dataKey="pnl"
            stroke="#f4f4f5"
            strokeWidth={2}
            dot={false}
            isAnimationActive={false}
          />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}
