'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Legend, LineChart, Line,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface TimePoint {
  time: string;
  ts:   number;   // epoch ms — numeric X axis
  spot: number;
  ceOI: number;
  peOI: number;
  diff: number;
}

interface CumulativeResponse {
  success: boolean;
  date:    string;
  atm:     number;
  expiry:  string;
  wings:   number;
  data:    TimePoint[];
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
  // MCX session is 09:00 to 23:30 IST
  const start = new Date(`${date}T09:00:00+05:30`).getTime();
  const end   = new Date(`${date}T23:30:00+05:30`).getTime();
  return { start, end };
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

function MiniStat({ label, value, sub, color = 'text-zinc-100' }: { label: string; value: string; sub?: React.ReactNode; color?: string }) {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest">{label}</span>
      <span className={`text-sm font-bold tabular-nums ${color}`}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-500 mt-0.5">{sub}</span>}
    </div>
  );
}

// ─── Main ─────────────────────────────────────────────────────────

export default function CrudeOilCumulativeOITab({ expiry: _expiry }: { expiry: string }) {
  const [response, setResponse]   = useState<CumulativeResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [error, setError]         = useState('');
  const [wingCount, setWingCount] = useState(6);
  const pollRef    = useRef<NodeJS.Timeout | null>(null);
  const wingRef    = useRef(6);

  const fetchData = (wings = wingRef.current) => {
    fetch(`/api/options/iv-history?underlying=CRUDEOIL&mode=cumulative&wings=${wings}`)
      .then(r => r.json())
      .then((j: CumulativeResponse) => {
        if (j.success) { setResponse(j); setError(''); }
        else           { setError(j.error ?? 'No data collected yet today'); setResponse(null); }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  // Initial load + 30-second refresh
  useEffect(() => {
    setLoading(true);
    fetchData();
    pollRef.current = setInterval(() => fetchData(), 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleWingChange = (w: number) => {
    wingRef.current = w;
    setWingCount(w);
    fetchData(w);
  };

  const data   = response?.data   ?? [];
  const atm    = response?.atm    ?? 0;
  const date   = response?.date   ?? '';
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

  // X-axis spans MCX session (09:00–23:30)
  const { start: xStart, end: xEnd } = date
    ? sessionBoundsIST(date)
    : { start: Date.now() - 30 * 60_000, end: Date.now() };

  if (loading && !data.length) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading cumulative open interest…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Top Bar controls */}
      <div className="flex items-center justify-between border border-zinc-800 bg-zinc-900/40 rounded-xl px-4 py-3 gap-4 flex-wrap">
        <div className="flex items-center gap-8 flex-wrap">
          <MiniStat
            label="Crude Spot (Fut)"
            value={spot > 0 ? `₹${spot.toLocaleString('en-IN')}` : '—'}
          />
          <MiniStat
            label="ATM (Locked)"
            value={atm > 0 ? `₹${atm.toLocaleString('en-IN')}` : '—'}
            sub={date ? `Locked date: ${date}` : undefined}
          />
          <MiniStat
            label="Cumulative PCR"
            value={pcr > 0 ? pcr.toFixed(3) : '—'}
            color={pcrColor}
            sub={pcr > 0 ? pcrLabel : undefined}
          />
          <MiniStat
            label="OI Difference (P − C)"
            value={diff !== 0 ? fmtOI(diff) : '—'}
            color={diffColor}
            sub={diffLabel}
          />
        </div>

        {/* Strike range wing selector */}
        <div className="flex items-center gap-3 ml-auto text-xs shrink-0 pl-4 border-l border-zinc-850">
          <span className="font-bold text-zinc-400 uppercase tracking-widest">Range</span>
          <div className="flex items-center gap-1 border border-zinc-800 bg-zinc-950 p-0.5 rounded-lg">
            {([1, 2, 3, 4, 5, 6] as const).map(w => (
              <button
                key={w}
                onClick={() => handleWingChange(w)}
                className={`px-2 py-1 rounded font-semibold transition-all ${
                  wingCount === w
                    ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                ±{w}
              </button>
            ))}
          </div>
          <span className="text-[10px] text-zinc-500 font-semibold">(strike step 100)</span>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-900/15 border border-red-700/30 rounded-xl text-xs font-medium text-red-400">
          {error}
          <div className="text-[10px] text-red-400/70 mt-1 font-normal">
            Note: The background script `scripts/tools/crudeoil_oi_collector.py` must be running to record this data.
          </div>
        </div>
      )}

      {data.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* Cumulative Area Chart */}
          <div className="border border-zinc-800 bg-zinc-950 rounded-xl p-4 flex flex-col gap-3 min-h-[420px]">
            <div>
              <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-widest">Cumulative Open Interest</h3>
              <p className="text-[10px] text-zinc-500 mt-0.5">Sum of CE vs PE contracts within ATM ± {wingCount} strikes</p>
            </div>

            <div className="flex-1 w-full min-h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data} margin={{ top: 10, right: 5, left: -25, bottom: 5 }}>
                  <defs>
                    <linearGradient id="ceGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.15}/>
                      <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.01}/>
                    </linearGradient>
                    <linearGradient id="peGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%" stopColor="#ef4444" stopOpacity={0.15}/>
                      <stop offset="95%" stopColor="#ef4444" stopOpacity={0.01}/>
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="4 4" stroke="#27272a" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={[xStart, xEnd]}
                    tickFormatter={fmtTick}
                    tick={{ fontSize: 9, fill: '#a1a1aa' }}
                    tickLine={false}
                    axisLine={{ stroke: '#27272a' }}
                  />
                  <YAxis
                    tickFormatter={fmtOI}
                    tick={{ fontSize: 9, fill: '#a1a1aa' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip content={<OITooltip />} />
                  <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10 }} />
                  <Area
                    type="monotone"
                    dataKey="ceOI"
                    name="CE OI"
                    stroke="#3b82f6"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#ceGrad)"
                  />
                  <Area
                    type="monotone"
                    dataKey="peOI"
                    name="PE OI"
                    stroke="#ef4444"
                    strokeWidth={2}
                    fillOpacity={1}
                    fill="url(#peGrad)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          {/* Difference Line Chart */}
          <div className="border border-zinc-800 bg-zinc-950 rounded-xl p-4 flex flex-col gap-3 min-h-[420px]">
            <div>
              <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-widest">OI Difference (PE − CE)</h3>
              <p className="text-[10px] text-zinc-500 mt-0.5">Bullish/Bearish bias indicator over the session</p>
            </div>

            <div className="flex-1 w-full min-h-[320px]">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={data} margin={{ top: 10, right: 5, left: -25, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="4 4" stroke="#27272a" vertical={false} />
                  <XAxis
                    dataKey="ts"
                    type="number"
                    domain={[xStart, xEnd]}
                    tickFormatter={fmtTick}
                    tick={{ fontSize: 9, fill: '#a1a1aa' }}
                    tickLine={false}
                    axisLine={{ stroke: '#27272a' }}
                  />
                  <YAxis
                    tickFormatter={fmtOI}
                    tick={{ fontSize: 9, fill: '#a1a1aa' }}
                    tickLine={false}
                    axisLine={false}
                  />
                  <Tooltip content={<DiffTooltip />} />
                  <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10 }} />
                  <ReferenceLine y={0} stroke="#3f3f46" strokeWidth={1.5} />
                  <Line
                    type="monotone"
                    dataKey="diff"
                    name="PE − CE Diff"
                    stroke="#eab308"
                    strokeWidth={2.5}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
