'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import NavBar from '@/components/NavBar';
import type { NiftyTimeAnalysisResponse, NiftyTimeAnalysisRow } from '@/app/api/nifty-time-analysis/route';
import { Clock, Play, Square, RefreshCw, Info } from 'lucide-react';

const INTERVALS = [1, 3, 5, 15, 30] as const;
type Interval = (typeof INTERVALS)[number];

const POLL_MS = 15_000;

function todayIst(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return ist.toISOString().slice(0, 10);
}

/** The collector's own market-hours gate (09:00–15:30 IST) exits within the
 *  first loop iteration outside that window, flipping straight back to
 *  STOPPED — so Start must be disabled (with a reason) rather than silently
 *  doing nothing, which is exactly what looked like a dead button. */
function isMarketHoursIst(): boolean {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  return mins >= 9 * 60 && mins < 15 * 60 + 30;
}

function statusReasonText(reason?: string): string | null {
  switch (reason) {
    case 'market_closed':
      return 'Collector exited immediately — it only runs 09:00–15:30 IST.';
    case 'stop_trigger':
      return 'Stopped manually.';
    case 'error':
      return 'Collector crashed — check debug/nifty_time_analysis_collector.log.';
    default:
      return null;
  }
}

/** Up/down/flat arrow, colored — the repeated "value + trend" cell used across
 *  most columns in this table. */
function DirCell({ value, dir, decimals = 2 }: { value: number; dir: -1 | 0 | 1; decimals?: number }) {
  const color = dir === 1 ? 'text-emerald-400' : dir === -1 ? 'text-rose-400' : 'text-amber-400';
  const glyph = dir === 1 ? '↑' : dir === -1 ? '↓' : '→';
  return (
    <span className="inline-flex items-center gap-1 font-mono tabular-nums">
      <span className="text-zinc-100">{value.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</span>
      <span className={`${color} font-bold`}>{glyph}</span>
    </span>
  );
}

const BIAS_COLOR: Record<string, string> = {
  'Long Build-up': 'text-emerald-400',
  'Short Covering': 'text-sky-400',
  'Short Build-up': 'text-rose-400',
  'Long Unwinding': 'text-rose-400',
  'Long Unwinding (Weak Bearish)': 'text-rose-400',
  Neutral: 'text-amber-400',
  Bullish: 'text-emerald-400',
  Bearish: 'text-rose-400',
  'Follow OI bias': 'text-zinc-300',
  '#N/A': 'text-zinc-600',
};

function biasColor(label: string): string {
  return BIAS_COLOR[label] ?? 'text-zinc-300';
}

export default function NiftyTimeAnalysis() {
  const [interval, setIntervalMin] = useState<Interval>(15);
  const [data, setData] = useState<NiftyTimeAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showLegend, setShowLegend] = useState(false);
  const seq = useRef(0);

  const fetchData = useCallback(async () => {
    const mySeq = ++seq.current;
    try {
      const res = await fetch(`/api/nifty-time-analysis?interval=${interval}`);
      const json: NiftyTimeAnalysisResponse = await res.json();
      if (mySeq !== seq.current) return;
      if (json.success) {
        setData(json);
        setError(null);
      } else {
        setError(json.error ?? 'Failed to load');
      }
    } catch (err: unknown) {
      if (mySeq !== seq.current) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (mySeq === seq.current) setLoading(false);
    }
  }, [interval]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    const timer = setInterval(fetchData, POLL_MS);
    return () => clearInterval(timer);
  }, [fetchData]);

  const isRunning = data?.status?.status === 'RUNNING';
  const runningInterval = data?.status?.interval_min;
  const marketOpen = isMarketHoursIst();
  const statusReason = statusReasonText(data?.status?.reason);

  const handleStart = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/nifty-time-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', interval_min: interval }),
      });
      const json = await res.json();
      if (!json.success) setError(json.error ?? 'Failed to start collector');
      else setError(null);
      fetchData();
    } finally {
      setBusy(false);
    }
  }, [interval, fetchData]);

  const handleStop = useCallback(async () => {
    setBusy(true);
    try {
      await fetch('/api/nifty-time-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
      fetchData();
    } finally {
      setBusy(false);
    }
  }, [fetchData]);

  const rows: NiftyTimeAnalysisRow[] = data?.rows ?? [];
  const initialLoading = loading && !data;
  const dataDate = data?.date ?? todayIst();

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* Standard dhan-page-theme header */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg border shrink-0 bg-emerald-500/10 border-emerald-500/25">
            <Clock className="w-4 h-4 text-emerald-400" aria-hidden="true" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] mb-0.5 text-emerald-400">
              Options &middot; NIFTY
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              NIFTY Analysis &mdash; Time-Based Comparison
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Spot/Fut, PCR, Max Pain, OI &amp; bias sampled every {interval}m through the session
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Interval selector */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
            {INTERVALS.map((m) => (
              <button
                key={m}
                onClick={() => setIntervalMin(m)}
                className={`px-2 py-1 rounded text-[11px] font-bold transition ${
                  interval === m
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                    : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                }`}
              >
                {m}m
              </button>
            ))}
          </div>

          {/* Start/Stop collector */}
          {isRunning ? (
            <button
              onClick={handleStop}
              disabled={busy}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition bg-rose-950/60 text-rose-400 border-rose-800 hover:bg-rose-900/60 disabled:opacity-50"
            >
              <Square className="w-3 h-3" />
              Stop ({runningInterval}m)
            </button>
          ) : (
            <button
              onClick={handleStart}
              disabled={busy || !marketOpen}
              title={marketOpen ? undefined : 'Market closed — the collector only runs 09:00–15:30 IST and would exit immediately'}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border text-[11px] font-bold transition bg-emerald-950/60 text-emerald-400 border-emerald-800 hover:bg-emerald-900/60 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <Play className="w-3 h-3" />
              {marketOpen ? 'Start collector' : 'Market closed'}
            </button>
          )}

          <button
            onClick={() => setShowLegend((v) => !v)}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg border text-[11px] font-bold transition text-zinc-400 border-zinc-800 hover:bg-zinc-900"
            title="What each column means"
          >
            <Info className="w-3.5 h-3.5" />
          </button>

          <button
            onClick={() => { setLoading(true); fetchData(); }}
            disabled={loading}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[11px] font-bold transition bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-oncolor"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>

          <span className="text-[10px] font-mono font-bold uppercase tracking-wider text-amber-300 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/20">
            DATA: {dataDate}
          </span>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      <div className="flex-1 flex flex-col gap-4 px-6 py-5">
        {error && (
          <div className="bg-rose-950/80 border border-rose-800 text-rose-200 p-3 rounded-xl text-xs flex items-center justify-between">
            <span>{error}</span>
            <button onClick={fetchData} className="underline font-bold hover:text-rose-100">Retry</button>
          </div>
        )}

        {!isRunning && rows.length === 0 && !initialLoading && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 text-xs text-zinc-400 flex items-center gap-2">
            <Info className="w-4 h-4 text-amber-400 shrink-0" />
            <span>
              {statusReason ? (
                <><span className="text-amber-300 font-semibold">{statusReason}</span>{' '}</>
              ) : null}
              No rows for {interval}m today yet. Dhan&apos;s option chain API only returns the live snapshot &mdash;
              start the collector above to begin building this table forward from now (it can&apos;t backfill earlier rows).
              {!marketOpen && ' The collector only runs 09:00–15:30 IST, so Start is disabled right now.'}
            </span>
          </div>
        )}

        {showLegend && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 text-[11px] text-zinc-400 leading-relaxed space-y-1">
            <p><span className="text-zinc-200 font-semibold">Average Price</span> &mdash; running mean of Nifty Spot across all rows collected so far today.</p>
            <p><span className="text-zinc-200 font-semibold">Fut OI Chg</span> &mdash; % change in NIFTY futures total OI vs the previous row.</p>
            <p><span className="text-zinc-200 font-semibold">Straddle &Delta;</span> &mdash; change in ATM (CE+PE) premium vs the previous row.</p>
            <p><span className="text-zinc-200 font-semibold">Vol. Bias</span> &mdash; short-term Spot momentum vs the previous row (&plusmn;3 pts flat band &rarr; &ldquo;Follow OI bias&rdquo;).</p>
            <p><span className="text-zinc-200 font-semibold">Bias</span> &mdash; OI-buildup quadrant (Long/Short Build-up, Short Covering, Long Unwinding) from Futures OI-change % &times; Spot price change, same convention as the Positions/Buildup analytics elsewhere in the dashboard.</p>
            <p className="text-zinc-600 pt-1">Heuristic thresholds &mdash; tune in <code className="text-zinc-500">scripts/tools/nifty_time_analysis_collector.py</code> if they don&apos;t match your read of the session.</p>
          </div>
        )}

        <div className="rounded-xl border-2 border-emerald-500/60 shadow-lg shadow-emerald-500/10 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-[11px] text-left font-mono border-collapse min-w-[1500px]">
              <thead>
                <tr className="bg-zinc-800">
                  {[
                    'Time', 'Nifty Spot', 'Nifty Fut', 'Fut-Spot Diff.', 'Average Price', 'Max Pain', 'PCR', 'ATM',
                    'VIX', 'Fut OI Chg', 'Highest Put OI Strike', 'Highest Call OI Strike', 'Straddle Δ',
                    'Vol. Bias', 'Bias',
                  ].map((h) => (
                    <th key={h} className="text-xs font-bold text-white px-3 py-2 border border-emerald-500/30 whitespace-nowrap text-center">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {initialLoading ? (
                  <tr>
                    <td colSpan={15} className="text-center py-10 text-zinc-500">
                      <RefreshCw className="w-5 h-5 animate-spin inline-block mr-2 text-emerald-400" />
                      Loading&hellip;
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={15} className="text-center py-10 text-zinc-600">No data yet</td>
                  </tr>
                ) : (
                  rows.map((r) => (
                    <tr key={r.time} className="bg-zinc-950 even:bg-zinc-900/40 hover:bg-zinc-900/80 transition">
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center text-zinc-300 font-semibold">{r.time}</td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.spot} dir={r.spot_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.fut} dir={r.fut_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.fut_spot_diff} dir={r.fut_spot_diff_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.avg_price} dir={r.avg_price_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.max_pain} dir={r.max_pain_dir} decimals={0} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center text-zinc-100">{r.pcr.toFixed(3)}</td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.atm} dir={r.atm_dir} decimals={0} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.vix} dir={r.vix_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center font-semibold">
                        {r.fut_oi_chg_pct === null ? (
                          <span className="text-zinc-600">#N/A</span>
                        ) : (
                          <span className={r.fut_oi_chg_pct > 0 ? 'text-emerald-400' : r.fut_oi_chg_pct < 0 ? 'text-rose-400' : 'text-zinc-400'}>
                            {r.fut_oi_chg_pct.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center text-rose-300">
                        {r.highest_put_oi_strike || '—'} <span className="text-zinc-500">({r.highest_put_oi_lakhs.toFixed(0)} L)</span>
                      </td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center text-emerald-300">
                        {r.highest_call_oi_strike || '—'} <span className="text-zinc-500">({r.highest_call_oi_lakhs.toFixed(0)} L)</span>
                      </td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center font-semibold">
                        {r.straddle_delta === null ? (
                          <span className="text-zinc-600">#N/A</span>
                        ) : (
                          <span className={r.straddle_delta > 0 ? 'text-emerald-400' : r.straddle_delta < 0 ? 'text-rose-400' : 'text-zinc-400'}>
                            {r.straddle_delta.toFixed(2)}
                          </span>
                        )}
                      </td>
                      <td className={`px-3 py-1.5 border border-emerald-500/10 text-center font-bold ${biasColor(r.vol_bias)}`}>{r.vol_bias}</td>
                      <td className={`px-3 py-1.5 border border-emerald-500/10 text-center font-bold ${biasColor(r.bias)}`}>{r.bias}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between text-[11px] text-zinc-500">
          <span>
            {rows.length} row{rows.length === 1 ? '' : 's'} &middot; {data?.nearest_expiry ? `expiry ${data.nearest_expiry}` : ''}
          </span>
          <span>
            Collector: <span className={isRunning ? 'text-emerald-400 font-semibold' : 'text-zinc-500'}>{data?.status?.status ?? 'STOPPED'}</span>
            {!isRunning && statusReason && <span className="text-zinc-600"> &mdash; {statusReason}</span>}
          </span>
        </div>
      </div>
    </div>
  );
}
