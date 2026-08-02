'use client';

import React, { useEffect, useState, useCallback } from 'react';
import NavBar from '@/components/NavBar';
import FuturesCandleChart from '@/components/FuturesCandleChart';
import OIProfileChart from '@/components/OIProfileChart';
import OIChangeProfileChart from '@/components/OIChangeProfileChart';
import type { NiftyOIProfileResponse } from '@/app/api/nifty-oi-profile/route';
import {
  RefreshCw,
  Calendar,
  BarChart2,
  Table as TableIcon,
} from 'lucide-react';

/** Placeholder for a KPI value that has not arrived yet. Sized in `ch` so it
 *  occupies roughly the width of the number it replaces and the cards do not
 *  reflow when real data lands. */
function Skeleton({ w = '5ch' }: { w?: string }) {
  return (
    <span
      className="inline-block h-4 rounded bg-zinc-800 animate-pulse align-middle"
      style={{ width: w }}
      aria-hidden="true"
    />
  );
}

/** Full-panel loading state for the chart / table region. */
function LoadingPanel({ label }: { label: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 py-16 text-zinc-500">
      <RefreshCw className="w-6 h-6 animate-spin text-emerald-400" />
      <span className="text-xs font-medium">{label}</span>
    </div>
  );
}

function fmtNum(val: number): string {
  if (Math.abs(val) >= 1_00_00_000) {
    return `${(val / 1_00_00_000).toFixed(2)} Cr`;
  }
  if (Math.abs(val) >= 1_00_000) {
    return `${(val / 1_00_000).toFixed(2)} L`;
  }
  if (Math.abs(val) >= 1_000) {
    return `${(val / 1_000).toFixed(1)} K`;
  }
  return val.toLocaleString();
}

export default function NiftyOIProfilePage() {
  const [data, setData] = useState<NiftyOIProfileResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [expiry, setExpiry] = useState<string>('nearest');
  const [step, setStep] = useState<number>(50);
  const [range, setRange] = useState<number>(10);
  const [days, setDays] = useState<number>(3);
  const [autoRefresh, setAutoRefresh] = useState<boolean>(true);
  const [viewTable, setViewTable] = useState<boolean>(false);

  // First paint has nothing to show, so it gets skeletons and a spinner. A refresh
  // that already has data keeps the old values on screen — blanking a populated
  // dashboard every 10s would be worse than showing figures a few seconds stale —
  // and is signalled by the header pill instead.
  const initialLoading = loading && !data;
  const refreshing = loading && !!data;

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const res = await fetch(
        `/api/nifty-oi-profile?expiry=${expiry}&step=${step}&range=${range}&days=${days}`
      );
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      } else {
        setError(json.error ?? 'Failed to load Nifty OI Profile');
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [expiry, step, range, days]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const timer = setInterval(() => {
      fetchData();
    }, 10_000);
    return () => clearInterval(timer);
  }, [autoRefresh, fetchData]);

  const pcr = data?.summary?.pcr ?? 0;
  const pcrSentiment =
    pcr >= 1.2
      ? { label: 'Bullish', color: 'text-emerald-400 bg-emerald-950/60 border-emerald-800' }
      : pcr <= 0.8
      ? { label: 'Bearish', color: 'text-rose-400 bg-rose-950/60 border-rose-800' }
      : { label: 'Neutral', color: 'text-amber-400 bg-amber-950/60 border-amber-800' };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      <NavBar />

      <main className="flex-1 p-4 max-w-[1800px] mx-auto w-full flex flex-col gap-4">
        {/* TOP CONTROL BAR & TITLE */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 p-3.5 rounded-xl shadow-md">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              <BarChart2 className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">NIFTY OI Profile</h1>
                <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-950 text-emerald-400 border border-emerald-800 font-medium">
                  Futures & Options Profile
                </span>
              </div>
              <p className="text-xs text-zinc-400">
                5-Min Futures Chart ({days} Days) with Strike-Aligned OI & Daily Positioning Ladders
              </p>
            </div>
          </div>

          {/* CONTROLS */}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Expiry Selector */}
            <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
              <Calendar className="w-3.5 h-3.5 text-zinc-400" />
              <span className="text-zinc-400">Expiry:</span>
              <select
                value={expiry}
                onChange={(e) => setExpiry(e.target.value)}
                className="bg-transparent text-zinc-100 font-semibold focus:outline-none cursor-pointer"
              >
                <option value="nearest" className="bg-zinc-900 text-emerald-400 font-bold">
                  Next Weekly ({data?.nearest_expiry || 'Nearest'})
                </option>
                <option value="monthly" className="bg-zinc-900 text-amber-400">
                  Current Monthly ({data?.current_monthly_expiry || 'Monthly'})
                </option>

                {data?.expiries?.map((exp) => {
                  const isMonthly = data?.monthly_expiries?.includes(exp);
                  const isNearest = exp === data?.nearest_expiry;
                  return (
                    <option key={exp} value={exp} className="bg-zinc-900 text-zinc-200">
                      {exp} {isNearest ? '⚡ (Next Weekly)' : isMonthly ? '🗓️ (Monthly)' : ''}
                    </option>
                  );
                })}
              </select>
            </div>

            {/* Strike Step Selector */}
            <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
              <span className="text-zinc-400">Step:</span>
              <button
                onClick={() => setStep(100)}
                className={`px-2 py-0.5 rounded font-semibold transition ${
                  step === 100 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                100 pts
              </button>
              <button
                onClick={() => setStep(50)}
                className={`px-2 py-0.5 rounded font-semibold transition ${
                  step === 50 ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                50 pts
              </button>
            </div>

            {/* Strike Range Selector */}
            <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
              <span className="text-zinc-400">Strikes:</span>
              {[10, 15, 20].map((r) => (
                <button
                  key={r}
                  onClick={() => setRange(r)}
                  className={`px-2 py-0.5 rounded font-semibold transition ${
                    range === r ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  ±{r}
                </button>
              ))}
            </div>

            {/* Days Selector */}
            <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
              <span className="text-zinc-400">Chart:</span>
              {[3, 5, 7].map((d) => (
                <button
                  key={d}
                  onClick={() => setDays(d)}
                  className={`px-2 py-0.5 rounded font-semibold transition ${
                    days === d ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {d}D
                </button>
              ))}
            </div>

            {/* Table View Toggle */}
            <button
              onClick={() => setViewTable(!viewTable)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition font-semibold ${
                viewTable
                  ? 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                  : 'bg-zinc-950 text-zinc-300 border-zinc-800 hover:bg-zinc-900'
              }`}
            >
              <TableIcon className="w-3.5 h-3.5" />
              <span>{viewTable ? 'Show Dashboard' : 'Table View'}</span>
            </button>

            {/* Auto-Refresh Toggle */}
            <button
              onClick={() => setAutoRefresh(!autoRefresh)}
              className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border transition font-semibold ${
                autoRefresh
                  ? 'bg-emerald-950/80 text-emerald-400 border-emerald-800'
                  : 'bg-zinc-950 text-zinc-500 border-zinc-800'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${autoRefresh ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
              <span>{autoRefresh ? '10s Auto' : 'Paused'}</span>
            </button>

            {/* Manual Refresh Button */}
            <button
              onClick={() => {
                setLoading(true);
                fetchData();
              }}
              disabled={loading}
              className="flex items-center gap-1.5 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-zinc-950 font-bold px-3 py-1.5 rounded-lg transition"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
              <span>Refresh</span>
            </button>
          </div>
        </div>

        {/* ERROR ALERT */}
        {error && (
          <div className="bg-rose-950/80 border border-rose-800 text-rose-200 p-3 rounded-xl text-xs flex items-center justify-between">
            <span>⚠️ {error}</span>
            <button onClick={fetchData} className="underline font-bold hover:text-rose-100">
              Retry
            </button>
          </div>
        )}

        {/* SUMMARY KPI CARDS */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
          {/* Futures Price */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 p-3 rounded-xl flex flex-col justify-between">
            <span className="text-[11px] text-zinc-400 font-medium">NIFTY Futures LTP</span>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-lg font-extrabold text-zinc-100 font-mono">
                {initialLoading ? <Skeleton w="8ch" /> : (data?.futures_price ? data.futures_price.toFixed(2) : '—')}
              </span>
              <span className="text-[10px] text-zinc-400 font-mono">
                Spot: {initialLoading ? <Skeleton w="7ch" /> : (data?.spot_price ? data.spot_price.toFixed(2) : '—')}
              </span>
            </div>
          </div>

          {/* ATM Strike */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 p-3 rounded-xl flex flex-col justify-between">
            <span className="text-[11px] text-zinc-400 font-medium">ATM Strike</span>
            <div className="flex items-baseline justify-between mt-1">
              <span className="text-lg font-extrabold text-amber-400 font-mono">
                {initialLoading ? <Skeleton w="6ch" /> : (data?.atm_strike ?? '—')}
              </span>
              <span className="text-[10px] text-zinc-400">Step: {step}</span>
            </div>
          </div>

          {/* PCR (Put-Call Ratio) */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 p-3 rounded-xl flex flex-col justify-between">
            <span className="text-[11px] text-zinc-400 font-medium">PCR (Put-Call Ratio)</span>
            <div className="flex items-center justify-between mt-1">
              <span className="text-lg font-extrabold text-zinc-100 font-mono">
                {initialLoading ? <Skeleton w="4ch" /> : pcr}
              </span>
              {!initialLoading && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${pcrSentiment.color}`}>
                  {pcrSentiment.label}
                </span>
              )}
            </div>
          </div>

          {/* Call vs Put Open Interest */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 p-3 rounded-xl flex flex-col justify-between">
            <span className="text-[11px] text-zinc-400 font-medium">Total Open Interest</span>
            <div className="flex items-center justify-between mt-1 text-xs font-mono">
              <span className="text-emerald-400 font-semibold">CE: {initialLoading ? <Skeleton w="6ch" /> : fmtNum(data?.summary?.total_call_oi ?? 0)}</span>
              <span className="text-rose-400 font-semibold">PE: {initialLoading ? <Skeleton w="6ch" /> : fmtNum(data?.summary?.total_put_oi ?? 0)}</span>
            </div>
          </div>

          {/* Daily OI Change */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 p-3 rounded-xl flex flex-col justify-between">
            <span className="text-[11px] text-zinc-400 font-medium">Daily OI Change</span>
            <div className="flex items-center justify-between mt-1 text-xs font-mono">
              <span className="text-emerald-400 font-semibold">CE: {initialLoading ? <Skeleton w="6ch" /> : fmtNum(data?.summary?.total_call_oi_change ?? 0)}</span>
              <span className="text-rose-400 font-semibold">PE: {initialLoading ? <Skeleton w="6ch" /> : fmtNum(data?.summary?.total_put_oi_change ?? 0)}</span>
            </div>
          </div>

          {/* Resistance & Support */}
          <div className="bg-zinc-900/60 border border-zinc-800/80 p-3 rounded-xl flex flex-col justify-between">
            <span className="text-[11px] text-zinc-400 font-medium">Key Levels (Max OI)</span>
            <div className="flex items-center justify-between mt-1 text-xs font-mono">
              <span className="text-emerald-400 font-bold" title="Resistance Level (Max Call OI)">
                RES: {initialLoading ? <Skeleton w="6ch" /> : (data?.summary?.resistance_level ?? '—')}
              </span>
              <span className="text-rose-400 font-bold" title="Support Level (Max Put OI)">
                SUP: {initialLoading ? <Skeleton w="6ch" /> : (data?.summary?.support_level ?? '—')}
              </span>
            </div>
          </div>
        </div>

        {/* MAIN DASHBOARD CONTENT */}
        {viewTable ? (
          /* TABULAR DETAILED BREAKDOWN VIEW */
          <div className="bg-zinc-900/60 border border-zinc-800 p-4 rounded-xl overflow-x-auto shadow-inner">
            <h2 className="text-sm font-bold text-zinc-200 mb-3 flex items-center gap-2">
              <TableIcon className="w-4 h-4 text-emerald-400" />
              Granular Strike Breakdown — Expiry: {data?.chosen_expiry}
            </h2>
            {initialLoading ? (
              <LoadingPanel label="Loading strike breakdown…" />
            ) : (
            <table className="w-full text-xs text-left font-mono">
              <thead className="bg-zinc-950 text-zinc-400 uppercase text-[10px] border-b border-zinc-800">
                <tr>
                  <th className="py-2 px-3 text-right">Call IV</th>
                  <th className="py-2 px-3 text-right">Call Vol</th>
                  <th className="py-2 px-3 text-right">Call OI Chg</th>
                  <th className="py-2 px-3 text-right">Call OI</th>
                  <th className="py-2 px-3 text-right">Call LTP</th>
                  <th className="py-2 px-3 text-center bg-zinc-900 text-amber-400 font-bold">Strike</th>
                  <th className="py-2 px-3 text-left">Put LTP</th>
                  <th className="py-2 px-3 text-left">Put OI</th>
                  <th className="py-2 px-3 text-left">Put OI Chg</th>
                  <th className="py-2 px-3 text-left">Put Vol</th>
                  <th className="py-2 px-3 text-left">Put IV</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60">
                {data?.strike_profiles?.map((row) => (
                  <tr
                    key={row.strike}
                    className={row.is_atm ? 'bg-amber-950/40 text-amber-200 font-bold' : 'hover:bg-zinc-900/80 text-zinc-300'}
                  >
                    <td className="py-1.5 px-3 text-right text-zinc-400">{row.ce_iv}%</td>
                    <td className="py-1.5 px-3 text-right">{fmtNum(row.ce_volume)}</td>
                    <td className={`py-1.5 px-3 text-right font-semibold ${row.ce_oi_change >= 0 ? 'text-emerald-400' : 'text-slate-400'}`}>
                      {fmtNum(row.ce_oi_change)}
                    </td>
                    <td className="py-1.5 px-3 text-right text-emerald-400 font-bold">{fmtNum(row.ce_oi)}</td>
                    <td className="py-1.5 px-3 text-right">{row.ce_ltp}</td>
                    <td className="py-1.5 px-3 text-center font-bold bg-zinc-900 text-zinc-100">{row.strike}</td>
                    <td className="py-1.5 px-3 text-left">{row.pe_ltp}</td>
                    <td className="py-1.5 px-3 text-left text-rose-400 font-bold">{fmtNum(row.pe_oi)}</td>
                    <td className={`py-1.5 px-3 text-left font-semibold ${row.pe_oi_change >= 0 ? 'text-rose-400' : 'text-slate-400'}`}>
                      {fmtNum(row.pe_oi_change)}
                    </td>
                    <td className="py-1.5 px-3 text-left">{fmtNum(row.pe_volume)}</td>
                    <td className="py-1.5 px-3 text-left text-zinc-400">{row.pe_iv}%</td>
                  </tr>
                ))}
              </tbody>
            </table>
            )}
          </div>
        ) : (
          /* THREE-COLUMN DASHBOARD GRID (50% / 25% / 25%) */
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 flex-1 min-h-[580px]">
            {/* COLUMN 1 (50% width / lg:col-span-6): Futures 5-Min Chart */}
            <div className="lg:col-span-6 flex flex-col">
              {initialLoading ? (
                <div className="flex-1 bg-zinc-900/60 border border-zinc-800 rounded-xl flex items-center justify-center">
                  <LoadingPanel label="Loading 5-min futures candles…" />
                </div>
              ) : (
                <FuturesCandleChart candles={data?.candles ?? []} symbolName="NIFTY Futures" />
              )}
            </div>

            {/* COLUMN 2 (25% width / lg:col-span-3): Open Interest Profile */}
            <div className="lg:col-span-3 flex flex-col">
              {initialLoading ? (
                <div className="flex-1 bg-zinc-900/60 border border-zinc-800 rounded-xl flex items-center justify-center">
                  <LoadingPanel label="Loading OI profile…" />
                </div>
              ) : (
                <OIProfileChart
                  strikes={data?.strike_profiles ?? []}
                  atmStrike={data?.atm_strike ?? 0}
                  maxCallOiStrike={data?.summary?.max_call_oi_strike}
                  maxPutOiStrike={data?.summary?.max_put_oi_strike}
                />
              )}
            </div>

            {/* COLUMN 3 (25% width / lg:col-span-3): Daily OI Change Profile */}
            <div className="lg:col-span-3 flex flex-col">
              {initialLoading ? (
                <div className="flex-1 bg-zinc-900/60 border border-zinc-800 rounded-xl flex items-center justify-center">
                  <LoadingPanel label="Loading OI change ladder…" />
                </div>
              ) : (
                <OIChangeProfileChart
                  strikes={data?.strike_profiles ?? []}
                  atmStrike={data?.atm_strike ?? 0}
                />
              )}
            </div>
          </div>
        )}

        {/* FOOTER */}
        <div className="flex flex-wrap items-center justify-between text-[11px] text-zinc-500 border-t border-zinc-800/80 pt-3">
          <span className="flex items-center gap-2">
            Data updated: <strong className="text-zinc-400 font-mono">{data?.last_updated ?? '—'}</strong>
            {refreshing && (
              <span className="flex items-center gap-1 text-emerald-400">
                <RefreshCw className="w-3 h-3 animate-spin" /> updating…
              </span>
            )}
          </span>
          <span>Dhan API Options & Futures Stream</span>
        </div>
      </main>
    </div>
  );
}
