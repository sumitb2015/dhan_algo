'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, Legend,
  ResponsiveContainer,
} from 'recharts';
import { Activity, RefreshCw, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CandlePoint { time: string; close: number; pct: number }
interface ApiResponse {
  success: boolean;
  data_date?: string;
  is_today?: boolean;
  series?: Record<string, CandlePoint[]>;
  errors?: Record<string, string>;
  error?: string;
}

const SYMBOLS = [
  'NIFTY', 'NIFTY_FUT', 'HDFCBANK', 'RELIANCE', 'ICICIBANK',
  'BHARTIARTL', 'INFY', 'LT', 'ITC', 'SBIN', 'TCS', 'AXISBANK'
] as const;
type Symbol = typeof SYMBOLS[number];

const COLORS: Record<Symbol, string> = {
  NIFTY: '#10b981',       // emerald-500
  NIFTY_FUT: '#06b6d4',   // cyan-500
  HDFCBANK: '#3b82f6',    // blue-500
  RELIANCE: '#8b5cf6',    // violet-500
  ICICIBANK: '#f59e0b',   // amber-500
  BHARTIARTL: '#ec4899',  // pink-500
  INFY: '#eab308',        // yellow-500
  LT: '#14b8a6',         // teal-500
  ITC: '#a855f7',         // purple-500
  SBIN: '#ef4444',        // red-500
  TCS: '#84cc16',        // lime-500
  AXISBANK: '#0ea5e9',    // sky-500
};

const LABELS: Record<Symbol, string> = {
  NIFTY: 'Nifty 50',
  NIFTY_FUT: 'Nifty Fut',
  HDFCBANK: 'HDFC Bank',
  RELIANCE: 'Reliance',
  ICICIBANK: 'ICICI Bank',
  BHARTIARTL: 'Bharti Airtel',
  INFY: 'Infosys',
  LT: 'L&T',
  ITC: 'ITC',
  SBIN: 'SBI',
  TCS: 'TCS',
  AXISBANK: 'Axis Bank',
};

const POLL_MS = 45_000;

export default function NormalizedIntradayStocksTab() {
  const [data, setData]           = useState<ApiResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res  = await fetch('/api/live-normalized-1min-stocks');
      const json: ApiResponse = await res.json();
      setData(json);
      setLastFetch(new Date());
    } catch {
      /* keep last good data on transient network errors */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
    const id = setInterval(fetchData, POLL_MS);
    return () => clearInterval(id);
  }, [fetchData]);

  const merged = useMemo(() => {
    if (!data?.series) return [];
    
    // 1. Gather all unique time strings from the fetched series
    const allTimes = new Set<string>();
    for (const sym of SYMBOLS) {
      (data.series[sym] ?? []).forEach((p) => allTimes.add(p.time));
    }
    const sortedFetchedTimes = [...allTimes].sort();

    // 2. Determine startTime and endTime
    let startTime = '09:15';
    if (sortedFetchedTimes.length > 0 && sortedFetchedTimes[0] < startTime) {
      startTime = sortedFetchedTimes[0];
    }
    
    let endTime = '15:30';
    if (sortedFetchedTimes.length > 0 && sortedFetchedTimes[sortedFetchedTimes.length - 1] > endTime) {
      endTime = sortedFetchedTimes[sortedFetchedTimes.length - 1];
    }

    if (data.is_today) {
      const getISTTimeStr = (): string => {
        const d = new Date();
        return d.toLocaleTimeString('en-US', {
          timeZone: 'Asia/Kolkata',
          hour: '2-digit',
          minute: '2-digit',
          hour12: false,
        });
      };
      const istNow = getISTTimeStr();
      const maxLimit = '15:30';
      const targetEnd = istNow > maxLimit ? maxLimit : istNow;
      if (targetEnd > startTime) {
        endTime = targetEnd;
      } else {
        endTime = startTime;
      }
    }

    // 3. Generate all minutes in sequence from startTime to endTime
    const minutesBetween = (start: string, end: string): string[] => {
      const res: string[] = [];
      let [sh, sm] = start.split(':').map(Number);
      const [eh, em] = end.split(':').map(Number);
      
      while (sh < eh || (sh === eh && sm <= em)) {
        const hh = String(sh).padStart(2, '0');
        const mm = String(sm).padStart(2, '0');
        res.push(`${hh}:${mm}`);
        sm++;
        if (sm >= 60) {
          sm = 0;
          sh++;
        }
      }
      return res;
    };
    
    const timeRange = minutesBetween(startTime, endTime);

    // 4. Map existing series data points by symbol and time
    const bySymTime: Record<string, Map<string, number>> = {};
    for (const sym of SYMBOLS) {
      bySymTime[sym] = new Map((data.series[sym] ?? []).map((p) => [p.time, p.pct]));
    }

    // 5. Build the final merged array containing every minute in the range
    return timeRange.map((t) => {
      const row: Record<string, string | number> = { time: t };
      for (const sym of SYMBOLS) {
        const v = bySymTime[sym].get(t);
        if (v !== undefined) row[sym] = v;
      }
      return row;
    });
  }, [data]);

  const lastPct = (sym: Symbol): number | null => {
    const s = data?.series?.[sym];
    return s && s.length > 0 ? s[s.length - 1].pct : null;
  };

  const hasAnyData = merged.length > 0;
  const availableSymbols = SYMBOLS.filter((s) => (data?.series?.[s]?.length ?? 0) > 0);

  // Find the last index in the merged array for each symbol
  const lastIndices = useMemo(() => {
    const res: Record<Symbol, number> = {
      NIFTY: -1, NIFTY_FUT: -1, HDFCBANK: -1, RELIANCE: -1, ICICIBANK: -1,
      BHARTIARTL: -1, INFY: -1, LT: -1, ITC: -1, SBIN: -1, TCS: -1, AXISBANK: -1
    };
    for (const sym of SYMBOLS) {
      for (let i = merged.length - 1; i >= 0; i--) {
        if (merged[i][sym] !== undefined) {
          res[sym] = i;
          break;
        }
      }
    }
    return res;
  }, [merged]);

  const renderLastLabel = useCallback((sym: Symbol) => (props: any) => {
    const { x, y, value, index } = props;
    const lastIndex = lastIndices[sym];
    if (index !== lastIndex || value === undefined || value === null) {
      return null;
    }
    const valStr = `${value >= 0 ? '+' : ''}${Number(value).toFixed(2)}%`;
    const rectWidth = valStr.length * 6.8 + 8;
    return (
      <g>
        <rect
          x={x + 5}
          y={y - 9}
          width={rectWidth}
          height={17}
          rx={3}
          fill="#09090b"
          stroke={COLORS[sym]}
          strokeWidth={1}
          opacity={0.85}
        />
        <text
          x={x + 9}
          y={y + 3.5}
          fill={COLORS[sym]}
          fontSize={11}
          fontWeight="bold"
          fontFamily="monospace"
        >
          {valStr}
        </text>
      </g>
    );
  }, [lastIndices]);

  return (
    <div className="flex flex-col gap-3">
      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-950">
        <Activity className="h-3.5 w-3.5 text-violet-400" />
        <span className="text-[11px] font-medium text-zinc-300">
          1-Min Normalized · Stocks &amp; Indices Comparison
        </span>
        <span className="text-[10px] text-zinc-700 font-mono">poll every {POLL_MS / 1000}s</span>

        {data?.data_date && (
          <span className="text-[10px] text-zinc-600">
            DATA: {data.data_date}{data.is_today ? '' : ' (last session)'}
          </span>
        )}

        {lastFetch && (
          <span className="text-[10px] text-zinc-600 tabular-nums ml-auto hidden md:block">
            fetched {lastFetch.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}

        {loading && <RefreshCw className="h-3 w-3 text-zinc-600 animate-spin" />}
      </div>

      {/* Per-symbol legend / status badges */}
      <div className="flex flex-wrap gap-2">
        {SYMBOLS.map((sym) => {
          const pct = lastPct(sym);
          const err = data?.errors?.[sym];
          return (
            <div
              key={sym}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg border border-zinc-800 bg-zinc-950"
            >
              <span className="w-2 h-2 rounded-full shrink-0" style={{ background: COLORS[sym] }} />
              <span className="text-[11px] text-zinc-300 font-medium">{LABELS[sym]}</span>
              {pct !== null ? (
                <span className={cn(
                  'text-[11px] font-semibold tabular-nums',
                  pct >= 0 ? 'text-emerald-400' : 'text-red-400',
                )}>
                  {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
                </span>
              ) : (
                <span className="text-[11px] text-zinc-600">—</span>
              )}
              {err && (
                <span title={err}>
                  <AlertTriangle className="h-3 w-3 text-amber-500" />
                </span>
              )}
            </div>
          );
        })}
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        {!hasAnyData ? (
          <div className="flex flex-col items-center justify-center h-[600px] gap-2">
            {loading
              ? <><RefreshCw className="h-5 w-5 text-zinc-600 animate-spin" /><span className="text-zinc-500 text-[12px]">Loading intraday candles…</span></>
              : <><Activity className="h-5 w-5 text-zinc-700" /><span className="text-zinc-600 text-[12px]">No intraday data available</span></>
            }
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={600}>
            <LineChart data={merged} margin={{ top: 12, right: 64, left: 0, bottom: 4 }}>
              <XAxis
                dataKey="time"
                tick={{ fontSize: 11, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={{ stroke: '#27272a' }}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis
                tick={{ fontSize: 11, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={false}
                width={56}
                tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}
                domain={['auto', 'auto']}
              />
              <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="4 2" />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#a1a1aa' }}
                formatter={((value: any, name: string) => [
                  value !== undefined ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '',
                  LABELS[name as Symbol] ?? name,
                ]) as any}
              />
              <Legend
                formatter={(name: string) => (
                  <span style={{ color: '#d4d4d8', fontSize: 12 }}>{LABELS[name as Symbol] ?? name}</span>
                )}
              />
              {availableSymbols.map((sym) => (
                <Line
                  key={sym}
                  type="monotone"
                  dataKey={sym}
                  name={sym}
                  stroke={COLORS[sym]}
                  strokeWidth={1.5}
                  dot={false}
                  isAnimationActive={false}
                  connectNulls={false}
                  label={renderLastLabel(sym)}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {hasAnyData && (
        <div className="text-[10px] text-zinc-700 text-right px-1">
          {merged.length} candles · Nifty, Future &amp; Stocks compared to previous close
        </div>
      )}
    </div>
  );
}
