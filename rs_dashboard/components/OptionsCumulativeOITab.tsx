'use client';

import React, { useState, useEffect, useRef } from 'react';
import Link from 'next/link';
import {
  AreaChart, Area, LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea, Legend,
} from 'recharts';
import { Sparkles, HelpCircle, ArrowRight, ShieldCheck, Layers, TrendingUp, Zap, DollarSign } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────

interface TimePoint {
  time: string;
  ts:   number;   // epoch ms — numeric X axis
  spot: number;
  ceOI: number;
  peOI: number;
  diff: number;
  oiZ: number;
  slopeZ: number;
  wpiZ: number;
  regimeLabel: RegimeLabel;
  regimeConfirmed: boolean;
}

type RegimeLabel = 'Strong Bullish' | 'Bullish' | 'Neutral' | 'Bearish' | 'Strong Bearish';
type Zone = 'Bullish' | 'Neutral' | 'Bearish';
type ConfidenceLabel = 'Low' | 'Moderate' | 'High';
type ConfirmationState = 'Confirmed' | 'Pending' | 'N/A';

interface RegimeSnapshot {
  signal: number;
  oiZ: number;
  slopeZ: number;
  accelZ: number;
  wpiZ: number;
  priceTrendZ: number;
  oiZone: Zone;
  slopeZone: Zone;
  wpiZone: Zone;
  priceTrendZone: Zone;
  confidence: number;
  confidenceLabel: ConfidenceLabel;
  label: RegimeLabel;
  strategy: string;
  confirmed: boolean;
  confirmationState: ConfirmationState;
  reason: string;
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

type ZMetricFilter = 'all' | 'oiZ' | 'slopeZ' | 'wpiZ';

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
    case 'Strong Bullish': return 'text-emerald-400';
    case 'Bullish':        return 'text-emerald-300';
    case 'Neutral':        return 'text-yellow-400';
    case 'Bearish':        return 'text-red-300';
    case 'Strong Bearish': return 'text-red-400';
  }
}

function regimeBarColor(label: RegimeLabel): string {
  switch (label) {
    case 'Strong Bullish':
    case 'Bullish':        return 'bg-emerald-400';
    case 'Neutral':        return 'bg-yellow-400';
    case 'Bearish':
    case 'Strong Bearish': return 'bg-red-400';
  }
}

/** Maps a signal in roughly [-3, +3] to a 0-100% gauge width, clamped. */
function signalToPct(signal: number): number {
  return Math.max(0, Math.min(100, Math.round(((signal + 3) / 6) * 100)));
}

function zoneDot(zone: Zone): string {
  switch (zone) {
    case 'Bullish': return '🟢';
    case 'Bearish': return '🔴';
    case 'Neutral': return '⚪';
  }
}

function confirmationColor(state: ConfirmationState): string {
  switch (state) {
    case 'Confirmed': return 'text-emerald-400';
    case 'Pending':   return 'text-yellow-400';
    case 'N/A':       return 'text-zinc-500';
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

const ZScoreTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const getVal = (name: string) => (payload as Array<{ name: string; value: number }>).find(p => p.name === name)?.value ?? 0;
  const oiZ = getVal('OI_Z');
  const slopeZ = getVal('Slope_Z');
  const wpiZ = getVal('WPI_Z');

  const oiTag = oiZ > 0.5 ? 'Put Writing (Support)' : oiZ < -0.5 ? 'Call Writing (Resistance)' : 'Neutral Balance';
  const slopeTag = slopeZ > 0.5 ? 'Accelerating Put Writing' : slopeZ < -0.5 ? 'Accelerating Call Writing' : 'Steady Speed';
  const wpiTag = wpiZ > 0.5 ? 'Institutional Put Premium Inflow' : wpiZ < -0.5 ? 'Institutional Call Premium Inflow' : 'Balanced Flows';

  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[260px] space-y-2">
      <p className="text-zinc-300 font-bold border-b border-zinc-800 pb-1">
        {typeof label === 'number' ? fmtTick(label) : String(label)}
      </p>
      <div className="space-y-1.5 font-mono text-[11px]">
        <div className="flex justify-between items-center gap-4">
          <span className="text-blue-400 font-semibold">OI_Z ({oiZ >= 0 ? '+' : ''}{oiZ.toFixed(2)})</span>
          <span className={`text-[10px] font-sans font-semibold ${oiZ > 0.5 ? 'text-emerald-400' : oiZ < -0.5 ? 'text-red-400' : 'text-zinc-400'}`}>{oiTag}</span>
        </div>
        <div className="flex justify-between items-center gap-4">
          <span className="text-amber-400 font-semibold">Slope_Z ({slopeZ >= 0 ? '+' : ''}{slopeZ.toFixed(2)})</span>
          <span className={`text-[10px] font-sans font-semibold ${slopeZ > 0.5 ? 'text-emerald-400' : slopeZ < -0.5 ? 'text-red-400' : 'text-zinc-400'}`}>{slopeTag}</span>
        </div>
        <div className="flex justify-between items-center gap-4">
          <span className="text-purple-400 font-semibold">WPI_Z ({wpiZ >= 0 ? '+' : ''}{wpiZ.toFixed(2)})</span>
          <span className={`text-[10px] font-sans font-semibold ${wpiZ > 0.5 ? 'text-emerald-400' : wpiZ < -0.5 ? 'text-red-400' : 'text-zinc-400'}`}>{wpiTag}</span>
        </div>
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
  const [showZGuide, setShowZGuide] = useState(false);
  const [metricFilter, setMetricFilter] = useState<ZMetricFilter>('all');
  const pollRef    = useRef<NodeJS.Timeout | null>(null);
  const wingRef    = useRef(10);

  const fetchData = (wings = wingRef.current) => {
    fetch(`/api/options/iv-history?mode=cumulative&underlying=NIFTY&wings=${wings}`)
      .then(res => res.json())
      .then((json: CumulativeResponse) => {
        setLoading(false);
        if (json.success) {
          setResponse(json);
          setError('');
        } else {
          setError(json.error || 'Failed to load options data');
        }
      })
      .catch(err => {
        setLoading(false);
        setError(err.message || 'Network error');
      });
  };

  useEffect(() => {
    wingRef.current = wingCount;
    setLoading(true);
    fetchData(wingCount);

    pollRef.current = setInterval(() => {
      fetchData(wingRef.current);
    }, 15_000);

    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [wingCount]);

  const handleWingChange = (val: number) => {
    setWingCount(val);
  };

  if (loading && !response) {
    return (
      <div className="flex flex-col items-center justify-center py-24 text-zinc-400 gap-3">
        <div className="w-6 h-6 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-sm font-medium">Computing Cumulative OI &amp; Options Regime…</p>
      </div>
    );
  }

  if (error && !response) {
    return (
      <div className="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-red-400 text-sm font-medium my-4">
        {error}
      </div>
    );
  }

  const data      = response?.data || [];
  const regime    = response?.regime;
  const date      = response?.date || new Date().toISOString().slice(0, 10);
  const bounds    = sessionBoundsIST(date);
  const xStart    = bounds.start;
  const xEnd      = bounds.end;
  const lastPoint = data[data.length - 1];
  const diff      = lastPoint?.diff ?? 0;

  const xAxisProps = {
    dataKey: 'ts',
    type: 'number' as const,
    domain: [xStart, xEnd],
    tickFormatter: fmtTick,
    ticks: [
      new Date(`${date}T09:15:00+05:30`).getTime(),
      new Date(`${date}T10:30:00+05:30`).getTime(),
      new Date(`${date}T11:45:00+05:30`).getTime(),
      new Date(`${date}T13:00:00+05:30`).getTime(),
      new Date(`${date}T14:15:00+05:30`).getTime(),
      new Date(`${date}T15:30:00+05:30`).getTime(),
    ],
    tick: { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 },
    tickLine: false,
    axisLine: false,
  };

  const gridProps = {
    strokeDasharray: '3 3',
    stroke: '#27272a',
    vertical: true,
    horizontal: true,
  };

  // Helper for actionable readout recommendation
  const isConfirmedBullish = regime?.confirmed && regime?.label.includes('Bullish');
  const isConfirmedBearish = regime?.confirmed && regime?.label.includes('Bearish');

  return (
    <div className="flex flex-col gap-6 py-2">
      {/* ── Top Bar ──────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-4 bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="text-base font-bold text-white tracking-tight">Cumulative Options OI &amp; Regime</h2>
            <p className="text-xs text-zinc-400">
              NIFTY Expiry: <span className="text-zinc-200 font-semibold">{response?.expiry || '—'}</span> · ATM: <span className="text-zinc-200 font-semibold">{response?.atm ? response.atm.toLocaleString('en-IN') : '—'}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            <label htmlFor="wings-input" className="text-xs text-zinc-400 font-medium">ATM ± Wings:</label>
            <input
              id="wings-input"
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
            LIVE
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
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-4">
            {regime.warmingUp ? (
              <div className="flex items-center gap-3 py-2">
                <div className="w-4 h-4 border-2 border-zinc-700 border-t-zinc-500 rounded-full animate-spin" />
                <p className="text-sm text-zinc-500 font-medium">
                  Building history — regime score available after ~5 min of data
                  ({regime.sampleCount}/10 samples)
                </p>
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                {/* Market Regime Header */}
                <div className="flex items-center justify-between flex-wrap gap-3">
                  <div>
                    <div className="flex items-center gap-2">
                      <ShieldCheck className="h-4 w-4 text-sky-400" />
                      <p className="text-sm font-bold text-white tracking-tight">Market Regime Score</p>
                    </div>
                    <p className="text-[10px] text-zinc-400 mt-0.5">
                      Weighted Z-score: 0.25×OI_Z + 0.20×Slope_Z + 0.10×Accel_Z + 0.25×WPI_Z + 0.20×PriceTrend_Z
                    </p>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className={`text-lg font-bold tabular-nums ${regimeColor(regime.label)}`}>
                      {regime.label}
                    </span>
                    <span className="text-xs text-zinc-400 tabular-nums">
                      Score {regime.signal >= 0 ? '+' : ''}{regime.signal.toFixed(2)}
                    </span>
                  </div>
                </div>

                <div className="w-full h-2.5 bg-zinc-800 rounded-full overflow-hidden">
                  <div
                    className={`h-full ${regimeBarColor(regime.label)} transition-all duration-500`}
                    style={{ width: `${signalToPct(regime.signal)}%` }}
                  />
                </div>

                <div className="flex items-center gap-5 flex-wrap">
                  <StatChip label={`${zoneDot(regime.oiZone)} OI_Z`} value={`${regime.oiZ >= 0 ? '+' : ''}${regime.oiZ.toFixed(2)}`} sub={regime.oiZone} />
                  <StatChip label={`${zoneDot(regime.slopeZone)} Slope_Z`} value={`${regime.slopeZ >= 0 ? '+' : ''}${regime.slopeZ.toFixed(2)}`} sub={regime.slopeZone} />
                  <StatChip label="Accel_Z" value={`${regime.accelZ >= 0 ? '+' : ''}${regime.accelZ.toFixed(2)}`} />
                  <StatChip label={`${zoneDot(regime.wpiZone)} WPI_Z`} value={`${regime.wpiZ >= 0 ? '+' : ''}${regime.wpiZ.toFixed(2)}`} sub={regime.wpiZone} />
                  <StatChip label={`${zoneDot(regime.priceTrendZone)} PriceTrend_Z`} value={`${regime.priceTrendZ >= 0 ? '+' : ''}${regime.priceTrendZ.toFixed(2)}`} sub={regime.priceTrendZone} />
                </div>

                {/* Trade Confirmation & Reason */}
                <div className="flex items-center gap-5 flex-wrap border-t border-zinc-800/80 pt-3">
                  <StatChip label="Confidence" value={regime.confidenceLabel} sub={regime.confidence.toFixed(2)} />
                  <StatChip label="Confirmation" value={regime.confirmationState} color={confirmationColor(regime.confirmationState)} />
                  <div className="flex-1 min-w-[220px]">
                    <span className="text-[10px] font-bold text-zinc-300 uppercase tracking-widest">Confirmation Status</span>
                    <p className="text-xs text-zinc-300 mt-0.5">{regime.reason}</p>
                  </div>
                </div>

                {/* ── Actionable Trade Blueprint Card ────────────────────── */}
                <div className="rounded-xl border border-sky-800/60 bg-sky-950/20 p-4 space-y-2">
                  <div className="flex items-center justify-between flex-wrap gap-2">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-sky-400" />
                      <h3 className="text-xs font-bold uppercase tracking-wider text-sky-300">Actionable Trading Blueprint</h3>
                    </div>
                    <Link
                      href="/strategy-builder"
                      className="flex items-center gap-1 text-[11px] font-bold text-sky-400 hover:text-sky-200 transition-colors"
                    >
                      <span>Model in Strategy Builder</span>
                      <ArrowRight className="h-3 w-3" />
                    </Link>
                  </div>

                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Market Bias</span>
                      <p className={`mt-0.5 text-xs font-bold ${regimeColor(regime.label)}`}>
                        {regime.label} {regime.confirmed ? '(Confirmed)' : '(Pending)'}
                      </p>
                    </div>

                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Recommended Structure</span>
                      <p className="mt-0.5 text-xs font-bold text-white">
                        {isConfirmedBullish
                          ? 'Bull Put Credit Spread (Sell OTM PE / Buy Lower PE)'
                          : isConfirmedBearish
                          ? 'Bear Call Credit Spread (Sell OTM CE / Buy Higher CE)'
                          : 'Stand Aside / Delta-Neutral Range'}
                      </p>
                    </div>

                    <div className="rounded-lg border border-zinc-800 bg-zinc-950/70 p-2.5">
                      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Institutional Activity</span>
                      <p className="mt-0.5 text-xs font-medium text-zinc-300">
                        {regime.wpiZ > 0.5
                          ? 'Institutions writing Puts (Building Floor)'
                          : regime.wpiZ < -0.5
                          ? 'Institutions writing Calls (Building Resistance)'
                          : 'Balanced Option Premium Collection'}
                      </p>
                    </div>
                  </div>
                </div>

                <p className="text-[10px] text-zinc-500 border-t border-zinc-800/80 pt-2">
                  Informational regime readout. Always verify expected value (P(win)×avgWin − P(loss)×avgLoss) and strike distance before opening live options orders.
                </p>
              </div>
            )}
          </div>
        )}

        {/* ── Regime Timeline ─────────────────────────────────────────── */}
        {data.length > 1 && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-bold text-white tracking-tight">Regime Timeline</p>
                <p className="text-[10px] text-zinc-400 mt-0.5">
                  Bias per minute · ▲ marks a confirmed signal (bias with OI/WPI/PriceTrend all agreeing)
                </p>
              </div>
              <div className="flex items-center gap-3 text-[10px] font-semibold">
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-emerald-400" /><span className="text-zinc-300">Bullish</span></span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-yellow-400" /><span className="text-zinc-300">Neutral</span></span>
                <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm bg-red-400" /><span className="text-zinc-300">Bearish</span></span>
              </div>
            </div>

            <div className="relative h-8 bg-zinc-950 rounded-lg overflow-hidden">
              {data.map((d, i) => {
                const nextTs = i < data.length - 1 ? data[i + 1].ts : xEnd;
                const leftPct = ((d.ts - xStart) / (xEnd - xStart)) * 100;
                const widthPct = ((nextTs - d.ts) / (xEnd - xStart)) * 100;
                return (
                  <div
                    key={d.ts}
                    title={`${fmtTick(d.ts)} — ${d.regimeLabel}${d.regimeConfirmed && d.regimeLabel !== 'Neutral' ? ' (confirmed)' : ''}`}
                    className={`absolute top-0 h-full ${regimeBarColor(d.regimeLabel)}`}
                    style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 0.15)}%` }}
                  />
                );
              })}
            </div>
            <div className="relative h-3 mt-0.5">
              {data.map(d => (
                d.regimeConfirmed && d.regimeLabel !== 'Neutral' ? (
                  <span
                    key={d.ts}
                    title={`${fmtTick(d.ts)} — confirmed ${d.regimeLabel}`}
                    className={`absolute text-[9px] leading-none -translate-x-1/2 ${d.regimeLabel.includes('Bullish') ? 'text-emerald-400' : 'text-red-400'}`}
                    style={{ left: `${((d.ts - xStart) / (xEnd - xStart)) * 100}%` }}
                  >▲</span>
                ) : null
              ))}
            </div>
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

        {/* ── Chart 3: OI Divergence / Slope / WPI — standardized (Z-score) ── */}
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5 space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-white tracking-tight">OI Pressure &amp; Flow Dynamics — Standardized (Z-Score)</p>
                <button
                  type="button"
                  onClick={() => setShowZGuide(prev => !prev)}
                  className="flex items-center gap-1 text-[10px] font-bold text-sky-400 hover:text-sky-200 transition-colors"
                >
                  <HelpCircle className="h-3.5 w-3.5" />
                  <span>{showZGuide ? 'Hide Guide' : 'How to Read Z-Scores'}</span>
                </button>
              </div>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                Standardized scale [-3 to +3] · <strong className="text-emerald-400">&gt; +0.5 = Bullish Force</strong> (Put Support) · <strong className="text-red-400">&lt; -0.5 = Bearish Force</strong> (Call Resistance)
              </p>
            </div>

            {/* Metric Filter Tabs */}
            <div className="flex items-center gap-1 rounded-lg border border-zinc-800 bg-zinc-950 p-1 text-[11px] font-medium">
              <button
                type="button"
                onClick={() => setMetricFilter('all')}
                className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${metricFilter === 'all' ? 'bg-zinc-800 font-bold text-white' : 'text-zinc-400 hover:text-zinc-200'}`}
              >
                <Layers className="h-3 w-3" />
                <span>All 3 Factors</span>
              </button>
              <button
                type="button"
                onClick={() => setMetricFilter('oiZ')}
                className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${metricFilter === 'oiZ' ? 'bg-blue-950/80 font-bold text-blue-300 border border-blue-800/80' : 'text-zinc-400 hover:text-blue-300'}`}
              >
                <span>OI Balance (OI_Z)</span>
              </button>
              <button
                type="button"
                onClick={() => setMetricFilter('slopeZ')}
                className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${metricFilter === 'slopeZ' ? 'bg-amber-950/80 font-bold text-amber-300 border border-amber-800/80' : 'text-zinc-400 hover:text-amber-300'}`}
              >
                <span>OI Speed (Slope_Z)</span>
              </button>
              <button
                type="button"
                onClick={() => setMetricFilter('wpiZ')}
                className={`flex items-center gap-1 rounded px-2 py-1 transition-colors ${metricFilter === 'wpiZ' ? 'bg-purple-950/80 font-bold text-purple-300 border border-purple-800/80' : 'text-zinc-400 hover:text-purple-300'}`}
              >
                <span>Cash Flow (WPI_Z)</span>
              </button>
            </div>
          </div>

          {/* Current Live Readings Bar */}
          {lastPoint && (
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 rounded-xl border border-zinc-800/80 bg-zinc-950/60 p-2.5 text-xs">
              <div className="flex items-center justify-between px-2">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-blue-400" />
                  <span className="font-semibold text-zinc-300">OI Balance (OI_Z):</span>
                </div>
                <div className="flex items-center gap-1 font-mono font-bold">
                  <span className="text-white">{lastPoint.oiZ >= 0 ? '+' : ''}{lastPoint.oiZ.toFixed(2)}</span>
                  <span className={`text-[10px] font-sans px-1 rounded ${lastPoint.oiZ > 0.5 ? 'bg-emerald-950 text-emerald-400' : lastPoint.oiZ < -0.5 ? 'bg-red-950 text-red-400' : 'text-zinc-400'}`}>
                    {lastPoint.oiZ > 0.5 ? 'Put Support' : lastPoint.oiZ < -0.5 ? 'Call Resistance' : 'Neutral'}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between px-2 border-t sm:border-t-0 sm:border-l border-zinc-800 pt-1.5 sm:pt-0">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  <span className="font-semibold text-zinc-300">OI Velocity (Slope_Z):</span>
                </div>
                <div className="flex items-center gap-1 font-mono font-bold">
                  <span className="text-white">{lastPoint.slopeZ >= 0 ? '+' : ''}{lastPoint.slopeZ.toFixed(2)}</span>
                  <span className={`text-[10px] font-sans px-1 rounded ${lastPoint.slopeZ > 0.5 ? 'bg-emerald-950 text-emerald-400' : lastPoint.slopeZ < -0.5 ? 'bg-red-950 text-red-400' : 'text-zinc-400'}`}>
                    {lastPoint.slopeZ > 0.5 ? 'Accelerating' : lastPoint.slopeZ < -0.5 ? 'Decelerating' : 'Steady'}
                  </span>
                </div>
              </div>

              <div className="flex items-center justify-between px-2 border-t sm:border-t-0 sm:border-l border-zinc-800 pt-1.5 sm:pt-0">
                <div className="flex items-center gap-1.5">
                  <span className="h-2 w-2 rounded-full bg-purple-400" />
                  <span className="font-semibold text-zinc-300">Money Flow (WPI_Z):</span>
                </div>
                <div className="flex items-center gap-1 font-mono font-bold">
                  <span className="text-white">{lastPoint.wpiZ >= 0 ? '+' : ''}{lastPoint.wpiZ.toFixed(2)}</span>
                  <span className={`text-[10px] font-sans px-1 rounded ${lastPoint.wpiZ > 0.5 ? 'bg-emerald-950 text-emerald-400' : lastPoint.wpiZ < -0.5 ? 'bg-red-950 text-red-400' : 'text-zinc-400'}`}>
                    {lastPoint.wpiZ > 0.5 ? 'Put Writing Inflow' : lastPoint.wpiZ < -0.5 ? 'Call Writing Inflow' : 'Balanced'}
                  </span>
                </div>
              </div>
            </div>
          )}

          {/* Interactive Z-Score Guide & Legend Banner */}
          {showZGuide && (
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-3 text-xs">
              <div className="flex items-center gap-1.5 font-bold text-zinc-200">
                <HelpCircle className="h-4 w-4 text-sky-400" />
                <span>Plain-Language Z-Score Cheat Sheet</span>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-[11px]">
                <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-3 space-y-1">
                  <div className="flex items-center gap-1 font-bold text-blue-400">
                    <TrendingUp className="h-3.5 w-3.5" />
                    <span>OI_Z (Accumulated OI Balance)</span>
                  </div>
                  <p className="text-zinc-400">
                    Measures Put vs Call OI volume. <strong className="text-emerald-400">&gt; +0.5</strong> means Put writing forms support. <strong className="text-red-400">&lt; -0.5</strong> means Call writing forms resistance.
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-3 space-y-1">
                  <div className="flex items-center gap-1 font-bold text-amber-400">
                    <Zap className="h-3.5 w-3.5" />
                    <span>Slope_Z (OI Velocity / Speed)</span>
                  </div>
                  <p className="text-zinc-400">
                    Measures the 15-minute linear regression slope of writing. Indicates whether writing is aggressively accelerating or cooling off.
                  </p>
                </div>
                <div className="rounded-lg border border-zinc-800/80 bg-zinc-900/60 p-3 space-y-1">
                  <div className="flex items-center gap-1 font-bold text-purple-400">
                    <DollarSign className="h-3.5 w-3.5" />
                    <span>WPI_Z (Weighted Premium Intake)</span>
                  </div>
                  <p className="text-zinc-400">
                    Measures actual ₹ premium collected by option sellers. <strong className="text-emerald-400">&gt; +0.5</strong> = Big money selling Puts. <strong className="text-red-400">&lt; -0.5</strong> = Selling Calls.
                  </p>
                </div>
              </div>
            </div>
          )}

          <ResponsiveContainer width="100%" height={280}>
            <LineChart data={data} margin={{ top: 12, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid {...gridProps} />
              <XAxis {...xAxisProps} />
              <YAxis
                tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={false}
                domain={[-3, 3]}
                width={40}
                tickFormatter={v => v.toFixed(1)}
              />
              <Tooltip content={<ZScoreTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1 }} />
              
              {/* Shaded Bullish and Bearish Reference Zones */}
              <ReferenceArea y1={0.5} y2={3.0} fill="#10b981" fillOpacity={0.04} />
              <ReferenceArea y1={-3.0} y2={-0.5} fill="#ef4444" fillOpacity={0.04} />

              <ReferenceLine y={0.5} stroke="#10b981" strokeDasharray="3 3" strokeWidth={1} label={{ value: '+0.5 Bullish', fill: '#10b981', fontSize: 10, position: 'right' }} />
              <ReferenceLine y={-0.5} stroke="#ef4444" strokeDasharray="3 3" strokeWidth={1} label={{ value: '-0.5 Bearish', fill: '#ef4444', fontSize: 10, position: 'right' }} />
              <ReferenceLine y={0} stroke="#71717a" strokeWidth={1.5} />
              
              <Legend
                wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
                formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
              />

              {(metricFilter === 'all' || metricFilter === 'oiZ') && (
                <Line type="monotone" dataKey="oiZ" name="OI_Z" stroke="#60a5fa" strokeWidth={2.5} dot={false} activeDot={{ r: 4 }} />
              )}
              {(metricFilter === 'all' || metricFilter === 'slopeZ') && (
                <Line type="monotone" dataKey="slopeZ" name="Slope_Z" stroke="#fbbf24" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              )}
              {(metricFilter === 'all' || metricFilter === 'wpiZ') && (
                <Line type="monotone" dataKey="wpiZ" name="WPI_Z" stroke="#c084fc" strokeWidth={2} dot={false} activeDot={{ r: 4 }} />
              )}
            </LineChart>
          </ResponsiveContainer>
        </div>
        </>
      )}
    </div>
  );
}
