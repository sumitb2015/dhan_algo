'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import NavBar from '@/components/NavBar';
import type { NiftyTimeAnalysisResponse, NiftyTimeAnalysisRow } from '@/app/api/nifty-time-analysis/route';
import { Clock, RefreshCw, Info, History, Radio } from 'lucide-react';
import { isNseLive } from '@/lib/marketHours';

const INTERVALS = [1, 3, 5, 15, 30] as const;
type Interval = (typeof INTERVALS)[number];
type Mode = 'live' | 'historical';

function todayIso(): string {
  const d = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

/** Yesterday in the *local* calendar — toISOString() would shift the date back an extra
 *  day during the evening IST hours when UTC is still on the previous date. */
function yesterdayIso(): string {
  const ist = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  ist.setUTCDate(ist.getUTCDate() - 1);
  return ist.toISOString().slice(0, 10);
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
  const [mode, setMode] = useState<Mode>('live');
  const [historicalDate, setHistoricalDate] = useState<string>(yesterdayIso);
  const [marketLive, setMarketLive] = useState(false);
  const [data, setData] = useState<NiftyTimeAnalysisResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showLegend, setShowLegend] = useState(false);

  // A backend run reads ~43 paced Dhan calls (~15-30s) and varies with strike count, so two
  // in-flight fetches (an interval/date switch mid-request) can land out of order — this
  // stops an abandoned request's response from overwriting what the user is looking at now.
  const requestSeq = useRef(0);

  useEffect(() => {
    const update = () => setMarketLive(isNseLive(new Date()));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);

  const requestDate = mode === 'historical' ? historicalDate : '';

  const fetchData = useCallback(async () => {
    const seq = ++requestSeq.current;
    const isStale = () => seq !== requestSeq.current;
    try {
      setError(null);
      const params = new URLSearchParams({ interval: String(interval) });
      if (requestDate) params.set('date', requestDate);
      const res = await fetch(`/api/nifty-time-analysis?${params.toString()}`);
      const json = await res.json();
      if (isStale()) return;
      if (json.success && json.data) {
        setData(json.data);
      } else {
        setError(json.error ?? 'Failed to load');
      }
    } catch (err: unknown) {
      if (isStale()) return;
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (!isStale()) setLoading(false);
    }
  }, [interval, requestDate]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Only a live, still-open session's newest bucket can change — a closed session (today
  // after 15:30, or any past date) is fixed the moment it's fetched, so don't keep polling it.
  useEffect(() => {
    if (mode === 'historical') return;
    if (data?.backtrace_status === 'unavailable') return;
    if (!marketLive) return;
    if (data?.is_live === false) return;
    const pollMs = Math.max(15_000, (interval * 60_000) / 3);
    const timer = setInterval(fetchData, pollMs);
    return () => clearInterval(timer);
  }, [mode, marketLive, interval, data?.backtrace_status, data?.is_live, fetchData]);

  const rows: NiftyTimeAnalysisRow[] = data?.rows ?? [];
  const initialLoading = loading && !data;
  const refreshing = loading && !!data;
  const dataDate = data?.date ?? (mode === 'historical' ? historicalDate : todayIso());
  const backtraceStatus = data?.backtrace_status;
  const coverageNote = data?.coverage_note;
  const noData = backtraceStatus === 'unavailable' && rows.length === 0;
  const isStale = data?.stale === true;

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
              Spot/Fut, PCR, Max Pain, OI &amp; bias reconstructed every {interval}m from Dhan&apos;s own retained intraday history
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          {/* Live / Historical mode */}
          <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-800 rounded-lg p-0.5">
            <button
              onClick={() => setMode('live')}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold transition ${
                mode === 'live' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
              }`}
            >
              <Radio className="w-3 h-3" /> Today
            </button>
            <button
              onClick={() => setMode('historical')}
              className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] font-bold transition ${
                mode === 'historical' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
              }`}
            >
              <History className="w-3 h-3" /> Past session
            </button>
          </div>

          {mode === 'historical' && (
            <input
              type="date"
              value={historicalDate}
              max={todayIso()}
              onChange={(e) => setHistoricalDate(e.target.value)}
              className="bg-zinc-900 border border-zinc-800 rounded-lg px-2 py-1.5 text-[11px] text-zinc-200 font-mono"
            />
          )}

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

        {isStale && (
          <div className="bg-amber-950/60 border border-amber-800 text-amber-200 p-2.5 rounded-xl text-xs">
            Showing a cached copy — the last live fetch failed. Retrying on the next refresh.
          </div>
        )}

        {!initialLoading && coverageNote && (
          <div className={`rounded-xl border p-3 text-xs flex items-start gap-2 ${
            noData ? 'bg-amber-950/40 border-amber-800 text-amber-200' : 'bg-zinc-900/60 border-zinc-800 text-zinc-400'
          }`}>
            <Info className={`w-4 h-4 shrink-0 mt-0.5 ${noData ? 'text-amber-400' : 'text-zinc-500'}`} />
            <span>{coverageNote}</span>
          </div>
        )}

        {showLegend && (
          <div className="bg-zinc-900/60 border border-zinc-800 rounded-xl p-4 text-[11px] text-zinc-400 leading-relaxed space-y-1">
            <p>Reconstructed statelessly from Dhan&apos;s own retained per-minute open-interest history (<code className="text-zinc-500">intraday_minute_data(..., oi=True)</code>) for each tracked contract &mdash; not a live snapshot, so this works identically whether the market is open right now or has been closed for hours. Tracks the 21 strikes nearest ATM (Dhan&apos;s per-call rate limit caps how many contracts one request can pace through).</p>
            <p><span className="text-zinc-200 font-semibold">Average Price</span> &mdash; running mean of Nifty Spot across all rows up to that point in the session.</p>
            <p><span className="text-zinc-200 font-semibold">Fut OI Chg</span> &mdash; % change in NIFTY futures OI vs the previous row.</p>
            <p><span className="text-zinc-200 font-semibold">Straddle &Delta;</span> &mdash; change in ATM (CE+PE) premium vs the previous row.</p>
            <p><span className="text-zinc-200 font-semibold">Vol. Bias</span> &mdash; short-term Spot momentum vs the previous row (&plusmn;3 pts flat band &rarr; &ldquo;Follow OI bias&rdquo;).</p>
            <p><span className="text-zinc-200 font-semibold">Bias</span> &mdash; OI-buildup quadrant (Long/Short Build-up, Short Covering, Long Unwinding) from Futures OI-change % &times; Spot price change, same convention as the Positions/Buildup analytics elsewhere in the dashboard.</p>
            <p className="text-zinc-600 pt-1">Heuristic thresholds &mdash; tune in <code className="text-zinc-500">scripts/tools/nifty_time_analysis_fetch.py</code> if they don&apos;t match your read of the session.</p>
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
                      Reconstructing session&hellip; (~15-30s, ~43 paced Dhan calls)
                    </td>
                  </tr>
                ) : rows.length === 0 ? (
                  <tr>
                    <td colSpan={15} className="text-center py-10 text-zinc-600">No data</td>
                  </tr>
                ) : (
                  rows.map((r, i) => (
                    <tr key={`${r.time}-${i}`} className="bg-zinc-950 even:bg-zinc-900/40 hover:bg-zinc-900/80 transition">
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center text-zinc-300 font-semibold">{r.time}</td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.spot} dir={r.spot_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.fut} dir={r.fut_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.fut_spot_diff} dir={r.fut_spot_diff_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center"><DirCell value={r.avg_price} dir={r.avg_price_dir} /></td>
                      <td className="px-3 py-1.5 border border-emerald-500/10 text-center">
                        {r.max_pain === 0 ? <span className="text-zinc-600">—</span> : <DirCell value={r.max_pain} dir={r.max_pain_dir} decimals={0} />}
                      </td>
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
            {(data?.legs_failed ?? 0) > 0 && (
              <span className="text-amber-400"> &middot; {data?.legs_failed} leg(s) returned no data</span>
            )}
          </span>
          <span>
            {data?.is_live ? (
              <span className="text-emerald-400 font-semibold flex items-center gap-1"><Radio className="w-3 h-3" /> Live session{refreshing ? ' — refreshing…' : ''}</span>
            ) : (
              <span className="text-zinc-500">Session complete</span>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
