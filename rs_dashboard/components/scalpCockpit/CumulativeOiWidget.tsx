'use client';

import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import {
  AreaChart, Area, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts';
import { ShieldCheck, RefreshCw, BarChart2, Layers, ChevronDown } from 'lucide-react';
import CockpitSpinner from './CockpitSpinner';

interface TimePoint {
  time: string;
  ts: number;
  spot: number;
  ceOI: number;
  peOI: number;
  diff: number;
  oiZ: number;
  slopeZ: number;
  wpiZ: number;
  regimeLabel: 'Strong Bullish' | 'Bullish' | 'Neutral' | 'Bearish' | 'Strong Bearish';
  regimeConfirmed: boolean;
}

interface RegimeSnapshot {
  signal: number;
  label: 'Strong Bullish' | 'Bullish' | 'Neutral' | 'Bearish' | 'Strong Bearish';
  confidence: number;
  confidenceLabel: 'Low' | 'Moderate' | 'High';
  confirmed: boolean;
  reason: string;
  oiZone: 'Bullish' | 'Neutral' | 'Bearish';
  slopeZone: 'Bullish' | 'Neutral' | 'Bearish';
  wpiZone: 'Bullish' | 'Neutral' | 'Bearish';
}

interface CumulativeResponse {
  success: boolean;
  date: string;
  atm: number;
  expiry: string;
  wings: number;
  data: TimePoint[];
  regime?: RegimeSnapshot;
  error?: string;
}

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000) return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtTick(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-IN', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata',
  });
}

function regimeColor(label?: string): string {
  switch (label) {
    case 'Strong Bullish': return 'text-emerald-400';
    case 'Bullish': return 'text-emerald-300';
    case 'Neutral': return 'text-amber-400';
    case 'Bearish': return 'text-red-300';
    case 'Strong Bearish': return 'text-red-400';
    default: return 'text-zinc-400';
  }
}

function regimeBadgeClass(label?: string): string {
  switch (label) {
    case 'Strong Bullish': return 'bg-emerald-500/15 border-emerald-500/30 text-emerald-400';
    case 'Bullish': return 'bg-emerald-500/10 border-emerald-500/25 text-emerald-300';
    case 'Neutral': return 'bg-amber-500/15 border-amber-500/30 text-amber-400';
    case 'Bearish': return 'bg-red-500/10 border-red-500/25 text-red-300';
    case 'Strong Bearish': return 'bg-red-500/15 border-red-500/30 text-red-400';
    default: return 'bg-zinc-800 border-zinc-700 text-zinc-400';
  }
}

function regimeBarColor(label: string): string {
  switch (label) {
    case 'Strong Bullish':
    case 'Bullish': return 'bg-emerald-400';
    case 'Neutral': return 'bg-amber-400';
    case 'Bearish':
    case 'Strong Bearish': return 'bg-red-400';
    default: return 'bg-zinc-600';
  }
}

const CompactOITooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const ceOI = (payload as Array<{ name: string; value: number }>).find(p => p.name === 'CE OI')?.value ?? 0;
  const peOI = (payload as Array<{ name: string; value: number }>).find(p => p.name === 'PE OI')?.value ?? 0;
  const spot = (payload as Array<{ name: string; value: number }>).find(p => p.name === 'Spot')?.value;
  const diff = peOI - ceOI;
  const pcr = ceOI > 0 ? (peOI / ceOI).toFixed(2) : '—';

  return (
    <div className="bg-zinc-950/95 border border-zinc-700/80 rounded-lg px-2.5 py-2 text-[11px] shadow-2xl backdrop-blur min-w-[150px] font-mono">
      <p className="text-zinc-400 font-bold mb-1">{typeof label === 'number' ? fmtTick(label) : String(label)}</p>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="text-blue-400 font-semibold">CE OI</span>
        <span className="text-zinc-100 font-bold tabular-nums">{fmtOI(ceOI)}</span>
      </div>
      <div className="flex justify-between gap-4 mb-0.5">
        <span className="text-rose-400 font-semibold">PE OI</span>
        <span className="text-zinc-100 font-bold tabular-nums">{fmtOI(peOI)}</span>
      </div>
      <div className="flex justify-between gap-4 mb-0.5 pt-1 border-t border-zinc-800">
        <span className="text-zinc-400 font-semibold">Diff (PE-CE)</span>
        <span className={`font-bold tabular-nums ${diff >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
          {diff >= 0 ? '+' : ''}{fmtOI(diff)}
        </span>
      </div>
      <div className="flex justify-between gap-4">
        <span className="text-zinc-400 font-semibold">PCR</span>
        <span className="text-zinc-200 font-bold tabular-nums">{pcr}</span>
      </div>
      {spot != null && spot > 0 && (
        <div className="flex justify-between gap-4 pt-0.5">
          <span className="text-amber-400 font-semibold">Spot</span>
          <span className="text-amber-300 font-bold tabular-nums">{spot.toFixed(2)}</span>
        </div>
      )}
    </div>
  );
};

export interface CumulativeOiWidgetProps {
  underlying: string;
  onSelectStrikeBand?: (wings: number) => void;
}

export default function CumulativeOiWidget({ underlying }: CumulativeOiWidgetProps) {
  const [data, setData] = useState<CumulativeResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wings, setWings] = useState(10);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const requestSeq = useRef(0);

  const fetchData = useCallback(async (wingVal = wings, silent = false) => {
    const seq = ++requestSeq.current;
    if (!silent) setLoading(true);
    else setIsRefreshing(true);
    try {
      const u = underlying || 'NIFTY';
      const res = await fetch(`/api/options/iv-history?mode=cumulative&underlying=${u}&wings=${wingVal}&fallback=1`);
      const json: CumulativeResponse = await res.json();
      if (seq !== requestSeq.current) return;
      if (json.success) {
        setData(json);
        setError('');
      } else {
        setError(json.error || 'Failed to load Cumulative OI');
      }
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        setIsRefreshing(false);
      }
    }
  }, [underlying, wings]);

  useEffect(() => {
    setData(null);
    setLoading(true);
    fetchData(wings);
    const interval = setInterval(() => {
      fetchData(wings, true);
    }, 45_000);
    return () => clearInterval(interval);
  }, [fetchData, wings, underlying]);

  const points = data?.data ?? [];
  const regime = data?.regime;

  const latestPoint = points.length > 0 ? points[points.length - 1] : null;
  const currentPcr = latestPoint && latestPoint.ceOI > 0 ? (latestPoint.peOI / latestPoint.ceOI).toFixed(2) : '—';
  const currentDiff = latestPoint ? latestPoint.peOI - latestPoint.ceOI : 0;

  const timeBounds = useMemo(() => {
    if (points.length < 2) return { min: 0, max: 0 };
    return { min: points[0].ts, max: points[points.length - 1].ts };
  }, [points]);

  return (
    <div className="flex flex-col h-full bg-zinc-900/90 border border-zinc-800 rounded-xl overflow-hidden shadow-sm">
      {/* Widget Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/80 bg-zinc-950/60">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-blue-500/10 text-blue-400 border border-blue-500/25">
            <Layers className="w-3 h-3" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-white tracking-tight">Cumulative OI</span>
              <span className="text-[10px] font-mono text-blue-400 font-bold">({underlying})</span>
              {isRefreshing && <RefreshCw className="w-2.5 h-2.5 text-blue-400 animate-spin" />}
            </div>
          </div>
        </div>

        {/* Header telemetry & controls */}
        <div className="flex items-center gap-2">
          {/* Regime Badge */}
          {regime && (
            <div
              className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold border ${regimeBadgeClass(regime.label)}`}
              title={`${regime.label} (Score: ${regime.signal.toFixed(2)}, Conf: ${regime.confidenceLabel}) - ${regime.reason}`}
            >
              <ShieldCheck className="w-2.5 h-2.5" />
              <span>{regime.label}</span>
            </div>
          )}

          {/* PCR & Net Diff Pills */}
          {latestPoint && (
            <div className="hidden sm:flex items-center gap-1 text-[10px] font-mono tabular-nums">
              <span className="px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 text-zinc-300">
                PCR <span className="font-bold text-white">{currentPcr}</span>
              </span>
              <span className={`px-1.5 py-0.5 rounded bg-zinc-950 border border-zinc-800 font-bold ${currentDiff >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {currentDiff >= 0 ? '+' : ''}{fmtOI(currentDiff)}
              </span>
            </div>
          )}

          {/* Wings Picker */}
          <div className="flex items-center gap-0.5 bg-zinc-950 p-0.5 rounded border border-zinc-800 text-[10px]">
            {[5, 10, 15].map(w => (
              <button
                key={w}
                type="button"
                onClick={() => setWings(w)}
                className={`px-1.5 py-0.5 font-bold rounded transition-colors ${
                  wings === w ? 'bg-blue-500/20 text-blue-300 border border-blue-500/40' : 'text-zinc-500 hover:text-zinc-300'
                }`}
                title={`ATM ±${w} strikes`}
              >
                ±{w}
              </button>
            ))}
          </div>

          {/* Refresh */}
          <button
            type="button"
            onClick={() => fetchData(wings)}
            title="Refresh Cumulative OI"
            className="p-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white"
          >
            <RefreshCw className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex-1 min-h-[170px] p-2 flex flex-col justify-between">
        {loading && (
          <CockpitSpinner
            label={`Loading ${underlying} Cumulative OI`}
            sublabel="Reconstructing ATM ± wings strike curve..."
            color="blue"
          />
        )}

        {error && !data && (
          <div className="flex-1 flex items-center justify-center p-3 text-center">
            <span className="text-[11px] text-rose-400">{error}</span>
          </div>
        )}

        {!loading && points.length === 0 && !error && (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-[11px]">
            No cumulative OI points for {underlying} today.
          </div>
        )}

        {points.length > 0 && (
          <div className="flex-1 w-full h-[155px]">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={points} margin={{ top: 4, right: 8, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id="cumCeGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#3b82f6" stopOpacity={0.02} />
                  </linearGradient>
                  <linearGradient id="cumPeGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#f43f5e" stopOpacity={0.35} />
                    <stop offset="95%" stopColor="#f43f5e" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="2 2" stroke="#27272a" vertical={false} />
                <XAxis
                  dataKey="ts"
                  domain={[timeBounds.min, timeBounds.max]}
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  tickFormatter={fmtTick}
                  tickLine={false}
                  axisLine={{ stroke: '#27272a' }}
                  interval="preserveStartEnd"
                  minTickGap={45}
                />
                <YAxis
                  yAxisId="oi"
                  tick={{ fontSize: 9, fill: '#71717a' }}
                  tickFormatter={fmtOI}
                  tickLine={false}
                  axisLine={false}
                  width={38}
                />
                <YAxis
                  yAxisId="spot"
                  orientation="right"
                  domain={['auto', 'auto']}
                  hide
                />
                <Tooltip content={<CompactOITooltip />} />
                <Area
                  yAxisId="oi"
                  type="monotone"
                  dataKey="ceOI"
                  name="CE OI"
                  stroke="#3b82f6"
                  strokeWidth={1.5}
                  fill="url(#cumCeGrad)"
                  dot={false}
                  isAnimationActive={false}
                />
                <Area
                  yAxisId="oi"
                  type="monotone"
                  dataKey="peOI"
                  name="PE OI"
                  stroke="#f43f5e"
                  strokeWidth={1.5}
                  fill="url(#cumPeGrad)"
                  dot={false}
                  isAnimationActive={false}
                />
                <Line
                  yAxisId="spot"
                  type="monotone"
                  dataKey="spot"
                  name="Spot"
                  stroke="#f59e0b"
                  strokeWidth={1.2}
                  strokeDasharray="3 2"
                  dot={false}
                  isAnimationActive={false}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}

        {/* Bottom Minute-by-Minute Regime Ribbon */}
        {points.length > 0 && timeBounds.max > timeBounds.min && (
          <div className="mt-1 pt-1 border-t border-zinc-800/80 flex items-center gap-2">
            <span className="text-[9px] font-bold text-zinc-500 uppercase tracking-wider shrink-0">Regime</span>
            <div className="relative flex-1 h-2 rounded bg-zinc-950 overflow-hidden flex">
              {points.map((pt, i) => {
                const nextTs = i < points.length - 1 ? points[i + 1].ts : timeBounds.max;
                const widthPct = Math.max(0.2, ((nextTs - pt.ts) / (timeBounds.max - timeBounds.min)) * 100);
                return (
                  <div
                    key={pt.ts}
                    title={`${fmtTick(pt.ts)}: ${pt.regimeLabel}${pt.regimeConfirmed ? ' (Confirmed)' : ''}`}
                    className={`h-full ${regimeBarColor(pt.regimeLabel)}`}
                    style={{ width: `${widthPct}%` }}
                  />
                );
              })}
            </div>
            <div className="flex items-center gap-2 text-[9px] text-zinc-400 font-semibold shrink-0">
              <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-blue-400" />CE</span>
              <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-rose-400" />PE</span>
              <span className="flex items-center gap-0.5"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Spot</span>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
