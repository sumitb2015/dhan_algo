'use client';

import { useState, useEffect, useMemo } from 'react';
import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Legend,
} from 'recharts';
import { TrendingUp } from 'lucide-react';
import NavBar from '@/components/NavBar';
import type { WeeklyBucket } from '@/app/api/expiry-analysis/route';

interface ClassifiedBucket extends WeeklyBucket {
  tueTimestamp: number;
  status: 'within' | 'upside' | 'downside';
}

interface ScatterPoint {
  x: number;
  y: number;
  wedDate: string;
  tueDate: string;
  returnPct: number;
  status: 'within' | 'upside' | 'downside';
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

function isoYearsAgo(n: number): string {
  const d = new Date();
  d.setFullYear(d.getFullYear() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Returns symmetric two-tailed percentile boundaries.
 * probability = 0.95 → lower = 2.5th pct, upper = 97.5th pct.
 */
function computeBoundaries(
  returnPcts: number[],
  probability: number,
): { lower: number; upper: number } {
  if (returnPcts.length === 0) return { lower: 0, upper: 0 };
  const sorted = [...returnPcts].sort((a, b) => a - b);
  const n = sorted.length;
  if (n < 4) return { lower: sorted[0], upper: sorted[n - 1] };
  const tail = (1 - probability) / 2;
  const lowerIdx = Math.max(0, Math.floor(tail * n));
  const upperIdx = Math.min(n - 1, n - 1 - lowerIdx);
  return { lower: sorted[lowerIdx], upper: sorted[upperIdx] };
}

function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d} ${months[parseInt(m, 10) - 1]} ${y}`;
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

function CustomTooltip({ active, payload }: { active?: boolean; payload?: { payload: ScatterPoint }[] }) {
  if (!active || !payload?.[0]) return null;
  const d = payload[0].payload;
  const color =
    d.status === 'upside' ? '#34d399' : d.status === 'downside' ? '#f87171' : '#71717a';
  const signChar = d.returnPct >= 0 ? '+' : '';
  const label =
    d.status === 'within' ? 'Within boundary' : d.status + ' outlier';
  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg px-3 py-2 text-xs shadow-xl">
      <div className="text-zinc-400 mb-1">
        {fmtDate(d.wedDate)} → {fmtDate(d.tueDate)}
      </div>
      <div style={{ color }} className="font-mono font-bold text-sm">
        {signChar}{d.returnPct.toFixed(2)}%
      </div>
      <div className="text-zinc-500 capitalize mt-0.5">{label}</div>
    </div>
  );
}

// ─── Dot shapes ───────────────────────────────────────────────────────────────

function SmallDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={3} fill="#52525b" opacity={0.65} />;
}
function GreenDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={5} fill="#34d399" />;
}
function RedDot(props: { cx?: number; cy?: number }) {
  return <circle cx={props.cx} cy={props.cy} r={5} fill="#f87171" />;
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function ExpiryAnalysis() {
  const [weeks, setWeeks] = useState<WeeklyBucket[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dataEnd, setDataEnd] = useState('');

  const [startDate, setStartDate] = useState(isoYearsAgo(5));
  const [endDate, setEndDate] = useState(isoToday);

  // probability as integer 70–99 (represents %)
  const [probability, setProbability] = useState(95);

  // Fetch whenever date range changes
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetch(`/api/expiry-analysis?startDate=${startDate}&endDate=${endDate}`, {
      signal: controller.signal,
    })
      .then((r) => r.json())
      .then((data) => {
        if (data.error) throw new Error(data.error);
        setWeeks(data.weeks ?? []);
        setDataEnd(data.dataEnd ?? '');
      })
      .catch((e: Error) => {
        if (e.name !== 'AbortError') setError(e.message);
      })
      .finally(() => setLoading(false));
    return () => controller.abort();
  }, [startDate, endDate]);

  // Re-classify whenever weeks or probability changes (no API call)
  const { lower, upper, withinData, upsideData, downsideData, outliers } = useMemo(() => {
    const { lower, upper } = computeBoundaries(
      weeks.map((w) => w.returnPct),
      probability / 100,
    );

    const classified: ClassifiedBucket[] = weeks.map((w) => ({
      ...w,
      tueTimestamp: new Date(w.tueDate + 'T00:00:00Z').getTime(),
      status:
        w.returnPct < lower ? 'downside' : w.returnPct > upper ? 'upside' : 'within',
    }));

    const toPoint = (c: ClassifiedBucket): ScatterPoint => ({
      x: c.tueTimestamp,
      y: c.returnPct,
      wedDate: c.wedDate,
      tueDate: c.tueDate,
      returnPct: c.returnPct,
      status: c.status,
    });

    const withinData  = classified.filter((c) => c.status === 'within').map(toPoint);
    const upsideData  = classified.filter((c) => c.status === 'upside').map(toPoint);
    const downsideData = classified.filter((c) => c.status === 'downside').map(toPoint);
    const outliers = classified
      .filter((c) => c.status !== 'within')
      .sort((a, b) => Math.abs(b.returnPct) - Math.abs(a.returnPct));

    return { lower, upper, withinData, upsideData, downsideData, outliers };
  }, [weeks, probability]);

  // Stats
  const totalExpiries = weeks.length;
  const totalOutliers = outliers.length;
  const outlierPct =
    totalExpiries > 0 ? ((totalOutliers / totalExpiries) * 100).toFixed(1) : '0.0';

  // X-axis tick: show year only
  const xTickFormatter = (ts: number) =>
    new Date(ts).getUTCFullYear().toString();

  const sign = (n: number) => (n >= 0 ? '+' : '');

  return (
    <div className="min-h-screen bg-black text-white">
      {/* ── Sticky header ── */}
      <header className="sticky top-0 z-30 bg-zinc-950/90 backdrop-blur-md border-b border-zinc-800 px-4 py-2 flex items-center gap-3">
        <TrendingUp className="text-emerald-400 w-5 h-5 flex-shrink-0" />
        <div className="flex-shrink-0">
          <h1 className="text-sm font-bold text-white leading-tight">Expiry Analysis</h1>
          <p className="text-xs text-zinc-500 leading-tight">Weekly OC Return Distribution</p>
        </div>
        <div className="flex-1 min-w-0">
          <NavBar />
        </div>
        {dataEnd && (
          <span className="flex-shrink-0 text-xs text-zinc-500 font-mono border border-zinc-800 rounded px-2 py-0.5 whitespace-nowrap">
            DATA: {dataEnd}
          </span>
        )}
      </header>

      <main className="p-4 space-y-4 max-w-[1600px] mx-auto">
        {/* ── Controls ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 whitespace-nowrap">Start Date</label>
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <label className="text-xs text-zinc-400 whitespace-nowrap">End Date</label>
              <input
                type="date"
                value={endDate}
                min={startDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-white font-mono focus:outline-none focus:border-emerald-500"
              />
            </div>
            <div className="flex items-center gap-3 flex-1 min-w-[300px]">
              <label className="text-xs text-zinc-400 whitespace-nowrap">
                Probability Boundary (%)
              </label>
              <input
                type="range"
                min={70}
                max={99}
                step={1}
                value={probability}
                onChange={(e) => setProbability(Number(e.target.value))}
                className="flex-1 accent-emerald-500"
              />
              <span className="text-xs font-mono text-emerald-400 whitespace-nowrap min-w-[220px]">
                {probability}% → lower: {lower.toFixed(2)}% / upper: {sign(upper)}{upper.toFixed(2)}%
              </span>
            </div>
          </div>
          <p className="text-xs text-zinc-600 mt-2">
            Current Return Column: <span className="text-zinc-500">Weekly Return %</span>
            &nbsp;| Total Records: {totalExpiries} expiries.
            Based on the selected {probability}% coverage, the lower boundary is the{' '}
            {(((1 - probability / 100) / 2) * 100).toFixed(1)}th percentile and the upper boundary
            is the {((1 - (1 - probability / 100) / 2) * 100).toFixed(1)}th percentile.
          </p>
        </div>

        {/* ── Scatter chart ── */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4">
          <div className="mb-4">
            <h2 className="text-sm font-bold text-white flex items-center gap-2">
              ✈ Outliers Distribution (Survivability Scatter Plot)
            </h2>
            <p className="text-xs text-zinc-500 mt-1 leading-relaxed">
              Dots inside the horizontal dashed lines represent within-boundary expiries.
              Dots outside represent extreme outliers (red/green). This scatter map, inspired by
              Abraham Wald&apos;s aircraft survivability analysis, highlights where the market was
              hit by extreme moves.
            </p>
          </div>

          {loading ? (
            <div className="h-[420px] flex items-center justify-center text-zinc-500 text-sm">
              Loading weekly data…
            </div>
          ) : error ? (
            <div className="h-[420px] flex items-center justify-center text-red-400 text-sm">
              Error: {error}
            </div>
          ) : weeks.length === 0 ? (
            <div className="h-[420px] flex items-center justify-center text-zinc-500 text-sm">
              No data for the selected date range.
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={420}>
              <ScatterChart margin={{ top: 16, right: 80, bottom: 24, left: 8 }}>
                <CartesianGrid stroke="#27272a" strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="x"
                  type="number"
                  domain={['auto', 'auto']}
                  scale="time"
                  tickFormatter={xTickFormatter}
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  label={{
                    value: 'Expiry End Date',
                    position: 'insideBottom',
                    offset: -12,
                    fontSize: 10,
                    fill: '#52525b',
                  }}
                />
                <YAxis
                  dataKey="y"
                  type="number"
                  tick={{ fontSize: 10, fill: '#71717a' }}
                  axisLine={false}
                  tickLine={false}
                  tickFormatter={(v: number) => `${v}%`}
                  width={52}
                  label={{
                    value: 'Return (%)',
                    angle: -90,
                    position: 'insideLeft',
                    offset: 8,
                    fontSize: 10,
                    fill: '#52525b',
                  }}
                />
                <Tooltip content={<CustomTooltip />} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  formatter={(value) => (
                    <span style={{ color: '#a1a1aa' }}>{value}</span>
                  )}
                />
                <ReferenceLine
                  y={upper}
                  stroke="#34d399"
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  label={{
                    value: `Upper Boundary (${sign(upper)}${upper.toFixed(2)}%)`,
                    position: 'right',
                    fontSize: 9,
                    fill: '#34d399',
                  }}
                />
                <ReferenceLine
                  y={lower}
                  stroke="#f87171"
                  strokeDasharray="6 3"
                  strokeWidth={1.5}
                  label={{
                    value: `Lower Boundary (${sign(lower)}${lower.toFixed(2)}%)`,
                    position: 'right',
                    fontSize: 9,
                    fill: '#f87171',
                  }}
                />
                <Scatter
                  name="Within Boundary"
                  data={withinData}
                  isAnimationActive={false}
                  shape={<SmallDot />}
                />
                <Scatter
                  name="Upside Outlier"
                  data={upsideData}
                  isAnimationActive={false}
                  shape={<GreenDot />}
                />
                <Scatter
                  name="Downside Outlier"
                  data={downsideData}
                  isAnimationActive={false}
                  shape={<RedDot />}
                />
              </ScatterChart>
            </ResponsiveContainer>
          )}
        </div>

        {/* ── Stats row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: 'Total Expiries', value: String(totalExpiries), colorClass: 'text-white' },
            { label: 'Total Outliers', value: `${totalOutliers} (${outlierPct}%)`, colorClass: 'text-amber-400' },
            { label: 'Downside Outliers 🔴', value: String(downsideData.length), colorClass: 'text-red-400' },
            { label: 'Upside Outliers 🟢', value: String(upsideData.length), colorClass: 'text-emerald-400' },
          ].map((stat) => (
            <div
              key={stat.label}
              className="bg-zinc-900 border border-zinc-800 rounded-xl p-4"
            >
              <div className="text-xs text-zinc-500 mb-2">{stat.label}</div>
              <div className={`text-3xl font-bold font-mono ${stat.colorClass}`}>
                {stat.value}
              </div>
            </div>
          ))}
        </div>

        {/* ── Outlier table ── */}
        {outliers.length > 0 && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <h2 className="text-sm font-bold text-white">Outlier Expiries Table</h2>
              <p className="text-xs text-zinc-500 mt-0.5">
                All weekly expiries that fell outside the specified boundaries, sorted by absolute
                return size.
              </p>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      Start Date (Wed)
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      End Date (Tue)
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-right">
                      Weekly Return %
                    </th>
                    <th className="text-xs font-bold text-white bg-zinc-800 px-4 py-2.5 text-left">
                      Status
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {outliers.map((w, i) => {
                    const isUp = w.status === 'upside';
                    return (
                      <tr
                        key={w.tueDate}
                        className={i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-950'}
                      >
                        <td className="px-4 py-2 font-mono text-zinc-300">{fmtDate(w.wedDate)}</td>
                        <td className="px-4 py-2 font-mono text-zinc-300">{fmtDate(w.tueDate)}</td>
                        <td
                          className={`px-4 py-2 font-mono font-bold text-right ${
                            isUp ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {sign(w.returnPct)}{w.returnPct.toFixed(2)}%
                        </td>
                        <td className="px-4 py-2">
                          <span
                            className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs border ${
                              isUp
                                ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/30'
                                : 'bg-red-500/10 text-red-400 border-red-500/30'
                            }`}
                          >
                            {isUp ? 'Upside Outlier' : 'Downside Outlier'}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
