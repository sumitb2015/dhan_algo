'use client';

import React, { useState, useEffect, useRef, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid,
  Tooltip, Legend, ResponsiveContainer,
} from 'recharts';

// ─── Types (mirrored from OptionsCharts.tsx) ──────────────────────

interface OptionSide  { ltp: number; oi: number; volume: number }
interface StrikeData  { strike: number; ce: OptionSide; pe: OptionSide }

interface HistoryPoint {
  timestamp: string;
  spot: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
}

interface LiveQuotes {
  updated_at: string | null;
  spot: number;
  atm: number;
  straddle_premium: number;
  strikes: Record<string, StrikeData>;
}

interface CandleRow {
  time: string;
  'CE LTP': number;
  'PE LTP': number;
  Straddle: number;
  'CE Vol'?: number;
  'PE Vol'?: number;
  'CE OI'?: number;
  'PE OI'?: number;
}

interface Props {
  expiry: string;
  isLive: boolean;
  quotes: LiveQuotes | null;
  history: HistoryPoint[];
  candleInterval: '1' | '5';
  atm: number;
  candleIsToday?: boolean;
}

// ─── Constants ────────────────────────────────────────────────────

const STEP  = 50;  // NIFTY strike step
const WINGS = 5;   // ATM ± WINGS chips shown

const PALETTE = [
  '#60a5fa', // blue-400
  '#f87171', // red-400
  '#34d399', // emerald-400
  '#fbbf24', // amber-400
  '#a78bfa', // violet-400
  '#fb923c', // orange-400
  '#2dd4bf', // teal-400
  '#e879f9', // fuchsia-400
  '#818cf8', // indigo-400
  '#f472b6', // pink-400
];

// ─── Helpers ──────────────────────────────────────────────────────

function fmtOI(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(1)}Cr`;
  if (n >= 100_000)    return `${(n / 100_000).toFixed(1)}L`;
  return n.toLocaleString('en-IN');
}

function fmtTime(iso: string): string {
  try {
    return new Date(iso).toLocaleTimeString('en-IN', {
      hour: '2-digit', minute: '2-digit',
    });
  } catch {
    return iso.slice(11, 16);
  }
}

type MergedRow = Record<string, number | string>;

// ─── Custom tooltip ───────────────────────────────────────────────

function OITooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ color: string; name: string; value: number }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-zinc-950/95 border border-zinc-700/60 rounded-xl px-3.5 py-2.5 text-xs shadow-2xl min-w-[180px] backdrop-blur">
      <p className="text-zinc-400 mb-2 font-semibold tracking-wide">{label}</p>
      {payload.map(p => (
        <div key={p.name} className="flex justify-between gap-6 mb-0.5">
          <span style={{ color: p.color }} className="font-semibold">{p.name}</span>
          <span className="tabular-nums text-white font-bold">{fmtOI(Number(p.value))}</span>
        </div>
      ))}
    </div>
  );
}

// ─── Chart Loading / Empty State ──────────────────────────────────

function ChartPlaceholder({ isLive, isLoading, hasStrikes }: { isLive: boolean; isLoading: boolean; hasStrikes: boolean }) {
  if (!hasStrikes) {
    return (
      <div className="flex items-center justify-center h-[360px]">
        <p className="text-sm text-zinc-400 font-medium">Select strikes above to view OI charts</p>
      </div>
    );
  }
  if (isLoading || (isLive && !isLoading)) {
    return (
      <div className="flex flex-col items-center justify-center h-[360px] gap-2">
        <div className={`w-6 h-6 border-2 rounded-full animate-spin ${
          isLive ? 'border-emerald-700 border-t-emerald-400' : 'border-zinc-700 border-t-zinc-400'
        }`} />
        <p className="text-sm text-zinc-300 font-medium">
          {isLive ? 'Waiting for live history…' : 'Loading OI data…'}
        </p>
      </div>
    );
  }
  return (
    <div className="flex items-center justify-center h-[360px]">
      <p className="text-sm text-zinc-400 font-medium">No OI data available for selected strikes</p>
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────

export default function OptionsMultiStrikeTab({
  expiry, isLive, quotes, history, candleInterval, atm, candleIsToday,
}: Props) {
  const [selectedStrikes, setSelectedStrikes] = useState<Set<number>>(new Set());
  const [strikeCandleData, setStrikeCandleData] = useState<Record<string, CandleRow[]>>({});
  const [viewMode, setViewMode] = useState<'combined' | 'split'>('combined');

  // Tracks in-flight fetches keyed by "expiry:interval:strike" — avoids state churn.
  const fetchingRef = useRef<Set<string>>(new Set());

  // Derive ATM from quotes if atm prop is 0 (parent may not have chain data yet in live mode)
  const effectiveAtm = atm > 0 ? atm : (quotes?.atm ?? 0);

  // Strike chips: ATM ± WINGS
  const chipStrikes = useMemo<number[]>(() => {
    if (effectiveAtm <= 0) return [];
    return Array.from({ length: WINGS * 2 + 1 }, (_, i) => effectiveAtm + (i - WINGS) * STEP);
  }, [effectiveAtm]);

  // Initialize selection once ATM is known
  useEffect(() => {
    if (effectiveAtm <= 0 || selectedStrikes.size > 0) return;
    setSelectedStrikes(new Set([
      effectiveAtm - 2 * STEP,
      effectiveAtm - STEP,
      effectiveAtm,
      effectiveAtm + STEP,
      effectiveAtm + 2 * STEP,
    ]));
  }, [effectiveAtm, selectedStrikes.size]);

  // Clear candle cache when expiry or interval changes
  useEffect(() => {
    setStrikeCandleData({});
    fetchingRef.current.clear();
  }, [expiry, candleInterval]);

  // Fetch candles for selected strikes not yet cached (non-live mode)
  useEffect(() => {
    if (isLive || !expiry) return;

    const toFetch = [...selectedStrikes].filter(sk => {
      const key = `${expiry}:${candleInterval}:${sk}`;
      return !strikeCandleData[String(sk)] && !fetchingRef.current.has(key);
    });
    if (!toFetch.length) return;

    toFetch.forEach(sk => fetchingRef.current.add(`${expiry}:${candleInterval}:${sk}`));

    Promise.all(
      toFetch.map(sk =>
        fetch(`/api/options/candles?expiry=${expiry}&strike=${sk}&interval=${candleInterval}`)
          .then(r => r.json())
          .then((j: { success: boolean; data?: CandleRow[] }) => ({
            strike: sk,
            rows: (j.success && j.data) ? j.data : ([] as CandleRow[]),
          }))
          .catch(() => ({ strike: sk, rows: [] as CandleRow[] }))
      )
    ).then(results => {
      setStrikeCandleData(prev => {
        const next = { ...prev };
        results.forEach(({ strike, rows }) => { next[String(strike)] = rows; });
        return next;
      });
    });
  }, [selectedStrikes, isLive, expiry, candleInterval, strikeCandleData]);

  // Poll/refresh candle data when not live and viewing today's data
  useEffect(() => {
    if (isLive || !expiry || !candleIsToday) return;

    const ms = parseInt(candleInterval, 10) * 60_000;
    const intervalId = setInterval(() => {
      const strikesToFetch = [...selectedStrikes];
      if (!strikesToFetch.length) return;

      Promise.all(
        strikesToFetch.map(sk =>
          fetch(`/api/options/candles?expiry=${expiry}&strike=${sk}&interval=${candleInterval}`)
            .then(r => r.json())
            .then((j: { success: boolean; data?: CandleRow[] }) => ({
              strike: sk,
              rows: (j.success && j.data) ? j.data : ([] as CandleRow[]),
            }))
            .catch(() => ({ strike: sk, rows: [] as CandleRow[] }))
        )
      ).then(results => {
        setStrikeCandleData(prev => {
          const next = { ...prev };
          results.forEach(({ strike, rows }) => {
            if (rows.length > 0) {
              next[String(strike)] = rows;
            }
          });
          return next;
        });
      });
    }, ms);

    return () => clearInterval(intervalId);
  }, [selectedStrikes, isLive, expiry, candleInterval, candleIsToday]);

  // Sorted selected strikes (stable order for consistent color assignment)
  const orderedStrikes = useMemo(
    () => [...selectedStrikes].sort((a, b) => a - b),
    [selectedStrikes]
  );

  // Build merged chart dataset
  const chartData = useMemo<MergedRow[]>(() => {
    if (orderedStrikes.length === 0) return [];

    if (isLive) {
      return history.map(h => {
        const row: MergedRow = { time: fmtTime(h.timestamp) };
        for (const sk of orderedStrikes) {
          const side = h.strikes[String(sk)];
          row[`${sk}_CE_OI`] = side?.ce?.oi ?? 0;
          row[`${sk}_PE_OI`] = side?.pe?.oi ?? 0;
        }
        return row;
      });
    }

    // Non-live: merge candle arrays keyed by time
    const timeMap = new Map<string, MergedRow>();
    for (const sk of orderedStrikes) {
      const rows = strikeCandleData[String(sk)] ?? [];
      for (const row of rows) {
        if (!timeMap.has(row.time)) timeMap.set(row.time, { time: row.time });
        const merged = timeMap.get(row.time)!;
        merged[`${sk}_CE_OI`] = row['CE OI'] ?? 0;
        merged[`${sk}_PE_OI`] = row['PE OI'] ?? 0;
      }
    }
    return [...timeMap.values()].sort((a, b) =>
      String(a.time).localeCompare(String(b.time))
    );
  }, [orderedStrikes, isLive, history, strikeCandleData]);

  const hasData     = chartData.length > 1;
  const isLoading   = !isLive && orderedStrikes.some(sk => !strikeCandleData[String(sk)]);
  const xTickCount  = chartData.length > 0 ? Math.max(0, Math.floor(chartData.length / 10) - 1) : 0;

  const xAxisProps = {
    dataKey: 'time' as const,
    tick: { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine: false,
    axisLine: { stroke: '#27272a' },
    interval: xTickCount,
  };
  const gridProps   = { strokeDasharray: '4 4', stroke: '#27272a', vertical: false };
  const tooltipEl   = <OITooltip />;
  const tooltipProps = { content: tooltipEl, cursor: { stroke: '#3f3f46', strokeWidth: 1 } };

  const yAxisProps = {
    tick: { fontSize: 10, fill: '#a1a1aa', fontWeight: 500 as const },
    tickLine: false,
    axisLine: false as const,
    domain: ['auto', 'auto'] as const,
    width: 56,
    tickFormatter: fmtOI,
  };

  const makeLegendFormatter = (suffix: '_CE_OI' | '_PE_OI') =>
    (v: string) => {
      const sk = v.replace(suffix, '');
      const label = `${Number(sk).toLocaleString('en-IN')}${Number(sk) === effectiveAtm ? ' ATM' : ''}`;
      return <span style={{ color: '#d4d4d8', fontWeight: 600 }}>{label}</span>;
    };

  const combinedLegendFormatter = (v: string) => {
    const isCE = v.includes('_CE_OI');
    const sk = v.replace('_CE_OI', '').replace('_PE_OI', '');
    const idx = orderedStrikes.indexOf(Number(sk));
    const color = idx >= 0 ? PALETTE[idx % PALETTE.length] : '#a1a1aa';
    const label = `${Number(sk).toLocaleString('en-IN')}${Number(sk) === effectiveAtm ? ' ATM' : ''} ${isCE ? 'CE' : 'PE'}`;
    return <span style={{ color, fontWeight: 700 }}>{label}</span>;
  };

  const legendProps = { wrapperStyle: { fontSize: 11, paddingTop: 12 } };

  const toggleStrike = (sk: number) => {
    setSelectedStrikes(prev => {
      const next = new Set(prev);
      if (next.has(sk)) next.delete(sk); else next.add(sk);
      return next;
    });
  };

  // ── Render ────────────────────────────────────────────────────────
  return (
    <div className="flex flex-col gap-5">

      {/* Strike selector */}
      <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-4 flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span className="text-xs font-bold text-zinc-300 uppercase tracking-widest">Select Strikes</span>
          <div className="flex items-center gap-3">
            {/* View mode toggle */}
            <div className="flex items-center bg-zinc-800 border border-zinc-700 p-0.5 rounded-lg">
              {(['combined', 'split'] as const).map(mode => (
                <button
                  key={mode}
                  onClick={() => setViewMode(mode)}
                  className={`px-2.5 py-1 text-[10px] font-bold rounded-md capitalize transition-all ${
                    viewMode === mode
                      ? 'bg-zinc-600 text-zinc-100 border border-zinc-500'
                      : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-[10px] font-semibold text-zinc-400">
              <button onClick={() => setSelectedStrikes(new Set(chipStrikes))}
                className="hover:text-zinc-200 transition-all">All</button>
              <span className="text-zinc-700">·</span>
              <button onClick={() => setSelectedStrikes(new Set())}
                className="hover:text-zinc-200 transition-all">Clear</button>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {chipStrikes.map((sk) => {
            const isSelected = selectedStrikes.has(sk);
            const isAtm = sk === effectiveAtm;
            const colorIdx = orderedStrikes.indexOf(sk);
            const color = isSelected && colorIdx >= 0
              ? PALETTE[colorIdx % PALETTE.length]
              : undefined;

            return (
              <button
                key={sk}
                onClick={() => toggleStrike(sk)}
                className={`px-2.5 py-1 text-xs font-bold rounded-lg border transition-all ${
                  isSelected
                    ? 'border-transparent text-zinc-950'
                    : 'bg-zinc-800 border-zinc-700 text-zinc-400 hover:text-zinc-200 hover:border-zinc-500'
                }`}
                style={color ? { backgroundColor: color } : undefined}
              >
                {sk.toLocaleString('en-IN')}
                {isAtm && (
                  <span className={`ml-1 text-[9px] font-extrabold uppercase ${
                    isSelected ? 'opacity-70' : 'text-zinc-300'
                  }`}>ATM</span>
                )}
              </button>
            );
          })}
        </div>

        {/* Color legend */}
        {orderedStrikes.length > 0 && (
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 pt-1 border-t border-zinc-800">
            {orderedStrikes.map((sk, i) => (
              <div key={sk} className="flex items-center gap-1.5">
                <div
                  className="w-5 h-0.5 rounded-full"
                  style={{ backgroundColor: PALETTE[i % PALETTE.length] }}
                />
                <span className="text-[10px] text-zinc-400 font-medium">
                  {sk.toLocaleString('en-IN')}{sk === effectiveAtm ? ' (ATM)' : ''}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      {viewMode === 'combined' ? (
        /* ── Combined chart: CE (solid) + PE (dashed) per strike, same color ── */
        <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
          <div className="flex items-center justify-between mb-4">
            <div>
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-white tracking-tight">CE &amp; PE Open Interest</p>
                <span className="text-[10px] font-semibold text-zinc-400 bg-zinc-800 border border-zinc-700 px-2 py-0.5 rounded-md">
                  solid = CE · dashed = PE
                </span>
              </div>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                {isLive ? 'Live WebSocket' : `${candleInterval}m candles`} · NIFTY {expiry || '—'}
              </p>
            </div>
          </div>

          {hasData && orderedStrikes.length > 0 ? (
            <ResponsiveContainer width="100%" height={460}>
              <LineChart data={chartData} margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid {...gridProps} />
                <XAxis {...xAxisProps} />
                <YAxis {...yAxisProps} />
                <Tooltip {...tooltipProps} />
                <Legend {...legendProps} formatter={combinedLegendFormatter} />
                {orderedStrikes.map((sk, i) => {
                  const color = PALETTE[i % PALETTE.length];
                  return [
                    <Line
                      key={`${sk}_CE_OI`}
                      type="monotone"
                      dataKey={`${sk}_CE_OI`}
                      stroke={color}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0, fill: color }}
                    />,
                    <Line
                      key={`${sk}_PE_OI`}
                      type="monotone"
                      dataKey={`${sk}_PE_OI`}
                      stroke={color}
                      strokeWidth={1.5}
                      strokeDasharray="5 3"
                      dot={false}
                      activeDot={{ r: 3, strokeWidth: 0, fill: color }}
                    />,
                  ];
                })}
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <ChartPlaceholder isLive={isLive} isLoading={isLoading} hasStrikes={orderedStrikes.length > 0} />
          )}
        </div>
      ) : (
        /* ── Split charts: CE OI top, PE OI bottom ── */
        <>
          {/* CE OI */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-white tracking-tight">CE Open Interest</p>
                <span className="text-[10px] font-bold text-blue-400 bg-blue-500/10 border border-blue-500/20 px-2 py-0.5 rounded-md">
                  Call OI
                </span>
              </div>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                {isLive ? 'Live WebSocket' : `${candleInterval}m candles`} · NIFTY {expiry || '—'}
              </p>
            </div>

            {hasData && orderedStrikes.length > 0 ? (
              <ResponsiveContainer width="100%" height={360}>
                <LineChart data={chartData} syncId="multiStrike" margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis {...yAxisProps} />
                  <Tooltip {...tooltipProps} />
                  <Legend {...legendProps} formatter={makeLegendFormatter('_CE_OI')} />
                  {orderedStrikes.map((sk, i) => (
                    <Line
                      key={`${sk}_CE_OI`}
                      type="monotone"
                      dataKey={`${sk}_CE_OI`}
                      stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0, fill: PALETTE[i % PALETTE.length] }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ChartPlaceholder isLive={isLive} isLoading={isLoading} hasStrikes={orderedStrikes.length > 0} />
            )}
          </div>

          {/* PE OI */}
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-2xl p-5">
            <div className="mb-4">
              <div className="flex items-center gap-2">
                <p className="text-sm font-bold text-white tracking-tight">PE Open Interest</p>
                <span className="text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-0.5 rounded-md">
                  Put OI
                </span>
              </div>
              <p className="text-[10px] text-zinc-400 mt-0.5">
                {isLive ? 'Live WebSocket' : `${candleInterval}m candles`} · NIFTY {expiry || '—'}
              </p>
            </div>

            {hasData && orderedStrikes.length > 0 ? (
              <ResponsiveContainer width="100%" height={360}>
                <LineChart data={chartData} syncId="multiStrike" margin={{ top: 8, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid {...gridProps} />
                  <XAxis {...xAxisProps} />
                  <YAxis {...yAxisProps} />
                  <Tooltip {...tooltipProps} />
                  <Legend {...legendProps} formatter={makeLegendFormatter('_PE_OI')} />
                  {orderedStrikes.map((sk, i) => (
                    <Line
                      key={`${sk}_PE_OI`}
                      type="monotone"
                      dataKey={`${sk}_PE_OI`}
                      stroke={PALETTE[i % PALETTE.length]}
                      strokeWidth={2}
                      dot={false}
                      activeDot={{ r: 4, strokeWidth: 0, fill: PALETTE[i % PALETTE.length] }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            ) : (
              <ChartPlaceholder isLive={isLive} isLoading={isLoading} hasStrikes={orderedStrikes.length > 0} />
            )}
          </div>
        </>
      )}

    </div>
  );
}
