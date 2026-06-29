'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  LineChart, Line, BarChart, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceLine, Cell, Legend,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface SkewRow {
  strike: number;
  ceIV: number;
  peIV: number;
  diff: number;
  ceLTP: number;
  peLTP: number;
}

interface OcSide {
  last_price?: number;
  implied_volatility?: number;
  greeks?: { iv?: number };
  oi?: number;
}

interface OcEntry { ce?: OcSide; pe?: OcSide }

// ─── Constants ────────────────────────────────────────────────────

const UNDERLYING  = 'NIFTY';
const STRIKE_STEP = 50;
const WING_COUNT  = 10;
const POLL_MS     = 10_000;

// ─── Helpers ──────────────────────────────────────────────────────

function getIV(side?: OcSide): number {
  if (!side) return 0;
  return side.implied_volatility ?? side.greeks?.iv ?? 0;
}

function fmtPct(n: number): string {
  return `${n.toFixed(2)}%`;
}

// ─── Tooltips ─────────────────────────────────────────────────────

const SmileTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur">
      <p className="text-zinc-400 mb-2 font-semibold">Strike {String(label)}</p>
      {(payload as Array<{ color: string; name: string; value: number }>).map(p => (
        <div key={p.name} className="flex justify-between gap-6 mb-0.5">
          <span style={{ color: p.color }} className="font-semibold">{p.name}</span>
          <span className="tabular-nums text-white font-bold">{fmtPct(p.value)}</span>
        </div>
      ))}
    </div>
  );
};

const DiffTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  const val = (payload as Array<{ value: number }>)[0]?.value ?? 0;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur">
      <p className="text-zinc-400 mb-1 font-semibold">Strike {String(label)}</p>
      <p className={`font-bold tabular-nums ${val >= 0 ? 'text-blue-400' : 'text-amber-400'}`}>
        CE−PE: {val >= 0 ? '+' : ''}{fmtPct(val)}
      </p>
    </div>
  );
};

// ─── Main ─────────────────────────────────────────────────────────

export default function OptionsSkewTab({ expiry }: { expiry: string }) {
  const [skewData, setSkewData]       = useState<SkewRow[]>([]);
  const [spot, setSpot]               = useState(0);
  const [atm, setAtm]                 = useState(0);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState('');
  const intervalRef = useRef<NodeJS.Timeout | null>(null);

  const fetchSkew = async () => {
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

      const spotPrice = json.data.spot;
      const atmStrike = Math.round(spotPrice / STRIKE_STEP) * STRIKE_STEP;

      const rows: SkewRow[] = Object.entries(json.data.chain.oc)
        .map(([k, v]) => {
          const strike = Number(k);
          const ceIV   = getIV(v.ce);
          const peIV   = getIV(v.pe);
          return { strike, ceIV, peIV, diff: ceIV - peIV, ceLTP: v.ce?.last_price ?? 0, peLTP: v.pe?.last_price ?? 0 };
        })
        .filter(r => !isNaN(r.strike) && Math.abs(r.strike - atmStrike) <= WING_COUNT * STRIKE_STEP)
        .sort((a, b) => a.strike - b.strike);

      setSpot(spotPrice);
      setAtm(atmStrike);
      setSkewData(rows);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }));
      setError('');
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!expiry) return;
    setLoading(true);
    void fetchSkew();
    intervalRef.current = setInterval(() => { void fetchSkew(); }, POLL_MS);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [expiry]);

  if (loading && !skewData.length) {
    return (
      <div className="flex items-center justify-center py-20 text-zinc-500 text-sm">
        Loading skew data…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">

      {/* Status bar */}
      <div className="flex items-center gap-4 px-4 py-2 bg-zinc-900 rounded-lg border border-zinc-800">
        <span className="text-zinc-400 text-xs">
          Spot: <span className="text-white font-semibold tabular-nums">{spot > 0 ? spot.toLocaleString('en-IN') : '—'}</span>
        </span>
        <span className="text-zinc-400 text-xs">
          ATM: <span className="text-white font-semibold tabular-nums">{atm > 0 ? atm.toLocaleString('en-IN') : '—'}</span>
        </span>
        <span className="text-zinc-400 text-xs">
          Expiry: <span className="text-zinc-300 font-medium">{expiry}</span>
        </span>
        {lastUpdated && (
          <span className="text-zinc-400 text-xs">
            Updated: <span className="text-zinc-300 tabular-nums">{lastUpdated}</span>
          </span>
        )}
        {lastUpdated && (
          <span className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            LIVE
          </span>
        )}
      </div>

      {error && (
        <div className="px-3 py-2 bg-red-900/20 border border-red-700/40 rounded-lg text-xs text-red-400">
          {error}
        </div>
      )}

      {/* IV Smile */}
      <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
        <h3 className="text-xs font-bold text-white mb-3">IV Smile</h3>
        <ResponsiveContainer width="100%" height={280}>
          <LineChart data={skewData} margin={{ top: 4, right: 24, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="4 4" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="strike"
              tick={{ fill: '#a1a1aa', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: '#27272a' }}
            />
            <YAxis
              tick={{ fill: '#a1a1aa', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip content={<SmileTooltip />} cursor={{ stroke: '#3f3f46', strokeWidth: 1 }} />
            <Legend
              wrapperStyle={{ fontSize: 11, paddingTop: 12 }}
              formatter={(v: string) => <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{v}</span>}
            />
            {atm > 0 && (
              <ReferenceLine
                x={atm}
                stroke="#a1a1aa"
                strokeDasharray="4 4"
                label={{ value: 'ATM', fill: '#a1a1aa', fontSize: 10, position: 'top' }}
              />
            )}
            <Line type="monotone" dataKey="ceIV" name="CE IV" stroke="#60a5fa" dot={false} strokeWidth={2} />
            <Line type="monotone" dataKey="peIV" name="PE IV" stroke="#fbbf24" dot={false} strokeWidth={2} />
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* IV Differential */}
      <div className="bg-zinc-900 rounded-xl border border-zinc-800 p-4">
        <h3 className="text-xs font-bold text-white mb-3">IV Differential (CE − PE)</h3>
        <ResponsiveContainer width="100%" height={160}>
          <BarChart data={skewData} margin={{ top: 4, right: 24, left: 0, bottom: 4 }}>
            <CartesianGrid strokeDasharray="4 4" stroke="#27272a" vertical={false} />
            <XAxis
              dataKey="strike"
              tick={{ fill: '#a1a1aa', fontSize: 11 }}
              tickLine={false}
              axisLine={{ stroke: '#27272a' }}
            />
            <YAxis
              tick={{ fill: '#a1a1aa', fontSize: 11 }}
              tickLine={false}
              axisLine={false}
              tickFormatter={(v: number) => `${v}%`}
            />
            <Tooltip content={<DiffTooltip />} cursor={{ fill: '#27272a' }} />
            <ReferenceLine y={0} stroke="#a1a1aa" strokeWidth={1} />
            {atm > 0 && <ReferenceLine x={atm} stroke="#a1a1aa" strokeDasharray="4 4" />}
            <Bar dataKey="diff" name="CE−PE IV" radius={[2, 2, 0, 0]}>
              {skewData.map(row => (
                <Cell key={row.strike} fill={row.diff >= 0 ? '#60a5fa' : '#fbbf24'} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Raw data table */}
      <div className="bg-zinc-900 rounded-xl border border-zinc-800 overflow-hidden">
        <table className="w-full text-xs">
          <thead className="bg-zinc-800">
            <tr>
              {['Strike', 'CE IV', 'PE IV', 'CE−PE', 'CE LTP', 'PE LTP'].map(h => (
                <th key={h} className="px-3 py-2 text-left text-xs font-bold text-white">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {skewData.map(row => (
              <tr
                key={row.strike}
                className={`border-t border-zinc-800/60 ${row.strike === atm ? 'bg-zinc-700/30' : 'hover:bg-zinc-800/30'}`}
              >
                <td className="px-3 py-1.5 font-semibold tabular-nums text-zinc-200">
                  {row.strike.toLocaleString('en-IN')}
                  {row.strike === atm && (
                    <span className="ml-1.5 text-[10px] px-1 py-0.5 bg-zinc-700 rounded text-zinc-400">ATM</span>
                  )}
                </td>
                <td className="px-3 py-1.5 tabular-nums text-blue-400">{fmtPct(row.ceIV)}</td>
                <td className="px-3 py-1.5 tabular-nums text-amber-400">{fmtPct(row.peIV)}</td>
                <td className={`px-3 py-1.5 tabular-nums font-semibold ${row.diff >= 0 ? 'text-blue-400' : 'text-amber-400'}`}>
                  {row.diff >= 0 ? '+' : ''}{fmtPct(row.diff)}
                </td>
                <td className="px-3 py-1.5 tabular-nums text-zinc-300">{row.ceLTP.toFixed(1)}</td>
                <td className="px-3 py-1.5 tabular-nums text-zinc-300">{row.peLTP.toFixed(1)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
