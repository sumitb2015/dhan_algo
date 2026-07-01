'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface OcSide { oi?: number }
interface OcEntry { ce?: OcSide; pe?: OcSide }

interface TimePoint {
  ts: number;   // epoch ms — used as numeric X axis value
  time: string; // display label
  ceOI: number;
  peOI: number;
  diff: number; // PE OI − CE OI
}

// Session end: 3:30 PM IST today
function sessionEnd(): number {
  const end = new Date();
  end.setHours(15, 30, 0, 0);
  return end.getTime();
}

function fmtTick(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;

const POLL_OPTIONS = [
  { label: '10s', ms: 10_000  },
  { label: '20s', ms: 20_000  },
  { label: '30s', ms: 30_000  },
  { label: '1m',  ms: 60_000  },
  { label: '2m',  ms: 120_000 },
] as const;

type PollMs = typeof POLL_OPTIONS[number]['ms'];

// ─── Helpers ──────────────────────────────────────────────────────

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function nowHMS(): { ts: number; time: string } {
  const d = new Date();
  return {
    ts:   d.getTime(),
    time: d.toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit', timeZone: 'Asia/Kolkata',
    }),
  };
}

// ─── Tooltips ─────────────────────────────────────────────────────

const OITooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const ceOI = (payload as Array<{ name: string; value: number }>).find(p => p.name === 'CE OI')?.value ?? 0;
  const peOI = (payload as Array<{ name: string; value: number }>).find(p => p.name === 'PE OI')?.value ?? 0;
  const pcr  = ceOI > 0 ? (peOI / ceOI).toFixed(2) : '—';
  const timeLabel = typeof label === 'number' ? fmtTick(label) : String(label);
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[200px]">
      <p className="text-zinc-300 font-bold mb-2">{timeLabel}</p>
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
  const diff = (payload as Array<{ value: number }>)[0]?.value ?? 0;
  const bullish = diff > 0;
  const timeLabel = typeof label === 'number' ? fmtTick(label) : String(label);
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[200px]">
      <p className="text-zinc-300 font-bold mb-2">{timeLabel}</p>
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

export default function OptionsCumulativeOITab({ expiry }: { expiry: string }) {
  const [series, setSeries]           = useState<TimePoint[]>([]);
  const [spot, setSpot]               = useState(0);
  const [atm, setAtm]                 = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [pollMs, setPollMs]           = useState<PollMs>(60_000);
  const [wingCount, setWingCount]     = useState(10);

  const intervalRef  = useRef<NodeJS.Timeout | null>(null);
  // Locked to mount time so the chart always starts from when the user opened this tab
  const pageOpenTs   = useRef<number>(Date.now());

  const fetchAndAppend = useCallback(async () => {
    if (!expiry) return;
    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, OcEntry> }; spot: number };
        error?: string;
      };

      if (!json.success || !json.data?.chain?.oc) {
        setError(json.error ?? 'No chain data');
        return;
      }

      const spotPrice = json.data.spot ?? 0;
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;
      const oc        = json.data.chain.oc;

      let ceOI = 0;
      let peOI = 0;

      Object.entries(oc).forEach(([k, v]) => {
        const strike = Number(k);
        if (isNaN(strike)) return;
        if (Math.abs(strike - atmStrike) > wingCount * STRIKE_STEP) return;
        ceOI += v.ce?.oi ?? 0;
        peOI += v.pe?.oi ?? 0;
      });

      const { ts, time } = nowHMS();
      setSeries(prev => {
        const last = prev[prev.length - 1];
        if (last && last.ceOI === ceOI && last.peOI === peOI) return prev;
        return [...prev, { ts, time, ceOI, peOI, diff: peOI - ceOI }];
      });
      setSpot(spotPrice);
      setAtm(atmStrike);
      setLastUpdated(time);
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry, wingCount]);

  // Reset series on expiry change; restart polling on expiry, poll rate, or wing count change
  useEffect(() => {
    if (!expiry) return;
    setSeries([]);
    setSpot(0);
    setAtm(0);
    setLastUpdated(null);
    setLoading(true);
    void fetchAndAppend();
    if (intervalRef.current) clearInterval(intervalRef.current);
    intervalRef.current = setInterval(() => { void fetchAndAppend(); }, pollMs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [expiry, pollMs, wingCount, fetchAndAppend]);

  // ── Derived ───────────────────────────────────────────────────────
  const last     = series.length > 0 ? series[series.length - 1] : null;
  const ceOI     = last?.ceOI ?? 0;
  const peOI     = last?.peOI ?? 0;
  const diff     = last?.diff ?? 0;
  const pcr      = ceOI > 0 ? peOI / ceOI : 0;
  const pcrColor = pcr > 1.3 ? 'text-emerald-400' : pcr > 0 && pcr < 0.7 ? 'text-red-400' : 'text-yellow-400';
  const pcrLabel = pcr > 1.3 ? 'Bullish' : pcr > 0 && pcr < 0.7 ? 'Bearish' : 'Neutral';
  const diffColor= diff > 0 ? 'text-emerald-400' : diff < 0 ? 'text-red-400' : 'text-zinc-400';
  const diffLabel= diff > 0 ? 'PE dominant' : diff < 0 ? 'CE dominant' : undefined;

  const domainEnd    = sessionEnd();
  const xDomainStart = pageOpenTs.current;
  // Only show data from when the tab was opened
  const chartSeries  = series.filter(p => p.ts >= xDomainStart && p.ts <= domainEnd);
  // Ticks at round 30-min marks from the first mark after page open until 15:30
  const sessionTicks = (() => {
    const interval = 30 * 60_000;
    const first    = Math.ceil(xDomainStart / interval) * interval;
    const ticks: number[] = [];
    for (let t = first; t <= domainEnd; t += interval) ticks.push(t);
    return ticks;
  })();
  const xAxisProps = {
    dataKey:           'ts' as const,
    type:              'number' as const,
    scale:             'time' as const,
    domain:            [xDomainStart, domainEnd] as [number, number],
    ticks:             sessionTicks,
    tickFormatter:     fmtTick,
    allowDataOverflow: false,
    tick:              { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine:          false,
    axisLine:          { stroke: '#27272a' },
  };
  const gridProps = { strokeDasharray: '4 4', stroke: '#27272a', vertical: false as const };

  if (loading && !series.length) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading option chain…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* ── Status bar ────────────────────────────────────────────── */}
      <div className="flex items-center gap-5 px-4 py-3 bg-zinc-900/80 rounded-xl border border-zinc-800 flex-wrap">
        <StatChip label="Spot"     value={spot > 0 ? spot.toLocaleString('en-IN') : '—'} />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="ATM"      value={atm  > 0 ? atm.toLocaleString('en-IN')  : '—'} />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Total CE OI"
          value={ceOI > 0 ? fmtOI(ceOI) : '—'}
          color="text-blue-400" />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Total PE OI"
          value={peOI > 0 ? fmtOI(peOI) : '—'}
          color="text-red-400" />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip
          label="Chain PCR"
          value={pcr > 0 ? pcr.toFixed(2) : '—'}
          sub={pcr > 0 ? pcrLabel : undefined}
          color={pcrColor}
        />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip
          label="PE − CE"
          value={ceOI > 0 || peOI > 0 ? `${diff >= 0 ? '+' : ''}${fmtOI(diff)}` : '—'}
          sub={diffLabel}
          color={diffColor}
        />
        <div className="w-px h-6 bg-zinc-800" />
        <StatChip label="Expiry" value={expiry || '—'} />

        <div className="ml-auto flex items-center gap-3 flex-wrap">
          {lastUpdated && (
            <span className="text-[10px] text-zinc-400 tabular-nums">
              Updated {lastUpdated} · {series.length} pt{series.length !== 1 ? 's' : ''}
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
              max={20}
              value={wingCount}
              onChange={e => setWingCount(Math.max(3, Math.min(20, Number(e.target.value))))}
              className="w-12 bg-zinc-800 border border-zinc-700 text-zinc-200 text-xs font-semibold
                         rounded-lg px-2 py-1 text-center focus:outline-none focus:border-blue-500"
            />
          </div>

          {/* Poll interval */}
          <div className="flex items-center bg-zinc-800 border border-zinc-700 p-0.5 rounded-xl gap-0.5">
            {POLL_OPTIONS.map(({ label, ms }) => (
              <button
                key={ms}
                onClick={() => setPollMs(ms)}
                className={`px-2 py-1 text-[10px] font-bold rounded-lg transition-all ${
                  pollMs === ms
                    ? 'bg-blue-500/15 text-blue-400 border border-blue-500/25'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        </div>
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      {chartSeries.length === 0 ? (
        <div className="flex items-center justify-center py-24 text-zinc-500 text-sm">
          {!expiry
            ? 'Select an expiry to start tracking'
            : Date.now() > domainEnd
              ? 'Market closed — data available during 09:15 AM – 03:30 PM IST'
              : 'Accumulating data — first point appears shortly…'}
        </div>
      ) : (<>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">

        {/* ── Chart 1: CE OI vs PE OI time series ─────────────────── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-bold text-white tracking-tight">
                Cumulative OI — CE vs PE
              </p>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                Sum of CE OI &amp; PE OI across ATM ±{wingCount} strikes · NIFTY {expiry || '—'}
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
            <AreaChart data={chartSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
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
              <Area
                type="monotone"
                dataKey="ceOI"
                name="CE OI"
                stroke="#60a5fa"
                strokeWidth={2}
                fill="url(#cumGradCE)"
                dot={false}
                activeDot={{ r: 4, fill: '#60a5fa', strokeWidth: 0 }}
              />
              <Area
                type="monotone"
                dataKey="peOI"
                name="PE OI"
                stroke="#f87171"
                strokeWidth={2}
                fill="url(#cumGradPE)"
                dot={false}
                activeDot={{ r: 4, fill: '#f87171', strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* ── Chart 2: Difference (PE OI − CE OI) ─────────────────── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 flex flex-col">
          <div className="flex items-center justify-between mb-4">
            <div>
              <p className="text-sm font-bold text-white tracking-tight">
                OI Divergence — PE minus CE
              </p>
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
            <AreaChart data={chartSeries} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
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
              <Area
                type="monotone"
                dataKey="diff"
                name="PE − CE OI"
                stroke={diff >= 0 ? '#10b981' : '#ef4444'}
                strokeWidth={2}
                fill={diff >= 0 ? 'url(#cumGradDiffPos)' : 'url(#cumGradDiffNeg)'}
                dot={false}
                activeDot={{ r: 4, fill: diff >= 0 ? '#10b981' : '#ef4444', strokeWidth: 0 }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        </div>{/* end grid */}

      </>)}
    </div>
  );
}
