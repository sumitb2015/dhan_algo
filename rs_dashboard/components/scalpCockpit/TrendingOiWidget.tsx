'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { TrendingUp, RefreshCw, BarChart3, ChevronDown } from 'lucide-react';
import type { TrendingOiResponse, TrendingOiRow } from '@/app/api/trending-oi/route';
import { TrendingOiChartModal } from '@/components/TrendingOiChartModal';

function formatSignedOI(n: number | null): string {
  if (n === null || isNaN(n)) return '—';
  const abs = Math.abs(n);
  let str = '';
  if (abs >= 10_000_000) str = `${(abs / 10_000_000).toFixed(2)}Cr`;
  else if (abs >= 100_000) str = `${(abs / 100_000).toFixed(1)}L`;
  else str = abs.toLocaleString('en-IN');
  return n >= 0 ? `+${str}` : `-${str}`;
}

export interface TrendingOiWidgetProps {
  underlying?: string;
}

export default function TrendingOiWidget({ underlying: _underlying }: TrendingOiWidgetProps) {
  const [data, setData] = useState<TrendingOiResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [interval_, setInterval_] = useState<string>('3');
  const [expiry, setExpiry] = useState<string>('nearest');
  const [isChartOpen, setIsChartOpen] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const fetchData = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    else setIsRefreshing(true);
    try {
      const params = new URLSearchParams({ expiry, interval: interval_ });
      const res = await fetch(`/api/trending-oi?${params.toString()}`);
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
        setError(null);
      } else {
        setError(json.error ?? 'Failed to load Trending OI');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Network error');
    } finally {
      setLoading(false);
      setIsRefreshing(false);
    }
  }, [expiry, interval_]);

  useEffect(() => {
    fetchData();
    const pollMs = Math.max(15_000, (Number(interval_) * 60_000) / 4);
    const timer = setInterval(() => {
      fetchData(true);
    }, pollMs);
    return () => clearInterval(timer);
  }, [fetchData, interval_]);

  const rows = data?.rows ?? [];
  // Take the most recent 12 snapshots in reverse chronological order for quick scanning
  const recentRows = useMemo(() => {
    return [...rows].reverse().slice(0, 12);
  }, [rows]);

  const latestRow = rows.length > 0 ? rows[rows.length - 1] : null;

  return (
    <div className="flex flex-col h-full bg-zinc-900/90 border border-zinc-800 rounded-xl overflow-hidden shadow-sm">
      {/* Widget Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-zinc-800/80 bg-zinc-950/60 flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <div className="w-5 h-5 rounded flex items-center justify-center bg-emerald-500/10 text-emerald-400 border border-emerald-500/25">
            <TrendingUp className="w-3 h-3" />
          </div>
          <div>
            <div className="flex items-center gap-1.5">
              <span className="text-xs font-bold text-white tracking-tight">Trending OI Tape</span>
              {isRefreshing && <RefreshCw className="w-2.5 h-2.5 text-emerald-400 animate-spin" />}
            </div>
          </div>
        </div>

        {/* Controls */}
        <div className="flex items-center gap-1.5">
          {/* Interval Buttons */}
          <div className="flex items-center gap-0.5 bg-zinc-950 p-0.5 rounded border border-zinc-800 text-[10px]">
            {['1', '3', '5', '15'].map(i => (
              <button
                key={i}
                type="button"
                onClick={() => setInterval_(i)}
                className={`px-1.5 py-0.5 font-bold rounded transition-colors ${
                  interval_ === i ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-500 hover:text-zinc-300'
                }`}
              >
                {i}m
              </button>
            ))}
          </div>

          {/* Expiry Selector */}
          {data?.expiries && data.expiries.length > 0 && (
            <div className="relative">
              <select
                value={expiry}
                onChange={e => setExpiry(e.target.value)}
                className="h-6 bg-zinc-950 border border-zinc-800 text-[10px] text-zinc-300 font-semibold rounded px-1.5 pr-4 focus:outline-none cursor-pointer appearance-none"
              >
                <option value="nearest">Nearest</option>
                {data.expiries.slice(0, 4).map(e => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
              <ChevronDown className="w-2.5 h-2.5 text-zinc-500 absolute right-1 top-1.5 pointer-events-none" />
            </div>
          )}

          {/* Modal Chart Trigger */}
          <button
            type="button"
            onClick={() => setIsChartOpen(true)}
            disabled={rows.length === 0}
            title="Open full Trending OI Chart"
            className="h-6 px-1.5 inline-flex items-center gap-1 rounded bg-zinc-950 border border-zinc-800 text-[10px] font-bold text-zinc-300 hover:text-white disabled:opacity-40"
          >
            <BarChart3 className="w-2.5 h-2.5 text-emerald-400" />
            <span>Chart</span>
          </button>

          {/* Refresh */}
          <button
            type="button"
            onClick={() => fetchData()}
            title="Refresh Trending OI"
            className="p-1 rounded bg-zinc-950 border border-zinc-800 text-zinc-400 hover:text-white"
          >
            <RefreshCw className="w-2.5 h-2.5" />
          </button>
        </div>
      </div>

      {/* Main Table Area */}
      <div className="flex-1 min-h-[170px] overflow-auto flex flex-col justify-between">
        {loading && !data && (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-500 gap-1.5">
            <RefreshCw className="w-4 h-4 animate-spin text-emerald-400" />
            <span className="text-[11px]">Loading Trending OI...</span>
          </div>
        )}

        {error && !data && (
          <div className="flex-1 flex items-center justify-center p-3 text-center">
            <span className="text-[11px] text-rose-400">{error}</span>
          </div>
        )}

        {!loading && recentRows.length === 0 && !error && (
          <div className="flex-1 flex items-center justify-center text-zinc-500 text-[11px]">
            No interval buckets polled yet today.
          </div>
        )}

        {recentRows.length > 0 && (
          <div className="w-full overflow-x-auto">
            <table className="w-full text-[11px] text-left whitespace-nowrap font-mono">
              <thead>
                <tr className="border-b border-zinc-800 bg-zinc-950/80 text-[10px] font-bold text-zinc-400 uppercase tracking-wider">
                  <th className="py-1 px-2 text-center">Time</th>
                  <th className="py-1 px-2 text-right">Spot</th>
                  <th className="py-1 px-2 text-right text-blue-400">Δ Call OI</th>
                  <th className="py-1 px-2 text-right text-rose-400">Δ Put OI</th>
                  <th className="py-1 px-2 text-right">Diff OI</th>
                  <th className="py-1 px-2 text-center">PCR</th>
                  <th className="py-1 px-2 text-center">Sentiment</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800/60 tabular-nums">
                {recentRows.map((r, idx) => {
                  const isLatest = idx === 0;
                  const diff = r.diff_in_oi ?? 0;
                  const sentiment = r.sentiment ?? (diff > 0 ? 'Bullish' : diff < 0 ? 'Bearish' : 'Neutral');

                  return (
                    <tr
                      key={`${r.date}-${r.time}-${idx}`}
                      className={`hover:bg-zinc-800/40 transition-colors ${
                        isLatest ? 'bg-emerald-500/5 font-semibold text-white' : 'text-zinc-300'
                      }`}
                    >
                      <td className="py-1 px-2 text-center text-zinc-400">
                        {r.time}
                        {isLatest && <span className="ml-1 text-[8px] text-emerald-400 font-bold">NOW</span>}
                      </td>
                      <td className="py-1 px-2 text-right text-zinc-100 font-bold">
                        {r.spot != null ? r.spot.toFixed(1) : '—'}
                      </td>
                      <td className="py-1 px-2 text-right text-blue-400">
                        {formatSignedOI(r.chng_in_call_oi)}
                      </td>
                      <td className="py-1 px-2 text-right text-rose-400">
                        {formatSignedOI(r.chng_in_put_oi)}
                      </td>
                      <td className={`py-1 px-2 text-right font-bold ${
                        diff >= 0 ? 'text-emerald-400' : 'text-rose-400'
                      }`}>
                        {formatSignedOI(diff)}
                      </td>
                      <td className="py-1 px-2 text-center text-zinc-200">
                        {r.net_pcr != null ? r.net_pcr.toFixed(2) : '—'}
                      </td>
                      <td className="py-1 px-2 text-center">
                        <span className={`px-1.5 py-0.2 rounded text-[9px] font-bold ${
                          sentiment === 'Bullish'
                            ? 'bg-emerald-500/15 text-emerald-400'
                            : sentiment === 'Bearish'
                            ? 'bg-rose-500/15 text-rose-400'
                            : 'bg-zinc-800 text-zinc-400'
                        }`}>
                          {sentiment}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* Bottom Snapshot Footer */}
        {latestRow && (
          <div className="mt-auto px-2 py-1 border-t border-zinc-800/80 bg-zinc-950/40 flex items-center justify-between text-[10px] text-zinc-400 font-mono">
            <span>Interval: <strong className="text-zinc-200">{interval_}m</strong></span>
            <span>Total PE OI: <strong className="text-rose-400">{formatSignedOI(latestRow.total_put_oi)}</strong></span>
            <span>Total CE OI: <strong className="text-blue-400">{formatSignedOI(latestRow.total_call_oi)}</strong></span>
          </div>
        )}
      </div>

      {/* Chart Modal */}
      {isChartOpen && rows.length > 0 && (
        <TrendingOiChartModal
          rows={rows}
          interval={data?.interval ?? interval_}
          expiry={data?.expiry ?? ''}
          spot={data?.spot}
          strikeCount={data?.selected_strikes?.length ?? 10}
          onClose={() => setIsChartOpen(false)}
        />
      )}
    </div>
  );
}
