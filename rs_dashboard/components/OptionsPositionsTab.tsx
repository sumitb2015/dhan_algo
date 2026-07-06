'use client';

import React, { useState, useEffect, useRef } from 'react';
import {
  ComposedChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer, ReferenceLine,
} from 'recharts';

const POLL_OPTIONS = [
  { label: '5s',   ms: 5000  },
  { label: '10s',  ms: 10000 },
  { label: '20s',  ms: 20000 },
  { label: '30s',  ms: 30000 },
  { label: 'Live', ms: 2000  },
] as const;
type PollMs = typeof POLL_OPTIONS[number]['ms'];

// ── Types ────────────────────────────────────────────────────────────

interface Leg {
  symbol: string;
  strike: number;
  type: 'CE' | 'PE';
  side: 'SELL' | 'BUY';
  ltp: number;
  netQty: number;
}

interface ApiResponse {
  has_positions: boolean;
  net_premium: number;
  vix: number;
  legs: Leg[];
  timestamp: string;
  error?: string;
}

interface DataPoint {
  time: string;
  netPremium: number;
  vix: number;
}

// ── Helpers ──────────────────────────────────────────────────────────

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch {
    return iso.slice(11, 19);
  }
}

function fmtNum(n: number, dec = 2): string {
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: dec,
    maximumFractionDigits: dec,
  });
}

// ── Custom tooltip ───────────────────────────────────────────────────

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: { name: string; value: number; color: string }[];
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700 rounded-xl px-3 py-2 text-xs shadow-xl">
      <p className="text-zinc-400 mb-1 font-medium">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: p.color }} />
          <span className="text-zinc-300">{p.name}:</span>
          <span className="text-white font-semibold">{fmtNum(p.value)}</span>
        </div>
      ))}
    </div>
  );
}

// ── Stat tile ────────────────────────────────────────────────────────

function StatTile({ label, value, sub, valueClass }: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-xl px-4 py-3 min-w-[130px]">
      <p className="text-[10px] font-bold text-zinc-500 uppercase tracking-widest mb-1">{label}</p>
      <p className={`text-lg font-bold ${valueClass ?? 'text-white'}`}>{value}</p>
      {sub && <p className="text-[10px] text-zinc-500 mt-0.5">{sub}</p>}
    </div>
  );
}

// ── Main component ───────────────────────────────────────────────────

export default function OptionsPositionsTab() {
  const [dataPoints, setDataPoints]   = useState<DataPoint[]>([]);
  const [legs, setLegs]               = useState<Leg[]>([]);
  const [loading, setLoading]         = useState(true);
  const [error, setError]             = useState<string | null>(null);
  const [pollMs, setPollMs]           = useState<PollMs>(5000);
  const entryPremiumRef               = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const res  = await fetch('/api/options/positions-live');
        const data = await res.json() as ApiResponse;
        if (cancelled) return;

        if (data.error === 'auth') {
          setError('Authentication error — run login.py to refresh the access token.');
          setLoading(false);
          return;
        }
        if (data.error === 'api') {
          setError('Could not reach the Dhan API. Check connectivity.');
          setLoading(false);
          return;
        }

        setLegs(data.legs);
        setLoading(false);
        setError(null);

        if (!data.has_positions) return;

        // lock entry premium to first non-zero value
        if (entryPremiumRef.current === null && data.net_premium !== 0) {
          entryPremiumRef.current = data.net_premium;
        }

        const point: DataPoint = {
          time:       fmtTime(data.timestamp),
          netPremium: data.net_premium,
          vix:        data.vix,
        };
        setDataPoints(prev => [...prev, point]);
      } catch {
        if (!cancelled) setError('Network error fetching positions.');
      }
    }

    poll(); // immediate first call
    const id = setInterval(poll, pollMs);
    return () => { cancelled = true; clearInterval(id); };
  }, [pollMs]); // restart interval when poll rate changes

  // ── Derived values ───────────────────────────────────────────────

  const latest       = dataPoints[dataPoints.length - 1];
  const entryPremium = entryPremiumRef.current;
  const netPremium   = latest?.netPremium ?? 0;
  const vix          = latest?.vix ?? 0;
  const changeFromEntry = entryPremium !== null ? netPremium - entryPremium : null;

  // For a net-sell position, premium decreasing is good (profit)
  // We colour by direction of change relative to entry
  const changeBeneficial = changeFromEntry !== null && changeFromEntry < 0;
  const changeColour = changeFromEntry === null
    ? 'text-zinc-400'
    : changeBeneficial ? 'text-emerald-400' : 'text-red-400';

  // Y axis domain helpers — add 10 % padding
  const premiums = dataPoints.map(d => d.netPremium);
  const vixes    = dataPoints.map(d => d.vix);
  const premiumDomain = premiums.length > 1
    ? [
        Math.floor(Math.min(...premiums) * 0.9),
        Math.ceil(Math.max(...premiums)  * 1.1),
      ]
    : ['auto', 'auto'];
  const vixDomain = vixes.length > 1
    ? [
        Math.floor(Math.min(...vixes) * 0.95 * 10) / 10,
        Math.ceil( Math.max(...vixes) * 1.05 * 10) / 10,
      ]
    : ['auto', 'auto'];

  // ── Render ───────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-400 text-sm">
        <svg className="animate-spin h-5 w-5 mr-2 text-emerald-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z" />
        </svg>
        Loading positions…
      </div>
    );
  }

  if (error) {
    return (
      <div className="mx-2 mt-4 px-4 py-3 bg-red-900/20 border border-red-700/40 rounded-xl text-sm text-red-400">
        {error}
      </div>
    );
  }

  if (!legs.length) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        No open F&amp;O option positions
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">

      {/* Stat row */}
      <div className="flex gap-3 flex-wrap">
        <StatTile
          label="Net Premium"
          value={fmtNum(netPremium)}
          sub={netPremium >= 0 ? 'Net credit' : 'Net debit'}
          valueClass={netPremium >= 0 ? 'text-emerald-400' : 'text-red-400'}
        />
        <StatTile
          label="Change from Entry"
          value={changeFromEntry !== null ? (changeFromEntry >= 0 ? '+' : '') + fmtNum(changeFromEntry) : '—'}
          sub={entryPremium !== null ? `Entry: ${fmtNum(entryPremium)}` : undefined}
          valueClass={changeColour}
        />
        <StatTile
          label="India VIX"
          value={fmtNum(vix)}
          valueClass="text-amber-400"
        />
        <StatTile
          label="Open Legs"
          value={String(legs.length)}
          valueClass="text-zinc-200"
        />
      </div>

      {/* Dual-axis chart */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
        <div className="flex items-center justify-between gap-2 mb-4 flex-wrap">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-bold text-white">Combined Premium vs VIX</h3>
            <span className="px-2 py-0.5 text-[10px] font-bold rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
              LIVE
            </span>
          </div>
          {/* Poll interval selector */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
            {POLL_OPTIONS.map(({ label, ms }) => (
              <button
                key={label}
                onClick={() => setPollMs(ms)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  pollMs === ms
                    ? label === 'Live'
                      ? 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                      : 'bg-zinc-700 text-zinc-200 border border-zinc-600'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {dataPoints.length < 2 ? (
          <div className="flex items-center justify-center h-[420px] text-zinc-500 text-sm">
            Collecting data…
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={420}>
            <ComposedChart data={dataPoints} margin={{ top: 5, right: 60, left: 10, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#27272a" vertical={false} />
              <XAxis
                dataKey="time"
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={{ stroke: '#3f3f46' }}
                tickLine={false}
                minTickGap={60}
              />
              <YAxis
                yAxisId="premium"
                domain={premiumDomain as [number, number]}
                tick={{ fill: '#71717a', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={55}
                tickFormatter={(v: number) => v.toFixed(0)}
              />
              <YAxis
                yAxisId="vix"
                orientation="right"
                domain={vixDomain as [number, number]}
                tick={{ fill: '#f59e0b', fontSize: 11 }}
                axisLine={false}
                tickLine={false}
                width={45}
                tickFormatter={(v: number) => v.toFixed(1)}
              />
              <Tooltip content={<ChartTooltip />} />
              <Legend
                wrapperStyle={{ fontSize: 12, paddingTop: 12 }}
                formatter={(value: string) => (
                  <span style={{ color: '#a1a1aa', fontSize: 11 }}>{value}</span>
                )}
              />

              {entryPremium !== null && (
                <ReferenceLine
                  yAxisId="premium"
                  y={entryPremium}
                  stroke="#ffffff"
                  strokeDasharray="4 3"
                  strokeOpacity={0.4}
                  label={{
                    value: 'Entry',
                    position: 'insideTopLeft',
                    fill: '#a1a1aa',
                    fontSize: 10,
                  }}
                />
              )}

              <Line
                yAxisId="premium"
                type="monotone"
                dataKey="netPremium"
                name="Net Premium"
                stroke="#10b981"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 3 }}
              />
              <Line
                yAxisId="vix"
                type="monotone"
                dataKey="vix"
                name="India VIX"
                stroke="#f59e0b"
                strokeWidth={1.5}
                strokeDasharray="5 3"
                dot={false}
                activeDot={{ r: 3 }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Positions table */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-zinc-800">
              <th className="text-left px-4 py-2.5 text-xs font-bold text-white">Symbol</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Strike</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Type</th>
              <th className="text-center px-4 py-2.5 text-xs font-bold text-white">Side</th>
              <th className="text-right px-4 py-2.5 text-xs font-bold text-white">LTP</th>
              <th className="text-right px-4 py-2.5 text-xs font-bold text-white">Qty</th>
            </tr>
          </thead>
          <tbody>
            {legs.map((leg, i) => (
              <tr key={i} className="border-t border-zinc-800 hover:bg-zinc-800/40 transition-colors">
                <td className="px-4 py-2.5 text-zinc-300 font-mono text-[11px]">{leg.symbol}</td>
                <td className="px-4 py-2.5 text-center text-zinc-200 font-semibold">{leg.strike.toLocaleString('en-IN')}</td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`font-bold ${leg.type === 'CE' ? 'text-blue-400' : 'text-red-400'}`}>
                    {leg.type}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-center">
                  <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                    leg.side === 'SELL'
                      ? 'bg-red-500/10 text-red-400 border border-red-500/20'
                      : 'bg-blue-500/10 text-blue-400 border border-blue-500/20'
                  }`}>
                    {leg.side}
                  </span>
                </td>
                <td className="px-4 py-2.5 text-right text-zinc-200 font-semibold">{fmtNum(leg.ltp)}</td>
                <td className="px-4 py-2.5 text-right text-zinc-400">{leg.netQty}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

    </div>
  );
}
