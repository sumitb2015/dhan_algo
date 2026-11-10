'use client';

/**
 * Fresh Money — "new money share" chart: per side, the share of the last 5 minutes' volume that opened or closed
 * positions (changed open interest). Made to be read without knowing the maths:
 *  - a one-line reading of the latest values (which side leads, rising / falling, versus normal when history allows);
 *  - the gap between the two lines is filled in the colour of the side that leads;
 *  - the time axis is zoomed to the hours that have data, and collector gaps are marked "no data";
 *  - the normal range for the time of day (from >= 5 days of history) is drawn as dashed edges;
 *  - a key under the chart says what each mark means.
 * Pure logic in lib/freshMoneyChart.ts.
 */

import React, { useMemo } from 'react';
import { ArrowDownRight, ArrowRight, ArrowUpRight } from 'lucide-react';
import {
  Area, CartesianGrid, ComposedChart, Line, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import type { FreshMoneyResponse } from '@/app/api/fresh-money/route';
import {
  buildChartPoints, chartDomain, findGaps, latestReading, LEAD_PP, type ChartPoint, type SideReading,
} from '@/lib/freshMoneyChart';

const PUT_COLOR = 'var(--color-emerald-400)';
const CALL_COLOR = 'var(--color-red-400)';
const GAP_FILL = 'var(--color-zinc-500)';

const hhmm = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const pct = (v: number | null) => (v === null ? '–' : `${Math.round(v)}%`);

function leadOf(p: ChartPoint): 'Puts lead' | 'Calls lead' | 'Even' | null {
  if (p.puts === null || p.calls === null) return null;
  if (Math.abs(p.puts - p.calls) < LEAD_PP) return 'Even';
  return p.puts > p.calls ? 'Puts lead' : 'Calls lead';
}

function vsText(v: number | null, band: [number, number] | null): string | null {
  if (v === null || !band) return null;
  return v > band[1] ? 'above normal' : v < band[0] ? 'below normal' : 'normal';
}

function ChartTooltip({ active, payload }: { active?: boolean; payload?: Array<{ payload: ChartPoint }> }) {
  const d = payload?.[0]?.payload;
  if (!active || !d || (d.puts === null && d.calls === null)) return null;
  const lead = leadOf(d);
  const row = (name: string, cls: string, v: number | null, band: [number, number] | null) => {
    const vs = vsText(v, band);
    return (
      <div className={cls}>
        {name} <span className="font-bold">{pct(v)}</span>
        {band && <span className="text-zinc-400"> · normal {Math.round(band[0])}-{Math.round(band[1])}%{vs ? ` (${vs})` : ''}</span>}
      </div>
    );
  };
  return (
    <div className="rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 text-[11px] tabular-nums shadow-lg">
      <div className="mb-1 flex items-center gap-2 font-bold text-zinc-200">
        {hhmm(d.m)}{lead && <span className="font-medium text-zinc-400">{lead}</span>}
      </div>
      {row('Puts', 'text-emerald-400', d.puts, d.putBand)}
      {row('Calls', 'text-red-400', d.calls, d.callBand)}
      <div className="mt-1 text-zinc-500">% of the last 5 min&apos;s volume that opened or closed positions</div>
    </div>
  );
}

function TrendIcon({ trend }: { trend: SideReading['trend'] }) {
  if (trend === 'rising') return <ArrowUpRight className="h-3.5 w-3.5" aria-label="rising" />;
  if (trend === 'falling') return <ArrowDownRight className="h-3.5 w-3.5" aria-label="falling" />;
  if (trend === 'flat') return <ArrowRight className="h-3.5 w-3.5" aria-label="steady" />;
  return null;
}

function SideChip({ name, dot, r }: { name: string; dot: string; r: SideReading | null }) {
  return (
    <span className="inline-flex items-center gap-1 rounded border border-zinc-800 bg-zinc-950/40 px-1.5 py-0.5 text-[11px] tabular-nums text-zinc-300">
      <span className={`h-2 w-2 rounded-full ${dot}`} aria-hidden />
      {name} <span className="font-bold text-zinc-100">{r ? pct(r.value) : '–'}</span>
      {r && <TrendIcon trend={r.trend} />}
      {r?.vsNormal && r.vsNormal !== 'normal' && (
        <span className="rounded bg-zinc-800 px-1 text-[10px] font-bold uppercase text-amber-300">{r.vsNormal} normal</span>
      )}
    </span>
  );
}

function KeySwatch({ children, label }: { children: React.ReactNode; label: string }) {
  return <span className="inline-flex items-center gap-1">{children}<span>{label}</span></span>;
}

export default function FreshChart({ data, height }: { data: FreshMoneyResponse; height: number }) {
  const showBand = data.band.length > 0;
  const domain = useMemo(() => chartDomain(data.series, data.day), [data.series, data.day]);
  const points = useMemo(() => buildChartPoints(data.series, showBand ? data.band : [], domain), [data.series, data.band, showBand, domain]);
  const gaps = useMemo(() => findGaps(data.series).filter(([a, b]) => b > domain[0] && a < domain[1]), [data.series, domain]);
  const reading = useMemo(() => latestReading(data.series, showBand ? data.band : []), [data.series, data.band, showBand]);

  const yMax = useMemo(() => {
    let mx = 0;
    for (const p of points) mx = Math.max(mx, p.puts ?? 0, p.calls ?? 0, p.putBand?.[1] ?? 0, p.callBand?.[1] ?? 0);
    return Math.max(40, Math.ceil(mx / 10) * 10);
  }, [points]);
  const yTicks = useMemo(() => {
    const step = yMax > 60 ? 20 : 10;
    return Array.from({ length: Math.floor(yMax / step) + 1 }, (_, i) => i * step);
  }, [yMax]);
  const xTicks = useMemo(() => {
    const span = domain[1] - domain[0];
    const step = span > 10 * 60 ? 120 : span > 4 * 60 ? 60 : 30;
    const out: number[] = [];
    for (let m = domain[0]; m <= domain[1]; m += step) out.push(m);
    return out;
  }, [domain]);
  // A dot on each line's latest reading, so "now" is visible at a glance.
  const lastIdx = useMemo(() => {
    let p = -1, c = -1;
    points.forEach((pt, i) => { if (pt.puts !== null) p = i; if (pt.calls !== null) c = i; });
    return { puts: p, calls: c };
  }, [points]);
  const lastDot = (side: 'puts' | 'calls', color: string) => function LastDot(props: { cx?: number; cy?: number; index?: number }) {
    if (props.index !== lastIdx[side] || props.cx == null || props.cy == null) return <g key={`${side}-${props.index}`} />;
    return <circle key={`${side}-last`} cx={props.cx} cy={props.cy} r={3.5} fill={color} stroke="var(--color-zinc-900)" strokeWidth={1.5} />;
  };

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-[12.5px] font-bold text-zinc-200">New money share</span>
        <span className="text-[11px] text-zinc-500">rolling 5 min · % of each side&apos;s volume that opened or closed positions</span>
        <span className="ml-auto flex items-center gap-1.5">
          {reading && <span className="text-[10px] text-zinc-500">as of {hhmm(reading.m)}</span>}
          <SideChip name="Puts" dot="bg-emerald-400" r={reading?.puts ?? null} />
          <SideChip name="Calls" dot="bg-red-400" r={reading?.calls ?? null} />
        </span>
      </div>
      <p className="mb-2 min-h-[18px] text-[12px] text-zinc-300">
        {reading ? reading.text : 'No readings yet today — the first appears 5 minutes after the collector starts.'}
      </p>

      <div style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 6, right: 12, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} strokeDasharray="0" strokeOpacity={0.35} />
            <XAxis dataKey="m" type="number" domain={domain} ticks={xTicks} tickFormatter={hhmm} tick={{ fontSize: 11 }} tickLine={false} />
            <YAxis domain={[0, yMax]} ticks={yTicks} tickFormatter={(v: number) => `${v}%`} tick={{ fontSize: 11 }}
              tickLine={false} axisLine={false} width={44} />
            <Tooltip content={<ChartTooltip />} cursor={{ stroke: 'var(--chart-cursor-line)', strokeWidth: 1 }} />
            {gaps.map(([a, b]) => (
              <ReferenceArea key={`gap-${a}`} x1={a} x2={b} fill={GAP_FILL} fillOpacity={0.12} stroke="none" ifOverflow="hidden"
                label={b - a >= 8 ? { value: 'no data', position: 'insideTop', fill: GAP_FILL, fontSize: 10 } : undefined} />
            ))}
            {showBand && (
              <>
                <Area dataKey="putBand" stroke={PUT_COLOR} strokeOpacity={0.55} strokeDasharray="3 3" strokeWidth={1}
                  fill="none" isAnimationActive={false} connectNulls={false} activeDot={false} />
                <Area dataKey="callBand" stroke={CALL_COLOR} strokeOpacity={0.55} strokeDasharray="3 3" strokeWidth={1}
                  fill="none" isAnimationActive={false} connectNulls={false} activeDot={false} />
              </>
            )}
            <Area dataKey="putLead" stroke="none" fill={PUT_COLOR} fillOpacity={0.3} isAnimationActive={false} connectNulls={false} activeDot={false} />
            <Area dataKey="callLead" stroke="none" fill={CALL_COLOR} fillOpacity={0.3} isAnimationActive={false} connectNulls={false} activeDot={false} />
            <Line dataKey="calls" stroke={CALL_COLOR} strokeWidth={2} dot={lastDot('calls', CALL_COLOR)} activeDot={{ r: 3 }} isAnimationActive={false} connectNulls={false} />
            <Line dataKey="puts" stroke={PUT_COLOR} strokeWidth={2} dot={lastDot('puts', PUT_COLOR)} activeDot={{ r: 3 }} isAnimationActive={false} connectNulls={false} />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-zinc-400">
        <KeySwatch label="Puts"><span className="h-0.5 w-4 rounded bg-emerald-400" /></KeySwatch>
        <KeySwatch label="Calls"><span className="h-0.5 w-4 rounded bg-red-400" /></KeySwatch>
        <KeySwatch label="Shading = side with more new money">
          <span className="h-2.5 w-4 rounded-sm bg-emerald-400/30" /><span className="h-2.5 w-4 rounded-sm bg-red-400/30" />
        </KeySwatch>
        <KeySwatch label={showBand ? `Dashed = normal range for this time (${Math.min(data.historyDays, 14)} days)` : `Normal range appears after 5 days of data (have ${data.historyDays})`}>
          <span className="w-4 border-t border-dashed border-zinc-400" />
        </KeySwatch>
        {gaps.length > 0 && <KeySwatch label="Grey = no data (collector not running)"><span className="h-2.5 w-4 rounded-sm bg-zinc-500/20" /></KeySwatch>}
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">
        Higher = that side&apos;s trading is opening or closing positions (conviction); lower = contracts changing hands between
        existing holders (churn). Which way the money went, and at which strikes, is in the board above: filled bars building,
        outline bars leaving.
      </p>
    </div>
  );
}
