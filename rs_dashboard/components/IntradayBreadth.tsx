'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, Legend,
  ResponsiveContainer,
} from 'recharts';
import { Activity, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import NavBar from '@/components/NavBar';

interface Counts { adv: number; decl: number; unch: number }
interface HistoryPoint { time: string; nifty50: Counts; banknifty: Counts }
interface ApiResponse {
  success: boolean;
  date?: string;
  marketOpen?: boolean;
  updatedAt?: string;
  history?: HistoryPoint[];
  latest?: HistoryPoint | null;
  error?: string;
}

const INDICES = ['nifty50', 'banknifty'] as const;
type IndexKey = typeof INDICES[number];

const INDEX_LABELS: Record<IndexKey, string> = {
  nifty50: 'NIFTY 50',
  banknifty: 'BANKNIFTY',
};

const POLL_MS = 60_000;
const START_TIME = '09:15';
const END_TIME = '15:30';

function minutesBetween(start: string, end: string): string[] {
  const res: string[] = [];
  let [sh, sm] = start.split(':').map(Number);
  const [eh, em] = end.split(':').map(Number);
  while (sh < eh || (sh === eh && sm <= em)) {
    res.push(`${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`);
    sm++;
    if (sm >= 60) { sm = 0; sh++; }
  }
  return res;
}

export default function IntradayBreadth() {
  const [data, setData] = useState<ApiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);
  const [selected, setSelected] = useState<IndexKey>('nifty50');

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch('/api/breadth-intraday');
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
    const history = data?.history ?? [];
    if (history.length === 0) return [];

    let endTime = END_TIME;
    const nowIst = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const nowStr = `${String(nowIst.getUTCHours()).padStart(2, '0')}:${String(nowIst.getUTCMinutes()).padStart(2, '0')}`;
    if (data?.marketOpen && nowStr < END_TIME) endTime = nowStr;

    const byTime = new Map(history.map((p) => [p.time, p]));
    return minutesBetween(START_TIME, endTime).map((t) => {
      const p = byTime.get(t);
      return {
        time: t,
        advances: p ? p[selected].adv : undefined,
        declines: p ? p[selected].decl : undefined,
      };
    });
  }, [data, selected]);

  const latest = data?.latest?.[selected];
  const hasAnyData = merged.some((p) => p.advances !== undefined);

  return (
    <div className="bg-zinc-950 min-h-screen flex flex-col">
      {/* Sticky Header */}
      <header className="bg-zinc-900 border-b border-zinc-800 px-4 py-3 flex items-center gap-4 sticky top-0 z-30 flex-wrap">
        <div>
          <div className="text-sm font-bold text-zinc-100 tracking-wide uppercase">Intraday Breadth</div>
          <div className="text-xs text-zinc-500 tracking-widest">Nifty 50 · Bank Nifty · 1-min Advance/Decline</div>
        </div>
        <NavBar />
        <div className="ml-auto flex items-center gap-3">
          {data?.date && (
            <span className="font-mono text-xs bg-zinc-800 text-zinc-400 px-2 py-1 rounded border border-zinc-700">
              DATA: {data.date}
            </span>
          )}
          {data && !data.marketOpen && (
            <span className="text-xs text-amber-500">market closed — showing last session&apos;s history</span>
          )}
          {lastFetch && (
            <span className="text-xs text-zinc-500">
              {lastFetch.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit', hour12: false })} IST
            </span>
          )}
          <button
            onClick={fetchData}
            className="w-8 h-8 flex items-center justify-center bg-zinc-800 border border-zinc-700 rounded hover:border-zinc-600 text-zinc-400 cursor-pointer"
            title="Refresh"
          >
            <RefreshCw size={13} className={loading ? 'animate-spin text-amber-400' : ''} />
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3 p-4">

      {/* Index toggle */}
      <div className="flex gap-2">
        {INDICES.map((idx) => (
          <button
            key={idx}
            type="button"
            onClick={() => setSelected(idx)}
            className={cn(
              'px-3 py-1.5 rounded-lg border text-xs font-bold',
              selected === idx
                ? 'border-emerald-500 bg-emerald-500/10 text-emerald-400'
                : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200',
            )}
          >
            {INDEX_LABELS[idx]}
          </button>
        ))}
      </div>

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="text-[10px] text-zinc-500 uppercase font-bold">Advances</div>
          <div className="text-2xl font-bold text-emerald-400 tabular-nums">{latest ? latest.adv : '—'}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="text-[10px] text-zinc-500 uppercase font-bold">Declines</div>
          <div className="text-2xl font-bold text-red-400 tabular-nums">{latest ? latest.decl : '—'}</div>
        </div>
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 px-4 py-3">
          <div className="text-[10px] text-zinc-500 uppercase font-bold">Unchanged</div>
          <div className="text-2xl font-bold text-zinc-300 tabular-nums">{latest ? latest.unch : '—'}</div>
        </div>
      </div>

      {/* Chart */}
      <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
        {!hasAnyData ? (
          <div className="flex flex-col items-center justify-center h-[500px] gap-2">
            {loading
              ? <><RefreshCw className="h-5 w-5 text-zinc-600 animate-spin" /><span className="text-zinc-500 text-[12px]">Loading breadth history…</span></>
              : <><Activity className="h-5 w-5 text-zinc-700" /><span className="text-zinc-600 text-[12px]">No intraday breadth data available yet</span></>
            }
          </div>
        ) : (
          <ResponsiveContainer width="100%" height={500}>
            <LineChart data={merged} margin={{ top: 12, right: 24, left: 0, bottom: 4 }}>
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
                width={40}
                allowDecimals={false}
              />
              <Tooltip
                contentStyle={{ background: '#18181b', border: '1px solid #3f3f46', borderRadius: 8, fontSize: 12 }}
                labelStyle={{ color: '#a1a1aa' }}
              />
              <Legend
                formatter={(name: string) => (
                  <span style={{ color: '#d4d4d8', fontSize: 12 }}>{name}</span>
                )}
              />
              <Line
                type="monotone"
                dataKey="advances"
                name="Advances"
                stroke="#10b981"
                strokeWidth={1.5}
                dot={{ r: 2, strokeWidth: 0, fill: '#10b981' }}
                isAnimationActive={false}
                connectNulls
              />
              <Line
                type="monotone"
                dataKey="declines"
                name="Declines"
                stroke="#ef4444"
                strokeWidth={1.5}
                dot={{ r: 2, strokeWidth: 0, fill: '#ef4444' }}
                isAnimationActive={false}
                connectNulls
              />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>

      {hasAnyData && (
        <div className="text-[10px] text-zinc-700 text-right px-1">
          {INDEX_LABELS[selected]} · {merged.length} minutes · 09:15–15:30 IST
        </div>
      )}
      </div>
    </div>
  );
}
