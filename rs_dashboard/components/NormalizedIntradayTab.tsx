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

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'CRUDEOILM'] as const;
type Symbol = typeof SYMBOLS[number];

const COLORS: Record<Symbol, string> = {
  NIFTY: '#10b981',
  BANKNIFTY: '#8b5cf6',
  CRUDEOILM: '#f59e0b',
};

const LABELS: Record<Symbol, string> = {
  NIFTY: 'Nifty 50',
  BANKNIFTY: 'Nifty Bank',
  CRUDEOILM: 'Crude Oil Mini',
};

const POLL_MS = 45_000;

export default function NormalizedIntradayTab() {
  const [data, setData]           = useState<ApiResponse | null>(null);
  const [loading, setLoading]     = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res  = await fetch('/api/live-normalized-1min');
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
      const maxLimit = '23:30';
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

  return (
    <div className="flex flex-col gap-3">
      {/* Header strip */}
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-950">
        <Activity className="h-3.5 w-3.5 text-violet-400" />
        <span className="text-[11px] font-medium text-zinc-300">
          1-Min Normalized · NIFTY / BANKNIFTY / CRUDEOILM
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
            <LineChart data={merged} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
              <XAxis
                dataKey="time"
                tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={{ stroke: '#27272a' }}
                interval="preserveStartEnd"
                minTickGap={40}
              />
              <YAxis
                tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                tickLine={false}
                axisLine={false}
                width={52}
                tickFormatter={(v: number) => `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`}
                domain={['auto', 'auto']}
              />
              <ReferenceLine y={0} stroke="#3f3f46" strokeDasharray="4 2" />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 11 }}
                labelStyle={{ color: '#a1a1aa' }}
                formatter={((value: any, name: string) => [
                  value !== undefined ? `${value >= 0 ? '+' : ''}${value.toFixed(2)}%` : '',
                  LABELS[name as Symbol] ?? name,
                ]) as any}
              />
              <Legend
                formatter={(name: string) => (
                  <span style={{ color: '#d4d4d8', fontSize: 11 }}>{LABELS[name as Symbol] ?? name}</span>
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
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {hasAnyData && (
        <div className="text-[10px] text-zinc-700 text-right px-1">
          {merged.length} candles · Nifty &amp; Bank Nifty compared to previous close, Crude Oil compared to session open
        </div>
      )}
    </div>
  );
}
