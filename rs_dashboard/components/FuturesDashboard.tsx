'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import NavBar from '@/components/NavBar';
import { Activity, RefreshCw, AlertCircle, Loader2, Download } from 'lucide-react';
import type { ContractStats, FuturesResponse } from '@/app/api/futures/route';
import type { FuturesRefreshStatus } from '@/app/api/futures-refresh/route';
import OIBuildupDashboard from '@/components/OIBuildupDashboard';

// ─── Formatters ───────────────────────────────────────────────────────────────

function fmtPrice(v: number): string {
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtLakh(v: number): string {
  if (v >= 10000000) return (v / 10000000).toFixed(2) + 'Cr';
  if (v >= 100000)   return (v / 100000).toFixed(1) + 'L';
  if (v >= 1000)     return (v / 1000).toFixed(1) + 'K';
  return v.toFixed(0);
}

function fmtChange(v: number): string {
  return (v >= 0 ? '+' : '-') + fmtLakh(Math.abs(v));
}

function fmtBasis(v: number | null): string {
  if (v === null) return '—';
  return (v >= 0 ? '+' : '') + v.toFixed(2);
}

function oiChangeColor(v: number): string {
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-400';
}

function basisColor(v: number | null): string {
  if (v === null) return 'text-zinc-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}

function cocColor(v: number | null): string {
  if (v === null) return 'text-zinc-500';
  if (v > 0) return 'text-emerald-400';
  if (v < 0) return 'text-red-400';
  return 'text-zinc-300';
}

function dteColor(days: number): string {
  if (days <= 5) return 'text-red-400';
  if (days <= 15) return 'text-amber-400';
  return 'text-zinc-300';
}

function dteChipClass(days: number): string {
  if (days <= 5) return 'bg-red-500/10 text-red-400 border-red-500/20';
  if (days <= 15) return 'bg-amber-500/10 text-amber-400 border-amber-500/20';
  return 'bg-zinc-800 text-zinc-400 border-zinc-700';
}

// ─── SummaryCard ──────────────────────────────────────────────────────────────

function SummaryCard({ name, contracts }: { name: string; contracts: ContractStats[] }) {
  const near = contracts[0];
  if (!near) {
    return (
      <div className="flex-1 min-w-[260px] rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 flex items-center justify-center text-zinc-600 text-sm">
        No {name} data
      </div>
    );
  }

  type OIDir = 'building' | 'unwinding' | 'neutral' | 'nodata';
  const oiDir: OIDir = !near.oiHasData ? 'nodata'
    : near.oiChange > 0 ? 'building'
    : near.oiChange < 0 ? 'unwinding'
    : 'neutral';

  const oiBadge: Record<OIDir, { label: string; cls: string }> = {
    building:  { label: '▲ Building',  cls: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' },
    unwinding: { label: '▼ Unwinding', cls: 'bg-red-500/10 text-red-400 border-red-500/20' },
    neutral:   { label: '— Neutral',   cls: 'bg-zinc-800 text-zinc-400 border-zinc-700' },
    nodata:    { label: '— No OI',     cls: 'bg-zinc-800 text-zinc-500 border-zinc-700' },
  };
  const badge = oiBadge[oiDir];

  return (
    <div className="flex-1 min-w-[260px] rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-zinc-100">{name}</span>
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${dteChipClass(near.daysToExpiry)}`}>
          {near.daysToExpiry}d to expiry
        </span>
      </div>
      <div className="text-2xl font-bold tabular-nums text-white">{fmtPrice(near.price)}</div>
      <div className="flex items-center gap-2 flex-wrap">
        {near.basis !== null && (
          <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
            near.basis > 0 ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
            : near.basis < 0 ? 'bg-red-500/10 text-red-400 border-red-500/20'
            : 'bg-zinc-800 text-zinc-400 border-zinc-700'
          }`}>
            Basis {fmtBasis(near.basis)}
          </span>
        )}
        <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${badge.cls}`}>
          {badge.label}
        </span>
      </div>
    </div>
  );
}

// ─── ContractTable ────────────────────────────────────────────────────────────

function ContractTable({ name, contracts }: { name: string; contracts: ContractStats[] }) {
  const labels = ['Near', 'Mid', 'Far'];
  const showBasisCoc = name === 'NIFTY';
  const thCls  = 'px-3 py-2 text-xs font-bold text-white whitespace-nowrap text-left';
  const thRCls = 'px-3 py-2 text-xs font-bold text-white whitespace-nowrap text-right';

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full text-[12px] border-collapse">
        <thead>
          <tr className="bg-zinc-800">
            <th className={thCls}>Contract</th>
            <th className={thRCls}>Price</th>
            <th className={thRCls}>Open</th>
            <th className={thRCls}>High</th>
            <th className={thRCls}>Low</th>
            <th className={thRCls}>Volume</th>
            <th className={thRCls}>OI (contracts)</th>
            <th className={thRCls}>OI Δ</th>
            {showBasisCoc && <th className={thRCls}>Basis</th>}
            {showBasisCoc && <th className={thRCls}>CoC % p.a.</th>}
            <th className={thRCls}>DTE</th>
          </tr>
        </thead>
        <tbody>
          {contracts.slice(0, 3).map((c, i) => (
            <tr key={c.expiry} className="border-t border-zinc-800/50 hover:bg-zinc-800/30 transition-colors">
              <td className="px-3 py-2.5">
                <span className="font-semibold text-zinc-100">{c.label}</span>
                <span className="ml-2 text-[10px] text-zinc-500">{labels[i] ?? ''}</span>
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums font-bold text-zinc-100">
                {fmtPrice(c.price)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">
                {fmtPrice(c.open)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-emerald-400">
                {fmtPrice(c.high)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-red-400">
                {fmtPrice(c.low)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-zinc-300">
                {fmtLakh(c.volume)}
              </td>
              <td className="px-3 py-2.5 text-right tabular-nums text-zinc-200">
                {c.oiHasData ? fmtLakh(c.oi) : '—'}
              </td>
              <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${
                c.oiHasData ? oiChangeColor(c.oiChange) : 'text-zinc-600'
              }`}>
                {c.oiHasData ? fmtChange(c.oiChange) : '—'}
              </td>
              {showBasisCoc && (
                <td className={`px-3 py-2.5 text-right tabular-nums ${basisColor(c.basis)}`}>
                  {fmtBasis(c.basis)}
                </td>
              )}
              {showBasisCoc && (
                <td className={`px-3 py-2.5 text-right tabular-nums font-semibold ${cocColor(c.coc)}`}>
                  {c.coc !== null
                    ? (c.coc >= 0 ? '+' : '') + c.coc.toFixed(2) + '%'
                    : '—'}
                </td>
              )}
              <td className={`px-3 py-2.5 text-right tabular-nums ${dteColor(c.daysToExpiry)}`}>
                {c.daysToExpiry}d
              </td>
            </tr>
          ))}
          {contracts.length === 0 && (
            <tr>
              <td colSpan={showBasisCoc ? 11 : 9}
                className="px-3 py-8 text-center text-zinc-600 text-[11px]">
                No contract data
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}


// ─── CoC Callout ──────────────────────────────────────────────────────────────

function CoCCallout({ contracts }: { contracts: ContractStats[] }) {
  const items = contracts
    .slice(0, 3)
    .map((c, i) => ({ label: ['Near', 'Mid', 'Far'][i] ?? c.label, coc: c.coc }))
    .filter(item => item.coc !== null) as { label: string; coc: number }[];

  if (items.length === 0) return null;

  return (
    <div className="flex items-center gap-6 flex-wrap text-[11px] px-1">
      {items.map(item => (
        <span key={item.label} className="flex items-center gap-1">
          <span className="text-zinc-500">{item.label}-month CoC:</span>
          <span className={`font-semibold ${cocColor(item.coc)}`}>
            {(item.coc >= 0 ? '+' : '') + item.coc.toFixed(2)}% p.a.
          </span>
          <span className="text-zinc-600">
            ({item.coc > 0 ? 'contango' : item.coc < 0 ? 'backwardation' : 'at par'})
          </span>
        </span>
      ))}
    </div>
  );
}

// ─── InstrumentSection ────────────────────────────────────────────────────────

function InstrumentSection({ name, contracts }: { name: string; contracts: ContractStats[] }) {
  return (
    <section className="border-t border-zinc-800 pt-6">
      <div className="flex items-center gap-3 mb-4">
        <div className="h-5 border-l-2 border-sky-500" />
        <h2 className="text-sm font-bold text-zinc-100">{name} Futures</h2>
        <span className="text-[10px] text-zinc-600 font-medium">{contracts.length} contracts</span>
      </div>
      <div className="space-y-3">
        <ContractTable name={name} contracts={contracts} />
        {name === 'NIFTY' && <CoCCallout contracts={contracts} />}
      </div>
    </section>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

export default function FuturesDashboard() {
  const [data, setData]         = useState<FuturesResponse | null>(null);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);
  const [dlStatus, setDlStatus] = useState<FuturesRefreshStatus | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res  = await fetch('/api/futures');
      const json: FuturesResponse = await res.json();
      if (!json.success) throw new Error(json.error ?? 'API error');
      setData(json);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  const pollDownload = useCallback(async () => {
    try {
      const res  = await fetch('/api/futures-refresh');
      const json: FuturesRefreshStatus = await res.json();
      setDlStatus(json);
      if (!json.running && json.done) {
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        fetchData();
        setRefreshKey(k => k + 1);
      }
    } catch { /* ignore */ }
  }, [fetchData]);

  const startDownload = useCallback(async () => {
    try {
      const res = await fetch('/api/futures-refresh', { method: 'POST' });
      if (!res.ok) return;
      setDlStatus({ running: true, done: false, message: 'Starting…', error: null });
      if (pollRef.current) clearInterval(pollRef.current);
      pollRef.current = setInterval(pollDownload, 2000);
    } catch { /* ignore */ }
  }, [pollDownload]);

  useEffect(() => {
    fetchData();
    pollDownload();
  }, [fetchData, pollDownload]);

  useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

  return (
    <div className="flex flex-col min-h-screen bg-black text-zinc-100">

      {/* Sticky header */}
      <header className="sticky top-0 w-full border-b border-zinc-900 bg-zinc-950/60 backdrop-blur-md px-5 py-3 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="h-9 w-9 rounded-xl bg-gradient-to-tr from-sky-600 to-cyan-400 flex items-center justify-center shadow-lg shadow-sky-500/10">
            <Activity className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-base font-bold tracking-tight bg-gradient-to-r from-white via-zinc-200 to-zinc-500 bg-clip-text text-transparent leading-none">
              Futures Monitor
            </h1>
            {data?.dataDate && (
              <p className="text-[10px] text-zinc-400 font-medium mt-0.5">
                DATA: {data.dataDate}
              </p>
            )}
          </div>
        </div>

        <NavBar />

        <div className="ml-auto flex items-center gap-2">
          {dlStatus?.running ? (
            <div className="flex items-center gap-1.5 text-[11px] text-sky-400">
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              <span>{dlStatus.message || 'Downloading…'}</span>
            </div>
          ) : (
            <button
              onClick={startDownload}
              className="flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-semibold rounded-lg border border-sky-500/25 bg-sky-500/10 text-sky-400 hover:bg-sky-500/15 hover:border-sky-500/35 transition-all"
              title="Download fresh futures data (runs download_futures_manual.py)"
            >
              <Download className="h-3 w-3" />
              Download Data
            </button>
          )}
          <button
            onClick={fetchData}
            disabled={loading}
            className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-400 hover:text-white transition-all hover:border-zinc-700 disabled:opacity-40"
            title="Reload from disk"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </header>

      {/* Body */}
      <main className="flex-1 px-5 py-6 max-w-screen-2xl mx-auto w-full">
        {loading ? (
          <div className="flex items-center justify-center py-32 gap-2 text-zinc-400">
            <Loader2 className="h-5 w-5 animate-spin" />
            <span className="text-sm">Loading futures data…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center py-32 gap-3 text-red-400">
            <AlertCircle className="h-8 w-8" />
            <span className="text-sm text-center max-w-md">{error}</span>
          </div>
        ) : data ? (
          <div className="space-y-0">

            {/* Summary strip */}
            <div className="flex gap-4 flex-wrap pb-6">
              <SummaryCard name="NIFTY"     contracts={data.instruments.NIFTY} />
              <SummaryCard name="BANKNIFTY" contracts={data.instruments.BANKNIFTY} />
            </div>

            {/* NIFTY instrument section */}
            <InstrumentSection name="NIFTY" contracts={data.instruments.NIFTY} />

            {/* BANKNIFTY instrument section */}
            <InstrumentSection name="BANKNIFTY" contracts={data.instruments.BANKNIFTY} />

            {/* OI Buildup */}
            <section className="border-t border-zinc-800 pt-6 mt-0">
              <div className="flex items-center gap-3 mb-4">
                <div className="h-5 border-l-2 border-sky-500" />
                <h2 className="text-sm font-bold text-zinc-100">Stock Futures — OI Buildup</h2>
              </div>
              <OIBuildupDashboard refreshKey={refreshKey} />
            </section>

          </div>
        ) : null}
      </main>
    </div>
  );
}
