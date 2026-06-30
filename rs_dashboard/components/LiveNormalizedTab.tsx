'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ReferenceLine,
  ResponsiveContainer,
} from 'recharts';
import type { TooltipContentProps } from 'recharts';
import { Activity, Play, Square, RefreshCw, WifiOff } from 'lucide-react';
import { cn } from '@/lib/utils';

// ─── Types ────────────────────────────────────────────────────────────────────

interface BridgeStatus {
  status: 'STARTING' | 'RUNNING' | 'STOPPED' | 'ERROR';
  pid?: number;
  subscribed?: number;
  started_at?: string;
  last_update?: string;
}

interface IndexHistory {
  session_date: string;
  updated_at: string;
  available: string[];
  labels: Record<string, string>;
  categories: Record<string, string>;
  opens: Record<string, number>;
  ltps: Record<string, number>;
  ticks: Array<Record<string, string | number>>;
}

// ─── Colour palette ───────────────────────────────────────────────────────────
// Fixed order: NIFTY=emerald, BANKNIFTY=violet, then cycling through the rest.

const SYMBOL_ORDER = [
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'NIFTYIT', 'NIFTYINFRA', 'NIFTYNXT50',
  'NIFTY AUTO', 'NIFTY PHARMA', 'NIFTY FMCG', 'NIFTY METAL', 'NIFTY REALTY',
  'NIFTY PSU BANK', 'NIFTY PVT BANK', 'NIFTY ENERGY', 'NIFTY MEDIA',
  'NIFTY HEALTHCARE', 'NIFTY OIL AND GAS', 'NIFTY CONSR DURBL',
  'NIFTY FINSRV25 50', 'NIFTY 100', 'NIFTY 200', 'NIFTY 500',
  'NIFTY MIDCAP 150', 'NIFTY SMALLCAP 100', 'MIDCPNIFTY', 'INDIA VIX',
];

const PALETTE = [
  '#10b981', // emerald-500  — NIFTY
  '#8b5cf6', // violet-500   — BANKNIFTY
  '#06b6d4', // cyan-500
  '#f59e0b', // amber-500
  '#f43f5e', // rose-500
  '#3b82f6', // blue-500
  '#f97316', // orange-500
  '#ec4899', // pink-500
  '#14b8a6', // teal-500
  '#84cc16', // lime-500
  '#6366f1', // indigo-500
  '#ef4444', // red-500
  '#0ea5e9', // sky-500
  '#a855f7', // purple-500
  '#22c55e', // green-500
  '#eab308', // yellow-500
  '#64748b', // slate-500
  '#d946ef', // fuchsia-500
  '#78716c', // stone-500
  '#0d9488', // teal-600
  '#7c3aed', // violet-600
  '#b45309', // amber-700
  '#be123c', // rose-700
];

function colorFor(sym: string): string {
  const idx = SYMBOL_ORDER.indexOf(sym);
  return PALETTE[idx >= 0 ? idx % PALETTE.length : PALETTE.length - 1];
}

const STORAGE_KEY = 'live_normalized_selected_indices';
const PINNED = new Set(['NIFTY', 'BANKNIFTY']);

// ─── Market hours (IST) ───────────────────────────────────────────────────────

const MARKET_OPEN_SECS  = 9 * 3600 + 15 * 60;  // 09:15:00
const MARKET_CLOSE_SECS = 15 * 3600 + 30 * 60; // 15:30:00

// Explicit X-axis ticks every 30 minutes from open to close
const X_AXIS_TICKS: number[] = [];
for (let s = MARKET_OPEN_SECS; s <= MARKET_CLOSE_SECS; s += 30 * 60) X_AXIS_TICKS.push(s);

function istSecs(): number {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60_000;
  const ist   = new Date(utcMs + (5 * 60 + 30) * 60_000);
  return ist.getHours() * 3600 + ist.getMinutes() * 60 + ist.getSeconds();
}

function secsToHHMM(s: number): string {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function timeStrToSecs(t: string): number {
  const [hh, mm, ss] = t.split(':').map(Number);
  return hh * 3600 + mm * 60 + (ss ?? 0);
}

// ─── Custom tooltip ───────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
interface PctTooltipProps extends TooltipContentProps<any, any> {
  opens: Record<string, number>;
  labels: Record<string, string>;
  activeSymbols: string[];
}

function PctTooltip({ active, payload, label, opens, labels, activeSymbols }: PctTooltipProps) {
  if (!active || !payload?.length) return null;

  const entries: { sym: string; pct: number; ltp: number }[] = [];
  for (const sym of activeSymbols) {
    const p = payload.find((e) => e.dataKey === sym);
    if (p?.value !== undefined && opens[sym]) {
      const pct = p.value as number;
      const ltp = opens[sym] * (1 + pct / 100);
      entries.push({ sym, pct, ltp });
    }
  }
  entries.sort((a, b) => b.pct - a.pct);

  return (
    <div className="bg-zinc-900 border border-zinc-700 rounded-lg p-2.5 text-[11px] shadow-xl min-w-[200px]">
      <div className="text-zinc-400 font-semibold mb-1.5 pb-1 border-b border-zinc-800">
        {typeof label === 'number' ? secsToHHMM(label) : String(label)}
      </div>
      {entries.map(({ sym, pct, ltp }) => (
        <div key={sym} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: colorFor(sym) }} />
            <span className="text-zinc-300">{labels[sym] ?? sym}</span>
          </span>
          <span className="flex items-center gap-3 tabular-nums">
            <span className={pct >= 0 ? 'text-emerald-400 font-semibold' : 'text-red-400 font-semibold'}>
              {pct >= 0 ? '+' : ''}{pct.toFixed(2)}%
            </span>
            <span className="text-zinc-500">{ltp.toFixed(2)}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── Micro-components ─────────────────────────────────────────────────────────

function LiveDot({ active }: { active: boolean }) {
  return (
    <span className="relative inline-flex h-2 w-2">
      {active && <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />}
      <span className={cn('relative inline-flex rounded-full h-2 w-2', active ? 'bg-emerald-500' : 'bg-zinc-600')} />
    </span>
  );
}

function IndexChip({
  sym, label, color, selected, pinned, onToggle,
}: {
  sym: string; label: string; color: string; selected: boolean; pinned: boolean; onToggle: () => void;
}) {
  return (
    <button
      onClick={pinned ? undefined : onToggle}
      className={cn(
        'flex items-center gap-1.5 px-2 py-1 rounded-md text-[11px] font-semibold border transition-all',
        pinned
          ? 'border-zinc-600 bg-zinc-800 text-zinc-200 cursor-default'
          : selected
            ? 'border-zinc-600 bg-zinc-800 text-zinc-200 hover:bg-zinc-700'
            : 'border-zinc-800 bg-zinc-950 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400',
      )}
    >
      <span className="w-2 h-2 rounded-full shrink-0" style={{ background: selected ? color : '#52525b' }} />
      {label}
      {pinned && <span className="text-[9px] text-zinc-500 ml-0.5">●</span>}
    </button>
  );
}

// ─── Main component ────────────────────────────────────────────────────────────

export default function LiveNormalizedTab() {
  const [bridgeStatus, setBridgeStatus] = useState<BridgeStatus>({ status: 'STOPPED' });
  const [history, setHistory]           = useState<IndexHistory | null>(null);
  const [selected, setSelected]         = useState<Set<string>>(new Set(PINNED));
  const [actionLoading, setActionLoading] = useState(false);
  const [lastTick, setLastTick]         = useState<Date | null>(null);
  const [currentIST, setCurrentIST]     = useState<number>(istSecs);
  const pollRef                         = useRef<ReturnType<typeof setInterval> | null>(null);
  const initializedRef                  = useRef(false);

  // ── Update IST clock every 30 s for market-hours gating ───────────────────
  useEffect(() => {
    const id = setInterval(() => setCurrentIST(istSecs()), 30_000);
    return () => clearInterval(id);
  }, []);

  // ── Restore selection from localStorage ────────────────────────────────────
  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed: string[] = JSON.parse(stored);
        setSelected(new Set([...PINNED, ...parsed]));
      }
    } catch { /* ignore */ }
  }, []);

  // ── When history first arrives, select all available indices ───────────────
  useEffect(() => {
    if (!history || initializedRef.current) return;
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored && history.available.length > 0) {
      // First ever load — select everything
      setSelected(new Set(history.available));
    }
    initializedRef.current = true;
  }, [history]);

  // ── Poll /api/live-indices ─────────────────────────────────────────────────
  const pollLive = useCallback(async () => {
    try {
      const res  = await fetch('/api/live-indices');
      const json = await res.json();
      if (!json.success) return;
      setBridgeStatus(json.status);
      if (json.history) {
        setHistory(json.history);
        if (json.history.ticks?.length > 0) setLastTick(new Date());
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    pollLive();
    pollRef.current = setInterval(pollLive, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [pollLive]);

  // ── Bridge start / stop ────────────────────────────────────────────────────
  const sendAction = useCallback(async (action: 'start' | 'stop') => {
    setActionLoading(true);
    try {
      await fetch('/api/live-indices', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      setTimeout(pollLive, 1000);
    } catch { /* ignore */ }
    finally { setActionLoading(false); }
  }, [pollLive]);

  // ── Toggle index selection ─────────────────────────────────────────────────
  const toggleIndex = useCallback((sym: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(sym)) next.delete(sym);
      else next.add(sym);
      try {
        const toStore = [...next].filter((s) => !PINNED.has(s));
        localStorage.setItem(STORAGE_KEY, JSON.stringify(toStore));
      } catch { /* ignore */ }
      return next;
    });
  }, []);

  // ── Normalise ticks to % from open; add numeric ts for fixed X-axis ───────
  const pctTicks = useMemo(() => {
    if (!history?.ticks?.length || !history.opens) return [];
    return history.ticks.map((tick) => {
      const t  = tick.t as string;
      const ts = timeStrToSecs(t);
      const entry: Record<string, string | number> = { t, ts };
      for (const sym of history.available) {
        const ltp  = tick[sym] as number | undefined;
        const open = history.opens[sym];
        if (ltp !== undefined && open && open > 0) {
          entry[sym] = parseFloat(((ltp - open) / open * 100).toFixed(4));
        }
      }
      return entry;
    });
  }, [history]);

  const activeSymbols = history
    ? history.available.filter((s) => selected.has(s))
    : [];

  const isLive      = bridgeStatus.status === 'RUNNING';
  const isStarting  = bridgeStatus.status === 'STARTING';
  const staleQuotes = lastTick && (Date.now() - lastTick.getTime() > 15_000);
  const isMarketOpen = currentIST >= MARKET_OPEN_SECS && currentIST <= MARKET_CLOSE_SECS;

  // Group available indices by category
  const byCategory = useMemo(() => {
    if (!history) return {} as Record<string, string[]>;
    const map: Record<string, string[]> = {};
    for (const sym of history.available) {
      const cat = history.categories[sym] ?? 'Other';
      if (!map[cat]) map[cat] = [];
      map[cat].push(sym);
    }
    return map;
  }, [history]);

  return (
    <div className="flex flex-col gap-3">

      {/* ── Bridge controls strip ── */}
      <div className="flex flex-wrap items-center gap-2.5 px-3 py-2 rounded-lg border border-zinc-800 bg-zinc-950">
        <LiveDot active={isLive} />
        <span className={cn(
          'text-[11px] font-medium',
          isLive ? 'text-emerald-400' : isStarting ? 'text-amber-400' : 'text-zinc-500',
        )}>
          {isLive
            ? `Indices feed live · ${bridgeStatus.subscribed ?? 0} subscribed`
            : isStarting ? 'Connecting to indices…'
            : 'Indices feed offline'}
        </span>

        <button
          onClick={() => sendAction(isLive || isStarting ? 'stop' : 'start')}
          disabled={actionLoading}
          className={cn(
            'flex items-center gap-1.5 px-2.5 py-1 rounded-lg border text-[11px] font-semibold transition-all disabled:opacity-50',
            isLive || isStarting
              ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20'
              : 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400 hover:bg-emerald-500/20',
          )}
        >
          {actionLoading
            ? <RefreshCw className="h-3 w-3 animate-spin" />
            : isLive || isStarting
              ? <Square className="h-3 w-3" />
              : <Play className="h-3 w-3" />}
          {isLive || isStarting ? 'Stop Indices Feed' : 'Start Indices Feed'}
        </button>

        {lastTick && (
          <span className={cn('text-[10px] tabular-nums ml-auto hidden md:block', staleQuotes ? 'text-amber-400' : 'text-zinc-600')}>
            {lastTick.toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
          </span>
        )}
        {history && (
          <span className="text-[10px] text-zinc-600 hidden md:block">
            DATA: {isLive ? <span className="text-emerald-500">LIVE</span> : <span className="text-zinc-500">OFFLINE</span>}
          </span>
        )}
      </div>

      {/* ── Offline banner ── */}
      {isMarketOpen && !isLive && !isStarting && (
        <div className="flex flex-wrap items-center gap-2.5 px-3 py-2.5 rounded-lg border border-zinc-700/50 bg-zinc-900/40 text-[12px]">
          <WifiOff className="h-4 w-4 text-zinc-500 shrink-0" />
          <span className="text-zinc-400">Indices WebSocket feed is offline — start the feed to see live normalized charts.</span>
          <button
            onClick={() => sendAction('start')}
            disabled={actionLoading}
            className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/25 font-semibold transition-all disabled:opacity-50"
          >
            <Play className="h-3.5 w-3.5" /> Start Indices Feed
          </button>
        </div>
      )}

      {/* ── Connecting banner ── */}
      {isMarketOpen && isStarting && (
        <div className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-amber-500/25 bg-amber-500/5 text-[12px] text-amber-300">
          <RefreshCw className="h-3.5 w-3.5 animate-spin shrink-0" />
          Connecting to index WebSocket — first ticks usually arrive within 5–10 seconds…
        </div>
      )}

      {/* ── Market closed state ── */}
      {!isMarketOpen && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 flex flex-col items-center justify-center h-[420px] gap-2">
          <Activity className="h-6 w-6 text-zinc-700" />
          <span className="text-zinc-400 text-[13px] font-semibold">
            {currentIST < MARKET_OPEN_SECS ? 'Pre-market' : 'Market Closed'}
          </span>
          <span className="text-zinc-600 text-[11px]">Trading session: 09:15 – 15:30 IST</span>
        </div>
      )}

      {/* ── Index selector grid (market hours only) ── */}
      {isMarketOpen && history && history.available.length > 0 && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 p-3 flex flex-col gap-2.5">
          {Object.entries(byCategory).map(([cat, syms]) => (
            <div key={cat}>
              <div className="text-[9px] font-bold text-zinc-600 uppercase tracking-widest mb-1.5">{cat}</div>
              <div className="flex flex-wrap gap-1.5">
                {syms.map((sym) => (
                  <IndexChip
                    key={sym}
                    sym={sym}
                    label={history.labels[sym] ?? sym}
                    color={colorFor(sym)}
                    selected={selected.has(sym)}
                    pinned={PINNED.has(sym)}
                    onToggle={() => toggleIndex(sym)}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Chart area (market hours only) ── */}
      {isMarketOpen && (
        <div className="rounded-lg border border-zinc-800 bg-zinc-950 overflow-hidden">
          {pctTicks.length < 2 ? (
            <div className="flex flex-col items-center justify-center h-[420px] gap-2">
              {isLive || isStarting
                ? <><RefreshCw className="h-5 w-5 text-zinc-600 animate-spin" /><span className="text-zinc-500 text-[12px]">Waiting for first ticks…</span></>
                : <><Activity className="h-5 w-5 text-zinc-700" /><span className="text-zinc-600 text-[12px]">Start the indices feed to see the chart</span></>
              }
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={420}>
              <LineChart data={pctTicks} margin={{ top: 12, right: 16, left: 0, bottom: 4 }}>
                <XAxis
                  dataKey="ts"
                  type="number"
                  scale="linear"
                  domain={[MARKET_OPEN_SECS, MARKET_CLOSE_SECS]}
                  ticks={X_AXIS_TICKS}
                  tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500 }}
                  tickLine={false}
                  axisLine={{ stroke: '#27272a' }}
                  tickFormatter={(v: number) => secsToHHMM(v)}
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
                  content={(props) => (
                    <PctTooltip
                      {...props}
                      opens={history?.opens ?? {}}
                      labels={history?.labels ?? {}}
                      activeSymbols={activeSymbols}
                    />
                  )}
                />
                {activeSymbols.map((sym) => (
                  <Line
                    key={sym}
                    type="monotone"
                    dataKey={sym}
                    stroke={colorFor(sym)}
                    strokeWidth={1.5}
                    dot={false}
                    isAnimationActive={false}
                    connectNulls
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>
      )}

      {/* ── Footer note ── */}
      {isMarketOpen && pctTicks.length > 1 && (
        <div className="text-[10px] text-zinc-700 text-right px-1">
          {pctTicks.length} ticks · normalised to session open · {activeSymbols.length} of {history?.available.length ?? 0} indices shown
        </div>
      )}
    </div>
  );
}
