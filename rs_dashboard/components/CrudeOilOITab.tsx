'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine, Cell,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface OcSide {
  last_price?: number;
  oi?: number;
  previous_oi?: number;
  implied_volatility?: number;
  greeks?: { iv?: number };
}

interface OcEntry { ce?: OcSide; pe?: OcSide }

interface OIRow {
  strike: number;
  ceOI: number;
  peOI: number;
  ceDelta: number;
  peDelta: number;
  isATM: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'CRUDEOIL';
const STRIKE_STEP = 100;
const WING_COUNT  = 10;

const POLL_OPTIONS = [
  { label: '10s', ms: 10_000  },
  { label: '20s', ms: 20_000  },
  { label: '30s', ms: 30_000  },
  { label: '1m',  ms: 60_000  },
  { label: '2m',  ms: 120_000 },
  { label: '3m',  ms: 180_000 },
] as const;

type PollMs = typeof POLL_OPTIONS[number]['ms'];

// ─── Helpers ──────────────────────────────────────────────────────

function fmtOI(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10_000_000) return `${(n / 10_000_000).toFixed(2)}Cr`;
  if (abs >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtStrike(n: number): string {
  return n.toLocaleString('en-IN');
}

// ─── Tooltips ─────────────────────────────────────────────────────

const OITooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: OIRow }>)[0]?.payload;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[180px]">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums">
        Strike {fmtStrike(Number(label))}{row?.isATM ? ' · ATM' : ''}
      </p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-blue-400 font-semibold">CE OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOI(row?.ceOI ?? 0)}</span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-red-400 font-semibold">PE OI</span>
        <span className="text-white font-bold tabular-nums">{fmtOI(row?.peOI ?? 0)}</span>
      </div>
      {(row?.ceOI ?? 0) > 0 && (
        <div className="mt-2 pt-2 border-t border-zinc-800 flex justify-between gap-8">
          <span className="text-zinc-400">PCR</span>
          <span className="text-yellow-400 font-bold tabular-nums">
            {((row?.peOI ?? 0) / (row?.ceOI ?? 1)).toFixed(2)}
          </span>
        </div>
      )}
    </div>
  );
};

const DeltaTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const row = (payload as Array<{ payload: OIRow }>)[0]?.payload;
  const ceD = row?.ceDelta ?? 0;
  const peD = row?.peDelta ?? 0;
  return (
    <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[190px]">
      <p className="text-zinc-300 font-bold mb-2 tabular-nums">
        Strike {fmtStrike(Number(label))}{row?.isATM ? ' · ATM' : ''}
      </p>
      <div className="flex justify-between gap-8 mb-1">
        <span className="text-blue-400 font-semibold">CE OI Change</span>
        <span className={`font-bold tabular-nums ${ceD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {ceD >= 0 ? '+' : ''}{fmtOI(ceD)}
        </span>
      </div>
      <div className="flex justify-between gap-8">
        <span className="text-red-400 font-semibold">PE OI Change</span>
        <span className={`font-bold tabular-nums ${peD >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
          {peD >= 0 ? '+' : ''}{fmtOI(peD)}
        </span>
      </div>
    </div>
  );
};

// ─── Main ─────────────────────────────────────────────────────────

export default function CrudeOilOITab({ expiry }: { expiry: string }) {
  const [rows, setRows]               = useState<OIRow[]>([]);
  const [spot, setSpot]               = useState(0);
  const [atm, setAtm]                 = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const [pollMs, setPollMs]           = useState<PollMs>(30_000);
  const [stale, setStale]             = useState(false);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const failsRef    = useRef(0);
  const STALE_ERROR_AFTER = 4;

  const fetchOI = useCallback(async () => {
    if (!expiry) return;

    // Keep the last-good bars on a transient failure instead of blanking the charts.
    const onTransientFail = (msg: string) => {
      failsRef.current += 1;
      setStale(true);
      setRows(prev => {
        if (prev.length === 0 || failsRef.current >= STALE_ERROR_AFTER) setError(msg);
        return prev;
      });
    };

    try {
      const res  = await fetch(`/api/options/chain?underlying=${UNDERLYING}&expiry=${expiry}`);
      const json = await res.json() as {
        success: boolean;
        data?: { chain: { oc?: Record<string, OcEntry> }; spot: number };
        error?: string;
      };

      if (!json.success || !json.data?.chain?.oc) {
        onTransientFail(json.error ?? 'No chain data — retrying');
        return;
      }

      const spotPrice = json.data.spot ?? 0;
      if (spotPrice <= 0) {
        onTransientFail('Spot price unavailable — retrying');
        return;
      }

      const oc        = json.data.chain.oc;
      if (!oc || Object.keys(oc).length === 0) {
        onTransientFail('Option chain empty — retrying');
        return;
      }

      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;

      const newRows: OIRow[] = Object.entries(oc)
        .map(([k, v]) => {
          const strike = Number(k);
          const ceOI   = v.ce?.oi ?? 0;
          const peOI   = v.pe?.oi ?? 0;
          const cePrev = v.ce?.previous_oi ?? 0;
          const pePrev = v.pe?.previous_oi ?? 0;
          return {
            strike,
            ceOI,
            peOI,
            ceDelta: ceOI - cePrev,
            peDelta: peOI - pePrev,
            isATM:   strike === atmStrike,
          };
        })
        .filter(r => {
          if (isNaN(r.strike)) return false;
          if (Math.abs(r.strike - atmStrike) > WING_COUNT * STRIKE_STEP) return false;
          return (r.ceOI > 0 || r.peOI > 0);
        })
        .sort((a, b) => a.strike - b.strike);

      setSpot(spotPrice);
      setAtm(atmStrike);
      setRows(newRows);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', {
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }));
      failsRef.current = 0;
      setStale(false);
      setError('');
    } catch (e) {
      onTransientFail(String(e));
    } finally {
      setLoading(false);
    }
  }, [expiry]);

  useEffect(() => {
    if (!expiry) return;
    setRows([]);
    setSpot(0);
    setAtm(0);
    setLastUpdated(null);
    setStale(false);
    failsRef.current = 0;
    setLoading(true);
    void fetchOI();
    intervalRef.current = setInterval(() => { void fetchOI(); }, pollMs);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [expiry, fetchOI, pollMs]);

  // ── Derived stats ─────────────────────────────────────────────────
  const totalCeOI = rows.reduce((s, r) => s + r.ceOI, 0);
  const totalPeOI = rows.reduce((s, r) => s + r.peOI, 0);
  const chainPCR  = totalCeOI > 0 ? totalPeOI / totalCeOI : 0;

  const pcrColor  = chainPCR > 1.3 ? 'text-emerald-400'
                  : chainPCR > 0 && chainPCR < 0.7 ? 'text-red-400'
                  : 'text-yellow-400';
  const pcrLabel  = chainPCR > 1.3 ? 'Bullish' : chainPCR < 0.7 && chainPCR > 0 ? 'Bearish' : 'Neutral';

  const xAxisProps = {
    dataKey: 'strike' as const,
    tickFormatter: fmtStrike,
    tick:      { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine:  false,
    axisLine:  { stroke: '#27272a' },
  };
  const gridProps = { strokeDasharray: '4 4', stroke: '#27272a', vertical: false as const };

  if (loading && !rows.length) {
    return (
      <div className="flex flex-col items-center justify-center py-24 gap-3">
        <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
        <p className="text-sm text-zinc-400 font-medium">Loading open interest…</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Top Bar Controls */}
      <div className="flex items-center justify-between border border-zinc-800 bg-zinc-900/40 rounded-xl px-4 py-3 gap-4 flex-wrap">
        <div className="flex items-center gap-6 flex-wrap">
          <div>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest block">Crude Spot (Fut)</span>
            <span className="text-sm font-bold text-zinc-100 tabular-nums">₹{spot.toLocaleString('en-IN')}</span>
          </div>
          <div>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest block">ATM Strike</span>
            <span className="text-sm font-bold text-zinc-100 tabular-nums">₹{atm.toLocaleString('en-IN')}</span>
          </div>
          <div>
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest block">Chain PCR</span>
            <span className={`text-sm font-bold tabular-nums ${pcrColor}`}>
              {chainPCR.toFixed(3)} <span className="text-xs font-normal text-zinc-400">({pcrLabel})</span>
            </span>
          </div>
        </div>

        <div className="flex items-center gap-3 ml-auto text-xs shrink-0">
          <div className="flex items-center gap-1 border border-zinc-800 bg-zinc-950 p-0.5 rounded-lg">
            {POLL_OPTIONS.map(opt => (
              <button
                key={opt.ms}
                onClick={() => setPollMs(opt.ms)}
                className={`px-2 py-1 rounded font-semibold transition-all ${
                  pollMs === opt.ms
                    ? 'bg-zinc-800 text-zinc-100 shadow-sm'
                    : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 whitespace-nowrap pl-2 border-l border-zinc-850">
            {stale && lastUpdated && (
              <span className="inline-flex items-center gap-1 text-amber-400 font-semibold">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                stale
              </span>
            )}
            <span className="text-zinc-500 font-medium">Last Updated: {lastUpdated ?? '—'}</span>
          </div>
        </div>
      </div>

      {error && (
        <div className="px-4 py-3 bg-red-900/15 border border-red-700/30 rounded-xl text-xs font-medium text-red-400">
          {error}
        </div>
      )}

      {/* Charts Stack (Vertical Alignment, Wide & Big) */}
      <div className="flex flex-col gap-6">
        {/* Open Interest Bar Chart */}
        <div className="border border-zinc-800 bg-zinc-950 rounded-xl p-6 flex flex-col gap-3 min-h-[520px]">
          <div>
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-widest">Open Interest (OI)</h3>
            <p className="text-[10px] text-zinc-500 mt-0.5">Total open option contracts per strike</p>
          </div>

          <div className="w-full h-[450px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 10, right: 5, left: -25, bottom: 5 }}>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis
                  tickFormatter={fmtOI}
                  tick={{ fontSize: 9, fill: '#a1a1aa' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<OITooltip />} cursor={{ fill: '#ffffff04' }} />
                <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine x={atm} stroke="#e4e4e7" strokeDasharray="3 3" label={{ value: 'ATM', fill: '#e4e4e7', fontSize: 10, position: 'top' }} />
                <Bar dataKey="ceOI" name="Call OI" fill="#3b82f6" maxBarSize={28} radius={[4, 4, 0, 0]} />
                <Bar dataKey="peOI" name="Put OI" fill="#ef4444" maxBarSize={28} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* OI Change Bar Chart */}
        <div className="border border-zinc-800 bg-zinc-950 rounded-xl p-6 flex flex-col gap-3 min-h-[520px]">
          <div>
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-widest">OI Change (Delta)</h3>
            <p className="text-[10px] text-zinc-500 mt-0.5">Daily change in open interest contracts</p>
          </div>

          <div className="w-full h-[450px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={rows} margin={{ top: 10, right: 5, left: -25, bottom: 5 }}>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis
                  tickFormatter={fmtOI}
                  tick={{ fontSize: 9, fill: '#a1a1aa' }}
                  tickLine={false}
                  axisLine={false}
                />
                <Tooltip content={<DeltaTooltip />} cursor={{ fill: '#ffffff04' }} />
                <Legend iconSize={8} iconType="circle" wrapperStyle={{ fontSize: 10 }} />
                <ReferenceLine y={0} stroke="#3f3f46" />
                <ReferenceLine x={atm} stroke="#e4e4e7" strokeDasharray="3 3" label={{ value: 'ATM', fill: '#e4e4e7', fontSize: 10, position: 'top' }} />
                <Bar dataKey="ceDelta" name="Call Change" fill="#38bdf8" maxBarSize={28}>
                  {rows.map((row, i) => (
                    <Cell key={i} fill={row.ceDelta >= 0 ? '#3b82f6' : '#22c55e'} />
                  ))}
                </Bar>
                <Bar dataKey="peDelta" name="Put Change" fill="#f87171" maxBarSize={28}>
                  {rows.map((row, i) => (
                    <Cell key={i} fill={row.peDelta >= 0 ? '#ef4444' : '#22c55e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </div>
  );
}
