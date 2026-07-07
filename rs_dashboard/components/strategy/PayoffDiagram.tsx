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

const STEP = 50;

export default function PayoffDiagram({ curve, currentSpot, breakevens }: PayoffDiagramProps) {
  if (curve.length === 0) return null;

  // --- Smart X domain: cover all key points with tight padding ---
  const allStrikes = curve
    .filter((_, i) => i === 0 || i === curve.length - 1 ||
      Math.abs(curve[i].pnl - curve[i - 1].pnl) > 0) // strike kinks
    .map((c) => c.spot);
  const keyX = [...breakevens, currentSpot, ...allStrikes];
  const rawMin = Math.min(...keyX);
  const rawMax = Math.max(...keyX);
  const pad = Math.max(STEP * 4, (rawMax - rawMin) * 0.12);
  const xMin = rawMin - pad;
  const xMax = rawMax + pad;

  // Filter curve to the visible X domain
  const visible = curve.filter((c) => c.spot >= xMin && c.spot <= xMax);
  if (visible.length < 2) return null;

  // --- Smart Y domain: clamp so zero-crossing is prominent ---
  const visiblePnls = visible.map((c) => c.pnl);
  const yMin = Math.min(...visiblePnls);
  const yMax = Math.max(...visiblePnls);
  // For unlimited-loss strategies, cap the loss tail at 3× max profit so the
  // P=0 region stays in the upper ~25% of the chart instead of near the bottom.
  const clampedYMin = yMax > 0 ? Math.max(yMin, -yMax * 3) : yMin * 1.1;
  const clampedYMax = yMin < 0 ? Math.min(yMax, Math.abs(yMin) * 3) : yMax * 1.1;
  const yPad = (clampedYMax - clampedYMin) * 0.08;
  const yDomain: [number, number] = [clampedYMin - yPad, clampedYMax + yPad];

  // Gradient split ratio based on clamped domain
  const domainSpan = yDomain[1] - yDomain[0];
  const off = domainSpan > 0
    ? Math.min(1, Math.max(0, (yDomain[1]) / domainSpan))
    : 0.5;
  const offPct = (off * 100).toFixed(1);

  // X-axis ticks: 5 evenly spaced across domain, always include currentSpot
  const span = xMax - xMin;
  const rawTicks = [xMin, xMin + span * 0.25, xMin + span * 0.5, xMin + span * 0.75, xMax];
  const ticks = Array.from(new Set([...rawTicks.map((t) => Math.round(t / STEP) * STEP), Math.round(currentSpot / STEP) * STEP])).sort((a, b) => a - b);

  return (
    <div className="h-[400px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={visible} margin={{ top: 24, right: 24, bottom: 8, left: 10 }}>
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
            domain={[xMin, xMax]}
            ticks={ticks}
            tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={{ stroke: '#27272a' }}
            tickLine={false}
            tickFormatter={(v: number) => v.toFixed(0)}
          />
          <YAxis
            domain={yDomain}
            tick={{ fill: '#71717a', fontSize: 10, fontFamily: 'monospace' }}
            axisLine={{ stroke: '#27272a' }}
            tickLine={false}
            width={64}
            tickFormatter={(v: number) => {
              if (v === 0) return '0';
              const absVal = Math.abs(v);
              const sign = v > 0 ? '+' : '-';
              if (absVal >= 1000) return `${sign}₹${(absVal / 1000).toFixed(1).replace('.0', '')}k`;
              return `${sign}₹${absVal.toFixed(0)}`;
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
              value: `${currentSpot.toFixed(0)}`,
              fill: '#38bdf8',
              fontSize: 10,
              fontFamily: 'monospace',
              fontWeight: 'bold',
              position: 'insideTopRight',
              offset: 6,
            }}
          />
          {breakevens.map((be, i) => (
            <ReferenceLine
              key={be}
              x={be}
              stroke="#f59e0b"
              strokeWidth={1.5}
              strokeDasharray="4 3"
              label={{
                value: `BE ${be.toFixed(0)}`,
                fill: '#fbbf24',
                fontSize: 10,
                fontFamily: 'monospace',
                fontWeight: 'bold',
                // Alternate above/below so two BEs don't overlap
                position: i % 2 === 0 ? 'insideTopLeft' : 'insideTopRight',
                offset: 6,
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
