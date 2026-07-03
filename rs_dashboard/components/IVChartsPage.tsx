'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import NavBar from './NavBar';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, Legend,
} from 'recharts';

// ─── Types ────────────────────────────────────────────────────────

interface IVDataPoint {
  time: string;
  spot: number;
  CE_LTP: number;   CE_IV: number;   CE_OI: number;
  CE_volume: number; CE_bid: number;  CE_ask: number;
  CE_delta: number;  CE_gamma: number; CE_theta: number; CE_vega: number;
  PE_LTP: number;   PE_IV: number;   PE_OI: number;
  PE_volume: number; PE_bid: number;  PE_ask: number;
  PE_delta: number;  PE_gamma: number; PE_theta: number; PE_vega: number;
}

interface IVHistoryResponse {
  success: boolean;
  date: string;
  atm: number;
  expiry: string;
  strikes: number[];
  selectedStrike: number;
  data: IVDataPoint[];
  error?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────

function fmtNum(n: number, dec = 0): string {
  return n.toLocaleString('en-IN', {
    maximumFractionDigits: dec,
    minimumFractionDigits: dec,
  });
}

const ChartTooltip = ({ active, payload, label }: Record<string, unknown>) => {
  if (!active || !Array.isArray(payload) || !payload.length) return null;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl min-w-[160px] backdrop-blur">
      <p className="text-zinc-400 mb-2 font-semibold tracking-wide">{String(label)}</p>
      {(payload as Array<{ color: string; name: string; value: number }>).map(p => (
        <div key={p.name} className="flex justify-between gap-6 mb-0.5">
          <span style={{ color: p.color }} className="font-semibold">{p.name}</span>
          <span className="tabular-nums text-white font-bold">
            {typeof p.value === 'number' ? `${p.value.toFixed(2)}%` : p.value}
          </span>
        </div>
      ))}
    </div>
  );
};

// ─── Main ─────────────────────────────────────────────────────────

export default function IVChartsPage() {
  const [response, setResponse]             = useState<IVHistoryResponse | null>(null);
  const [selectedStrike, setSelectedStrike] = useState<number | null>(null);
  const [loading, setLoading]               = useState(true);
  const [error, setError]                   = useState('');
  const [showCeIV, setShowCeIV]             = useState(true);
  const [showPeIV, setShowPeIV]             = useState(true);
  const [viewMode, setViewMode]             = useState<'separate' | 'combined'>('separate');
  const pollRef        = useRef<NodeJS.Timeout | null>(null);
  // Ref keeps the interval callback from closing over a stale selectedStrike
  const strikeRef      = useRef<number | null>(null);
  const initializedRef = useRef(false);

  const fetchData = (strike?: number) => {
    const resolved    = strike ?? strikeRef.current;
    const strikeParam = resolved !== null ? `&strike=${resolved}` : '';
    fetch(`/api/options/iv-history?${strikeParam}`)
      .then(r => r.json())
      .then((j: IVHistoryResponse) => {
        if (j.success) {
          setResponse(j);
          setError('');
          // Set strike on first successful load only
          if (!initializedRef.current) {
            initializedRef.current = true;
            strikeRef.current = j.selectedStrike;
            setSelectedStrike(j.selectedStrike);
          }
        } else {
          setError(j.error ?? 'No data');
          setResponse(null);
        }
      })
      .catch(e => setError(String(e)))
      .finally(() => setLoading(false));
  };

  // Initial load + 30-second auto-refresh; interval reads from strikeRef (always current)
  useEffect(() => {
    setLoading(true);
    fetchData();
    pollRef.current = setInterval(() => fetchData(), 30_000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-fetch when strike changes
  const handleStrikeChange = (strike: number) => {
    strikeRef.current = strike;
    setSelectedStrike(strike);
    fetchData(strike);
  };

  const data     = response?.data ?? [];
  const strikes  = response?.strikes ?? [];
  const atm      = response?.atm ?? 0;
  const expiry   = response?.expiry ?? '';
  const dataDate = response?.date ?? '';

  // X-axis ticks every 10 points (~5 min at 30s sampling)
  const xTicks = useMemo(() => {
    if (data.length === 0) return [];
    const result: string[] = [];
    for (let i = 0; i < data.length; i += 10) result.push(data[i].time);
    const last = data[data.length - 1].time;
    if (result[result.length - 1] !== last) result.push(last);
    return result;
  }, [data]);

  const gridProps    = { strokeDasharray: '4 4', stroke: '#27272a', vertical: false };
  const xAxisProps   = {
    dataKey:  'time' as const,
    tick:     { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine: false,
    axisLine: { stroke: '#27272a' },
    ticks:    xTicks,
    tickFormatter: (t: string) => t.slice(0, 5), // HH:MM
  };

  const charts = [
    { key: 'CE_IV' as const, label: 'CE IV', color: '#60a5fa', show: showCeIV, setShow: setShowCeIV,
      badgeCls: 'text-blue-400 border-blue-500/30 bg-blue-500/10' },
    { key: 'PE_IV' as const, label: 'PE IV', color: '#fbbf24', show: showPeIV, setShow: setShowPeIV,
      badgeCls: 'text-amber-400 border-amber-500/30 bg-amber-500/10' },
  ];

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">

      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between gap-3 flex-wrap
                      px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight">IV Charts</h1>
            <p className="text-[10px] text-zinc-400 font-medium">
              Implied Volatility time-series · NIFTY {expiry || '—'}
            </p>
          </div>
          <NavBar />
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          {dataDate && (
            <span className="text-[10px] font-bold text-zinc-400 bg-zinc-800/80 border border-zinc-700 px-2.5 py-1 rounded-full tracking-widest uppercase">
              DATA: {dataDate}
            </span>
          )}

          {/* Combined / Separate toggle */}
          <div className="flex items-center bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
            {(['separate', 'combined'] as const).map(m => (
              <button
                key={m}
                onClick={() => setViewMode(m)}
                className={`px-2.5 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  viewMode === m
                    ? 'bg-zinc-700 text-zinc-200 border border-zinc-600'
                    : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {m === 'separate' ? 'Separate' : 'Combined'}
              </button>
            ))}
          </div>

          {/* Strike selector */}
          {strikes.length > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="text-xs text-zinc-300 font-medium">Strike</span>
              <select
                value={selectedStrike ?? ''}
                onChange={e => handleStrikeChange(Number(e.target.value))}
                className="bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold
                           rounded-lg px-2.5 py-1.5 focus:outline-none focus:border-emerald-500 w-44"
              >
                {strikes.map(sk => (
                  <option key={sk} value={sk}>
                    {fmtNum(sk)}{sk === atm ? '  ← ATM' : ''}
                  </option>
                ))}
              </select>
            </div>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">

        {loading && (
          <div className="flex items-center justify-center h-64 gap-3">
            <div className="w-6 h-6 border-2 border-zinc-700 border-t-zinc-400 rounded-full animate-spin" />
            <p className="text-sm text-zinc-300 font-medium">Loading IV data…</p>
          </div>
        )}

        {!loading && error && (
          <div className="flex flex-col items-center justify-center h-64 gap-3">
            <p className="text-sm text-zinc-400 font-medium text-center max-w-sm">
              {error.includes('No IV snapshot') || error.includes('No data')
                ? 'No IV data for today — start iv_snapshot_collector.py to begin recording'
                : error}
            </p>
            <p className="text-xs text-zinc-600 font-mono">
              python scripts/tools/iv_snapshot_collector.py
            </p>
          </div>
        )}

        {!loading && !error && viewMode === 'combined' && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="flex items-center justify-between mb-3">
              <div>
                <p className="text-sm font-bold text-white tracking-tight">
                  CE IV &amp; PE IV
                  {selectedStrike != null && (
                    <span className="ml-2 text-[10px] font-bold text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-md">
                      {fmtNum(selectedStrike)}{selectedStrike === atm && atm > 0 ? ' ATM' : ''}
                    </span>
                  )}
                </p>
                <p className="text-[10px] text-zinc-400 mt-0.5">
                  sampled every 30s · {data.length} point{data.length !== 1 ? 's' : ''}
                </p>
              </div>
              <div className="flex items-center gap-1.5">
                {charts.map(({ label, show, setShow, badgeCls }) => (
                  <button
                    key={label}
                    onClick={() => setShow(v => !v)}
                    className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition-all ${badgeCls} ${show ? 'opacity-100' : 'opacity-35'}`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            {data.length < 2 ? (
              <div className="flex items-center justify-center h-[420px] text-zinc-500 text-xs">
                {selectedStrike != null
                  ? 'IV chart builds as data accumulates — first point appears within 30s of collector start'
                  : 'Select a strike to view IV'}
              </div>
            ) : (
              <ResponsiveContainer width="100%" height={420}>
                <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis
                    tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                    tickLine={false}
                    axisLine={false}
                    domain={[0, 'auto']}
                    width={40}
                    tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                  />
                  <Tooltip
                    content={<ChartTooltip />}
                    cursor={{ stroke: '#3f3f46', strokeWidth: 1 }}
                  />
                  <Legend
                    wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
                    formatter={(value) => (
                      <span style={{ color: '#a1a1aa', fontWeight: 600 }}>{value}</span>
                    )}
                  />
                  {charts.map(({ key, label, color, show }) => (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      name={label}
                      stroke={color}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
                      hide={!show}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
          </div>
        )}

        {!loading && !error && viewMode === 'separate' && (
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {charts.map(({ key, label, color, show, setShow, badgeCls }) => (
              <div key={key} className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
                <div className="flex items-center justify-between mb-3">
                  <div>
                    <p className="text-sm font-bold text-white tracking-tight">
                      {label}
                      {selectedStrike != null && (
                        <span className="ml-2 text-[10px] font-bold text-zinc-300 bg-zinc-800 px-2 py-0.5 rounded-md">
                          {fmtNum(selectedStrike)}{selectedStrike === atm && atm > 0 ? ' ATM' : ''}
                        </span>
                      )}
                    </p>
                    <p className="text-[10px] text-zinc-400 mt-0.5">
                      sampled every 30s · {data.length} point{data.length !== 1 ? 's' : ''}
                    </p>
                  </div>
                  <button
                    onClick={() => setShow(v => !v)}
                    className={`px-2 py-1 text-[10px] font-bold rounded-lg border transition-all ${badgeCls} ${show ? 'opacity-100' : 'opacity-35'}`}
                  >
                    {label}
                  </button>
                </div>

                {data.length < 2 ? (
                  <div className="flex items-center justify-center h-[420px] text-zinc-500 text-xs">
                    {selectedStrike != null
                      ? 'IV chart builds as data accumulates — first point appears within 30s of collector start'
                      : 'Select a strike to view IV'}
                  </div>
                ) : (
                  <ResponsiveContainer width="100%" height={420}>
                    <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                      <CartesianGrid {...gridProps} />
                      <XAxis {...xAxisProps} />
                      <YAxis
                        tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                        tickLine={false}
                        axisLine={false}
                        domain={[0, 'auto']}
                        width={40}
                        tickFormatter={(v: number) => `${v.toFixed(1)}%`}
                      />
                      <Tooltip
                        content={<ChartTooltip />}
                        cursor={{ stroke: '#3f3f46', strokeWidth: 1 }}
                      />
                      {show && (
                        <Line
                          type="monotone"
                          dataKey={key}
                          name={label}
                          stroke={color}
                          strokeWidth={2}
                          dot={false}
                          activeDot={{ r: 4, fill: color, strokeWidth: 0 }}
                        />
                      )}
                    </LineChart>
                  </ResponsiveContainer>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
