'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { FOCUS_RING } from '@/components/Scalper';

type Tick = { t: number; v: number };
type Daily = { date: string; close: number };

const POLL_MS = 15_000;
const RANGES = [{ k: '1M', d: 22 }, { k: '3M', d: 66 }, { k: '6M', d: 130 }, { k: '1Y', d: 250 }] as const;
const istDay = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(0, 10);
const hhmm = (ms: number) => new Date(ms + 5.5 * 3600_000).toISOString().slice(11, 16);
const storeKey = (day: string) => `mlf-vix-ticks-${day}`;

function loadTicks(day: string): Tick[] {
  try { const a = JSON.parse(localStorage.getItem(storeKey(day)) || '[]'); return Array.isArray(a) ? a : []; } catch { return []; }
}

/** India VIX monitor: live ticks for today (polled, kept in this browser) and the daily history from the repo CSV. */
export default function VixChartPanel() {
  const [view, setView] = useState<'live' | 'daily'>('live');
  const [range, setRange] = useState<number>(66);
  const [ticks, setTicks] = useState<Tick[]>([]);
  const [prev, setPrev] = useState<number | null>(null);
  const [stale, setStale] = useState(false);
  const [daily, setDaily] = useState<Daily[]>([]);
  const dayRef = useRef('');

  const poll = useCallback(async () => {
    try {
      const j = await (await fetch('/api/scalper/vix', { cache: 'no-store' })).json() as { success: boolean; vix?: number; prevClose?: number; stale?: boolean };
      if (!j.success || !(j.vix && j.vix > 0)) return;
      setPrev(j.prevClose ?? null);
      setStale(!!j.stale);
      if (j.stale) return; // CSV fallback is yesterday's close, not a tick
      const now = Date.now();
      const day = istDay(now);
      setTicks(old => {
        const base = dayRef.current === day ? old : loadTicks(day);
        dayRef.current = day;
        const next = [...base, { t: now, v: j.vix! }].slice(-2000);
        try { localStorage.setItem(storeKey(day), JSON.stringify(next)); } catch { /* storage is a convenience only */ }
        return next;
      });
    } catch { /* keep the last reading */ }
  }, []);

  useEffect(() => {
    const first = setTimeout(poll, 0);
    const id = setInterval(poll, POLL_MS);
    return () => { clearTimeout(first); clearInterval(id); };
  }, [poll]);

  useEffect(() => {
    fetch('/api/vix-history?days=250').then(r => r.json())
      .then((j: { success: boolean; rows: { date: string; close: number }[] }) => { if (j.success) setDaily(j.rows); })
      .catch(() => {});
  }, []);

  const last = ticks.length ? ticks[ticks.length - 1].v : (daily.length ? daily[daily.length - 1].close : null);
  const chg = last != null && prev ? last - prev : null;
  const chgPct = chg != null && prev ? (chg / prev) * 100 : null;
  const liveData = useMemo(() => ticks.map(t => ({ x: hhmm(t.t), v: t.v })), [ticks]);
  const dailyData = useMemo(() => daily.slice(-range).map(r => ({ x: r.date.slice(5), v: r.close })), [daily, range]);
  const data = view === 'live' ? liveData : dailyData;
  const vals = data.map(d => d.v);
  const lo = vals.length ? Math.floor(Math.min(...vals, prev ?? Infinity) * 10) / 10 - 0.2 : 0;
  const hi = vals.length ? Math.ceil(Math.max(...vals, prev ?? -Infinity) * 10) / 10 + 0.2 : 1;

  const btn = (on: boolean) => `h-7 px-2.5 text-[11px] font-bold ${on ? 'bg-zinc-700 text-white' : 'bg-zinc-900 text-zinc-400 hover:text-white'} ${FOCUS_RING}`;

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-3 flex flex-col gap-2">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-zinc-100">India VIX</span>
          <span className="font-mono font-bold tabular-nums text-sm text-zinc-100">{last != null ? last.toFixed(2) : '—'}</span>
          {chg != null && chgPct != null && (
            <span className={`font-mono tabular-nums text-xs font-bold ${chg >= 0 ? 'text-red-400' : 'text-emerald-400'}`}>
              {chg >= 0 ? '+' : ''}{chg.toFixed(2)} ({chgPct >= 0 ? '+' : ''}{chgPct.toFixed(2)}%)
            </span>
          )}
          {stale && <span className="text-[10px] text-amber-400">last close (no live feed)</span>}
        </div>
        <div className="flex items-center gap-2">
          {view === 'daily' && (
            <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden" role="group" aria-label="Range">
              {RANGES.map(r => <button key={r.k} type="button" aria-pressed={range === r.d} onClick={() => setRange(r.d)} className={btn(range === r.d)}>{r.k}</button>)}
            </div>
          )}
          <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden" role="group" aria-label="VIX view">
            <button type="button" aria-pressed={view === 'live'} onClick={() => setView('live')} className={btn(view === 'live')}>Today</button>
            <button type="button" aria-pressed={view === 'daily'} onClick={() => setView('daily')} className={btn(view === 'daily')}>Daily</button>
          </div>
        </div>
      </div>
      <div className="h-[220px]">
        {data.length < 2 ? (
          <p className="text-xs text-zinc-500 text-center py-16">
            {view === 'live' ? 'Collecting live VIX ticks (every 15 s while this tab is open)…' : 'No daily VIX history.'}
          </p>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="x" minTickGap={40} />
              <YAxis domain={[lo, hi]} width={42} tickFormatter={(v: number) => v.toFixed(1)} />
              <Tooltip formatter={(v) => [Number(v).toFixed(2), 'VIX']} />
              {view === 'live' && prev ? <ReferenceLine y={prev} strokeDasharray="4 4" label={{ value: `prev ${prev.toFixed(2)}`, position: 'insideTopLeft', fontSize: 10 }} /> : null}
              <Line type="monotone" dataKey="v" stroke="var(--color-amber-400)" strokeWidth={2} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}
