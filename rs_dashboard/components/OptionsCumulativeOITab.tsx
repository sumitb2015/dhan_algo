'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface TimePoint {
  time: string;
  ts:   number;   // epoch ms — numeric X axis
  spot: number;
  ceOI: number;
  peOI: number;
  diff: number;
  slope: number;
  accel: number;
  wpi: number;
}

type RegimeLabel = 'Bullish' | 'Weak Bullish' | 'Neutral' | 'Weak Bearish' | 'Bearish';

interface RegimeSnapshot {
  finalScore: number;
  oiScore: number;
  momentumScore: number;
  confirmScore: number;
  pBullish: number;
  label: RegimeLabel;
  strategy: string;
  tradable: boolean;
  transitionFlag: boolean;
  transitionDirection: 'bullish' | 'bearish' | null;
  warmingUp: boolean;
  sampleCount: number;
}

interface CumulativeResponse {
  success: boolean;
  date:    string;
  atm:     number;
  expiry:  string;
  wings:   number;
  data:    TimePoint[];
  regime?: RegimeSnapshot;
  error?:  string;
}

// ─── Helpers ──────────────────────────────────────────────────────

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtTick(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

function sessionBoundsIST(date: string): { start: number; end: number } {
  const start = new Date(`${date}T09:15:00+05:30`).getTime();
  const end   = new Date(`${date}T15:30:00+05:30`).getTime();
  return { start, end };
}

function regimeColor(label: RegimeLabel): string {
  switch (label) {
    case 'Bullish':      return 'text-emerald-400';
    case 'Weak Bullish':
    case 'Neutral':
    case 'Weak Bearish': return 'text-yellow-400';
    case 'Bearish':      return 'text-red-400';
  }
}

function regimeBarColor(label: RegimeLabel): string {
  switch (label) {
    case 'Bullish':      return 'bg-emerald-400';
    case 'Weak Bullish':
    case 'Neutral':
    case 'Weak Bearish': return 'bg-yellow-400';
    case 'Bearish':      return 'bg-red-400';
  }
}

// ─── Tooltips ─────────────────────────────────────────────────────

const OITooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const ceOI = (payload as Array<{ name: string; value: number }>).find(p => p.name === 'CE OI')?.value ?? 0;
  const peOI = (payload as Array<{ name: string; value: number }>).find(p => p.name === 'PE OI')?.value ?? 0;
  const pcr  = ceOI > 0 ? (peOI / ceOI).toFixed(2) : '—';
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[200px]">
      <p className="text-zinc-300 font-bold mb-2">{typeof label === 'number' ? fmtTick(label) : String(label)}</p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-blue-400 font-semibold">CE OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOI(ceOI)}</span>
      </div>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-red-400 font-semibold">PE OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOI(peOI)}</span>
      </div>
      <div className="mt-2 pt-2 border-t border-zinc-800 flex justify-between gap-8">
        <span className="text-zinc-400">PCR</span>
        <span className="text-yellow-400 font-bold tabular-nums">{pcr}</span>
      </div>
    </div>
  );
};

const DiffTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const diff    = (payload as Array<{ value: number }>)[0]?.value ?? 0;
  const bullish = diff > 0;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[200px]">
      <p className="text-zinc-300 font-bold mb-2">{typeof label === 'number' ? fmtTick(label) : String(label)}</p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-zinc-400 font-semibold">PE − CE OI</span>
        <span className={`font-bold tabular-nums ${bullish ? 'text-emerald-400' : 'text-red-400'}`}>
          {diff >= 0 ? '+' : ''}{fmtOI(diff)}
        </span>
      </div>
      <div className="mt-1 text-[10px] font-semibold">
        <span className={bullish ? 'text-emerald-400' : 'text-red-400'}>
          {bullish ? 'PE dominant — Bullish bias' : 'CE dominant — Bearish bias'}
        </span>
      </div>
    </div>
  );
};

// ─── Stat chip ────────────────────────────────────────────────────

function StatChip({ label, value, sub, color = 'text-white' }: {
  label: string; value: string; sub?: string; color?: string;
}) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-400 mt-0.5">{sub}</span>}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsCumulativeOITab({ expiry: _expiry }: { expiry: string }) {
  const [response, setResponse]   = useState<CumulativeResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [wingCount, setWingCount] = useState(10);
  const pollRef    = useRef<NodeJS.Timeout | null>(null);
  // Ref keeps the interval from closing over a stale wingCount value
  const wingRef    = useRef(10);

  const fetchData = (wings = wingRef.current) => {
    fetch(`/api/options/iv-history?mode=cumulative&wings=${wings}`)
      .then(r => r.json())
      .then((j: CumulativeResponse) => {
        if (j.success) { setResponse(j); setError(''); }
        else           { setError(j.error ?? 'No data'); setResponse(null); }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  // Initial load + 30-second refresh; interval reads from wingRef (always current)
  useEffect(() => {
    setLoading(true);
    fetchData();
    pollRef.current = setInterval(() => fetchData(), 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when wing count changes; update ref so the interval picks it up
  const handleWingChange = (w: number) => {
    wingRef.current = w;
    setWingCount(w);
    fetchData(w);
  };

  const data   = response?.data   ?? [];
  const atm    = response?.atm    ?? 0;
  const date   = response?.date   ?? '';
  const regime = response?.regime ?? null;
  const last   = data.length > 0 ? data[data.length - 1] : null;
  const ceOI   = last?.ceOI ?? 0;
  const peOI   = last?.peOI ?? 0;
  const diff   = last?.diff  ?? 0;
  const spot   = last?.spot  ?? 0;
  const pcr    = ceOI > 0 ? peOI / ceOI : 0;

  const pcrColor  = pcr > 1.3 ? 'text-emerald-400' : pcr > 0 && pcr < 0.7 ? 'text-red-400' : 'text-yellow-400';
  const pcrLabel  = pcr > 1.3 ? 'Bullish' : pcr > 0 && pcr < 0.7 ? 'Bearish' : 'Neutral';
  const diffColor = diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-red-400' : 'text-zinc-400';
  const diffLabel = diff > 0 ? 'PE dominant' : diff < 0 ? 'CE dominant' : undefined;

  // X-axis spans full session (9:15–15:30) using the CSV date
  const { start: xStart, end: xEnd } = date
    ? sessionBoundsIST(date)
    : { start: Date.now() - 30 * 60_000, end: Date.now() };

  const sessionTicks = (() => {
    const interval = 30 * 60_000;
    const first    = Math.ceil(xStart / interval) * interval;
    const ticks: number[] = [];
    for (let t = first; t <= xEnd; t += interval) ticks.push(t);
    return ticks;
  })();

  const xAxisProps = {
    dataKey:           'ts' as const,
    type:              'number' as const,
    scale:             'time' as const,
    domain:            [xStart, xEnd] as [number, number],
    ticks:             sessionTicks,
    tickFormatter:     fmtTick,
    allowDataOverflow: false,
    tick:              { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine:          false,
    axisLine:          { stroke: '#27272a' },
  };
  const gridProps = { strokeDasharray: '4 4', stroke: '#27272a', vertical: false as const };

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading OI data…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <p className="text-sm text-zinc-400 font-medium text-center max-w-sm">
          {error.includes('No IV snapshot') || error.includes('No data')
            ? 'No OI snapshot data for today — start iv_snapshot_collector.py (auto-starts with the server)'
            : error}
        </p>
        <p className="text-xs text-zinc-600 font-mono">python scripts/tools/iv_snapshot_collector.py</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Status bar ──────────────────────────────────────────────── */}
      <div className="flex items-center gap-5 px-4 py-3 bg-zinc-900/80 rounded-xl border border-zinc-800 flex-wrap">
        <StatChip label="Spot"     value={spot > 0 ? spot.toLocaleString('en-IN') : '—'} />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="ATM"      value={atm  > 0 ? atm.toLocaleString('en-IN')  : '—'} />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Total CE OI" value={ceOI > 0 ? fmtOI(ceOI) : '—'} color="text-blue-400" />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Total PE OI" value={peOI > 0 ? fmtOI(peOI) : '—'} color="text-red-400" />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Chain PCR"
          value={pcr > 0 ? pcr.toFixed(2) : '—'}
          sub={pcr > 0 ? pcrLabel : undefined}
          color={pcrColor}
        />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="PE − CE"
          value={ceOI > 0 || peOI > 0 ? `${diff >= 0 ? '+' : ''}${fmtOI(diff)}` : '—'}
          sub={diffLabel}
          color={diffColor}
        />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Expiry" value={response?.expiry || '—'} />

        <div className="ml-auto flex items-center gap-3 flex-wrap">
          {regime?.transitionFlag && (
            <span className={`text-[10px] font-bold px-2.5 py-1 rounded-full tracking-widest uppercase border ${
              regime.transitionDirection === 'bullish'
                ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30'
                : 'text-red-400 bg-red-500/10 border-red-500/30'
            }`}>
              ⇄ Regime shift: {regime.transitionDirection === 'bullish' ? 'turning bullish' : 'turning bearish'}
            </span>
          )}
          {date && (
            <span className="text-[10px] font-bold text-zinc-400 bg-zinc-800/80 border border-zinc-700 px-2.5 py-1 rounded-full tracking-widest uppercase">
              DATA: {date}
            </span>
          )}
          {data.length > 0 && (
            <span className="text-[10px] text-zinc-400 tabular-nums">
              {data.length} pt{data.length !== 1 ? 's' : ''} · refreshes every 30s
            </span>
          )}

          {/* Wing count */}
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest whitespace-nowrap">
              Strikes ±
            </span>
            <input
              type="number"
              min={3}
              max={10}
              value={wingCount}
              onChange={e => handleWingChange(Math.max(3, Math.min(10, Number(e.target.value))))}
              className="w-12 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2 py-1 text-center focus:outline-none focus:border-blue-500"
            />
          </div>

          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            CSV
          </span>
        </div>
      </div>

      {data.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
          Accumulating data — first point appears within 30s of collector start…
        </div>
      ) : (
        <>
        {/* ── Options Regime Score ────────────────────────────────────── */}
        {regime && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            {regime.warmingUp ? (
              <div className="flex items-center gap-3 py-2">
                <div className="w-4 h-4 border-2 border-zinc-700 border-t-zinc-500 rounded-full animate-spin" />
                <p className="text-sm text-zinc-500 font-medium">
                  Building history — regime score available after ~5 min of data
                  ({regime.sampleCount}/10 samples)
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <p className="text-sm font-bold text-white tracking-tight">Options Regime Score</p>
                    <p className="text-[10px] text-zinc-400 mt-0.5">
                      0.4×OI Pressure + 0.3×Momentum + 0.3×Confirmation · thresholds: &gt;+1 Bullish, &lt;-1 Bearish, |x|&lt;0.5 Neutral
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`text-lg font-bold tabular-nums ${regimeColor(regime.label)}`}>
                      {regime.label}
                    </span>
                    <span className="text-xs text-zinc-400 tabular-nums">
                      Score {regime.finalScore >= 0 ? '+' : ''}{regime.finalScore.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="w-full h-2.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${regimeBarColor(regime.label)} transition-all duration-500`}
                    style={{ width: `${Math.round(regime.pBullish * 100)}%` }}
                  />
                </div>

                <div className="flex items-center gap-5 flex-wrap">
                  <StatChip label="Layer 1 · OI Pressure" value={`${regime.oiScore >= 0 ? '+' : ''}${regime.oiScore.toFixed(2)}`} />
                  <StatChip label="Layer 2 · Momentum" value={`${regime.momentumScore >= 0 ? '+' : ''}${regime.momentumScore.toFixed(2)}`} />
                  <StatChip label="Layer 3 · Confirmation" value={`${regime.confirmScore >= 0 ? '+' : ''}${regime.confirmScore.toFixed(2)}`} />
                </div>

                <div className="flex items-center justify-between flex-wrap gap-2">
                  <p className="text-xs text-zinc-300">
                    {regime.tradable ? 'Suggested' : 'Weak/uncertain — spec says ignore for trading'} (informational):{' '}
                    <span className="font-semibold text-zinc-100">{regime.strategy}</span>
                  </p>
                  <p className="text-[10px] text-zinc-500">Informational only — not a trade signal</p>
                </div>

                <p className="text-[10px] text-zinc-600 border-t border-zinc-800 pt-2">
                  Weights (0.4/0.3/0.3) are the spec's untuned defaults, not backtested. Optimize for expected value
                  (P(win)×avgWin − P(loss)×avgLoss), not win rate, before sizing trades off this score.
                </p>
              </div>
            )}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

          {/* ── Chart 1: CE OI vs PE OI ──────────────────────────────── */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-bold text-white tracking-tight">Cumulative OI — CE vs PE</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">
                  Sum of CE OI &amp; PE OI across ATM ±{wingCount} strikes · NIFTY {response?.expiry || '—'}
                </p>
              </div>
              <div className="flex items-center gap-3 text-[10px] font-semibold">
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-blue-400" />
                  <span className="text-zinc-300">CE OI</span>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="w-3 h-3 rounded-sm bg-red-400" />
                  <span className="text-zinc-300">PE OI</span>
                </span>
              </div>
            </div>

            <ResponsiveContainer width="100%" height={380}>
              <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="cumGradCE" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#60a5fa" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#60a5fa" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="cumGradPE" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#f87171" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#f87171" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis
                  tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                  tickLine={false}
                  axisLine={false}
                  domain={['auto', 'auto']}
                  width={58}
                  tickFormatter={fmtOI}
                />
                <Tooltip content={<OITooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1 }} />
                <Legend
                  wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                  formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
                />
                <Area type="monotone" dataKey="ceOI" name="CE OI" stroke="#60a5fa" strokeWidth={2}
                  fill="url(#cumGradCE)" dot={false} activeDot={{ r: 4, fill: '#60a5fa', strokeWidth: 0 }} />
                <Area type="monotone" dataKey="peOI" name="PE OI" stroke="#f87171" strokeWidth={2}
                  fill="url(#cumGradPE)" dot={false} activeDot={{ r: 4, fill: '#f87171', strokeWidth: 0 }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          {/* ── Chart 2: PE OI − CE OI divergence ───────────────────── */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col">
            <div className="flex items-center justify-between mb-4">
              <div>
                <p className="text-sm font-bold text-white tracking-tight">OI Divergence — PE minus CE</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">
                  Positive = PE dominant (bullish bias) · Negative = CE dominant (bearish bias)
                </p>
              </div>
              <div className="flex items-center gap-2 text-[10px] font-semibold">
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500" />
                  <span className="text-zinc-300">PE &gt; CE</span>
                </span>
                <span className="flex items-center gap-1">
                  <span className="w-2.5 h-2.5 rounded-sm bg-red-500" />
                  <span className="text-zinc-300">CE &gt; PE</span>
                </span>
              </div>
            </div>

            <ResponsiveContainer width="100%" height={380}>
              <AreaChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="cumGradDiffPos" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="cumGradDiffNeg" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%"  stopColor="#ef4444" stopOpacity={0.02} />
                    <stop offset="95%" stopColor="#ef4444" stopOpacity={0.3} />
                  </linearGradient>
                </defs>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis
                  tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                  tickLine={false}
                  axisLine={false}
                  domain={['auto', 'auto']}
                  width={58}
                  tickFormatter={v => (v >= 0 ? '+' : '') + fmtOI(v)}
                />
                <Tooltip content={<DiffTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1 }} />
                <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                <Area type="monotone" dataKey="diff" name="PE − CE OI"
                  stroke={diff >= 0 ? '#10b981' : '#ef4444'}
                  strokeWidth={2}
                  fill={diff >= 0 ? 'url(#cumGradDiffPos)' : 'url(#cumGradDiffNeg)'}
                  dot={false}
                  activeDot={{ r: 4, fill: diff >= 0 ? '#10b981' : '#ef4444', strokeWidth: 0 }}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

        </div>

        {/* ── Chart 3: Writing Pressure Index & Divergence Slope ──────── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-bold text-white tracking-tight">Writing Pressure &amp; Divergence Slope</p>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                WPI positive = put writing / call buying dominant (bullish) · Slope = momentum of OI divergence
              </p>
            </div>
            <div className="flex items-center gap-3 text-[10px] font-semibold">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-purple-400" />
                <span className="text-zinc-300">WPI</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-amber-400" />
                <span className="text-zinc-300">Slope</span>
              </span>
            </div>
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis {...xAxisProps} />
              <YAxis
                tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={false}
                domain={['auto', 'auto']}
                width={48}
                tickFormatter={v => v.toFixed(2)}
              />
              <Tooltip
                contentStyle={{ background: '#09090b', border: '1px solid #3f3f46', borderRadius: 12, fontSize: 11 }}
                labelFormatter={v => (typeof v === 'number' ? fmtTick(v) : String(v))}
                formatter={(v, name) => [typeof v === 'number' ? v.toFixed(3) : String(v), String(name)]}
              />
              <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
              />
              <Line type="monotone" dataKey="wpi" name="WPI" stroke="#c084fc" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              <Line type="monotone" dataKey="slope" name="Slope" stroke="#fbbf24" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        </>
      )}
    </div>
  );
}
