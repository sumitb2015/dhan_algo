'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { Activity, Sliders, RefreshCw, Pause, Play } from 'lucide-react';
import NavBar from './NavBar';
import type { StrangleCell } from '@/lib/strangleMath';
import type { UnderlyingType, RiskProfile } from '@/lib/ultimateScannerTypes';

interface StrangleMatrixResponse {
  success: boolean;
  error?: string;
  // Only present when success is true — the route's error responses are
  // just { success: false, error }.
  underlying?: string;
  spot?: number;
  expiries?: { expiry: string; dte: number }[];
  rows?: { offset: number; cells: (StrangleCell | null)[] }[];
}

const POLL_MS = 4000;

// Same risk-profile admission rule as ultimateScannerEngine.ts's
// evaluateCandidate, applied client-side per cell instead of server-side
// per candidate — filter changes here never trigger a re-fetch.
function passesRiskProfile(cell: StrangleCell, profile: RiskProfile): boolean {
  if (profile === 'conservative') return cell.popPct >= 75 && cell.riskTier !== 'Aggressive';
  if (profile === 'moderate') return cell.popPct >= 60 && cell.riskTier !== 'Aggressive';
  if (profile === 'aggressive') return cell.riskTier !== 'Conservative';
  return true; // 'all'
}

export default function StrangleMatrixPage() {
  const [underlying, setUnderlying] = useState<UnderlyingType>('NIFTY');
  const [data, setData] = useState<StrangleMatrixResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastPolledAt, setLastPolledAt] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);

  // Header filters — all client-side over the already-fetched matrix.
  const [offsetRowCount, setOffsetRowCount] = useState(10);
  const [minRomPct, setMinRomPct] = useState(0.5);
  const [minDistancePct, setMinDistancePct] = useState(0.2);
  const [maxDistancePct, setMaxDistancePct] = useState(6.0);
  const [riskProfile, setRiskProfile] = useState<RiskProfile>('all');
  const [goodRomPct, setGoodRomPct] = useState(1.0);
  const [greatRomPct, setGreatRomPct] = useState(2.5);

  const pollRequestId = useRef(0);

  const fetchMatrix = useCallback(async () => {
    const requestId = ++pollRequestId.current;
    try {
      const res = await fetch(`/api/options/strangle-matrix?underlying=${underlying}`);
      const json = (await res.json()) as StrangleMatrixResponse;
      if (requestId !== pollRequestId.current) return;
      if (json.success) {
        setData(json);
        setError(null);
        setLastPolledAt(new Date().toISOString());
      } else {
        setError(json.error ?? 'Failed to load strangle matrix');
      }
    } catch (err) {
      if (requestId !== pollRequestId.current) return;
      setError(String((err as Error).message ?? err));
    }
  }, [underlying]);

  // Poll loop, paused while the tab is hidden or the user pauses manually —
  // matches this repo's polling-guard convention (dhan-polling-guards skill).
  useEffect(() => {
    fetchMatrix();
    if (paused) return;

    let intervalId: ReturnType<typeof setInterval> | null = null;

    const start = () => {
      if (intervalId) return;
      intervalId = setInterval(fetchMatrix, POLL_MS);
    };
    const stop = () => {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else {
        fetchMatrix();
        start();
      }
    };

    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stop();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [fetchMatrix, paused]);

  const visibleRows = useMemo(() => {
    if (!data?.rows) return [];
    return data.rows
      .filter(row => row.offset <= offsetRowCount)
      .filter(row => {
        // A row is shown if AT LEAST ONE cell in it falls within the
        // distance range — individual cells outside it are still muted,
        // not hidden, so a trader can see the row exists across expiries.
        return row.cells.some(cell => {
          if (!cell) return false;
          return cell.distancePct >= minDistancePct && cell.distancePct <= maxDistancePct;
        });
      });
  }, [data, offsetRowCount, minDistancePct, maxDistancePct]);

  function cellTone(cell: StrangleCell | null): { bg: string; text: string; muted: boolean } {
    if (!cell) return { bg: 'bg-zinc-900/40', text: 'text-zinc-600', muted: true };
    if (cell.distancePct < minDistancePct || cell.distancePct > maxDistancePct) {
      return { bg: 'bg-zinc-900/60', text: 'text-zinc-600', muted: true };
    }
    if (!passesRiskProfile(cell, riskProfile)) {
      return { bg: 'bg-zinc-900/60', text: 'text-zinc-500', muted: true };
    }
    if (cell.romPct < minRomPct) {
      return { bg: 'bg-zinc-900/80', text: 'text-zinc-300', muted: false };
    }
    if (cell.romPct >= greatRomPct) {
      return { bg: 'bg-emerald-500/20', text: 'text-emerald-200', muted: false };
    }
    if (cell.romPct >= goodRomPct) {
      return { bg: 'bg-emerald-500/10', text: 'text-emerald-300', muted: false };
    }
    return { bg: 'bg-zinc-900/80', text: 'text-zinc-300', muted: false };
  }

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white font-sans">
      <NavBar />

      <div className="sticky top-0 z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-3.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-xl bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <Activity className="w-5 h-5 text-emerald-400" />
          </div>
          <div>
            <span className="text-[9px] font-bold text-emerald-500 uppercase tracking-[0.18em]">
              Live ATM-Offset Strangle Premiums
            </span>
            <h1 className="text-base font-bold text-white tracking-tight leading-none mt-0.5">
              Strangle Matrix
            </h1>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <span className="text-[10px] font-mono text-zinc-500">
            {lastPolledAt ? `Updated ${new Date(lastPolledAt).toLocaleTimeString('en-IN')}` : 'Loading…'}
          </span>
          <button
            onClick={() => setPaused(p => !p)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-800 text-xs font-semibold text-zinc-300 hover:text-white transition-all"
          >
            {paused ? <Play className="w-3.5 h-3.5 text-emerald-400" /> : <Pause className="w-3.5 h-3.5 text-amber-400" />}
            {paused ? 'Resume' : 'Pause'}
          </button>
          <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
            {(['NIFTY', 'SENSEX'] as const).map(u => (
              <button
                key={u}
                onClick={() => setUnderlying(u)}
                className={`px-3 py-1.5 text-xs font-semibold rounded-lg transition-all ${
                  underlying === u
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'text-zinc-400 hover:text-white'
                }`}
              >
                {u}
              </button>
            ))}
          </div>
        </div>
      </div>

      <main className="flex-1 flex flex-col px-6 py-6 max-w-7xl mx-auto w-full gap-5">
        {/* Filters panel */}
        <div className="bg-zinc-900/90 border border-zinc-800 rounded-2xl p-5 flex flex-col gap-4 shadow-xl">
          <div className="flex items-center gap-2 pb-3 border-b border-zinc-800">
            <Sliders className="w-4 h-4 text-emerald-400" />
            <h2 className="text-sm font-bold text-white tracking-wide">Filters &amp; Thresholds</h2>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Offset Rows: {offsetRowCount}
              </label>
              <input
                type="range" min="1" max="15" step="1"
                value={offsetRowCount}
                onChange={e => setOffsetRowCount(parseInt(e.target.value, 10))}
                className="w-full accent-emerald-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Min RoM %: {minRomPct.toFixed(1)}%
              </label>
              <input
                type="range" min="0" max="8" step="0.25"
                value={minRomPct}
                onChange={e => setMinRomPct(parseFloat(e.target.value))}
                className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Distance % OTM: {minDistancePct.toFixed(1)}–{maxDistancePct.toFixed(1)}%
              </label>
              <div className="flex flex-col gap-1">
                <input
                  type="range" min="0.2" max="8" step="0.2"
                  value={minDistancePct}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setMinDistancePct(v);
                    if (v > maxDistancePct) setMaxDistancePct(v);
                  }}
                  className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                />
                <input
                  type="range" min="0.2" max="8" step="0.2"
                  value={maxDistancePct}
                  onChange={e => {
                    const v = parseFloat(e.target.value);
                    setMaxDistancePct(v);
                    if (v < minDistancePct) setMinDistancePct(v);
                  }}
                  className="w-full accent-cyan-500 cursor-pointer h-1.5 bg-zinc-800 rounded-lg"
                />
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">
                Risk Profile
              </label>
              <div className="flex items-center gap-1 bg-zinc-950 border border-zinc-800 p-1 rounded-xl">
                {(['all', 'conservative', 'moderate', 'aggressive'] as const).map(p => (
                  <button
                    key={p}
                    onClick={() => setRiskProfile(p)}
                    className={`flex-1 py-1.5 text-[11px] font-semibold capitalize rounded-lg transition-all ${
                      riskProfile === p
                        ? 'bg-zinc-800 text-white border border-zinc-700'
                        : 'text-zinc-500 hover:text-zinc-300'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-6 pt-3 border-t border-zinc-800/80">
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded bg-emerald-500/10 border border-emerald-500/30" />
              <label className="text-[11px] text-zinc-400">Good RoM ≥</label>
              <input
                type="number" step="0.1" min="0" value={goodRomPct}
                onChange={e => setGoodRomPct(parseFloat(e.target.value) || 0)}
                className="w-16 bg-zinc-950 border border-zinc-800 text-white rounded-lg px-2 py-1 text-xs"
              />
              <span className="text-[11px] text-zinc-500">%</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded bg-emerald-500/25 border border-emerald-500/50" />
              <label className="text-[11px] text-zinc-400">Great RoM ≥</label>
              <input
                type="number" step="0.1" min="0" value={greatRomPct}
                onChange={e => setGreatRomPct(parseFloat(e.target.value) || 0)}
                className="w-16 bg-zinc-950 border border-zinc-800 text-white rounded-lg px-2 py-1 text-xs"
              />
              <span className="text-[11px] text-zinc-500">%</span>
            </div>
          </div>
        </div>

        {error && (
          <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/60 text-red-400 text-xs">
            <strong>Error:</strong> {error}
          </div>
        )}

        {!data && !error && (
          <div className="flex items-center justify-center gap-2 py-16 text-zinc-500 text-xs">
            <RefreshCw className="w-4 h-4 animate-spin" />
            Loading strangle matrix…
          </div>
        )}

        {data?.expiries && data.rows && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-2xl overflow-x-auto shadow-xl">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-800 text-white font-bold text-xs uppercase tracking-wider">
                <tr>
                  <th className="py-3 px-4 sticky left-0 bg-zinc-800 z-10">Offset</th>
                  {data.expiries!.map(e => (
                    <th key={e.expiry} className="py-3 px-4 text-right">
                      {e.expiry}
                      <div className="text-[10px] font-normal text-zinc-400 normal-case">{e.dte}d</div>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800 text-zinc-300">
                {visibleRows.map(row => (
                  <tr key={row.offset} className="hover:bg-zinc-800/40 transition-colors group">
                    <td className="py-3 px-4 font-bold text-white sticky left-0 bg-zinc-900 group-hover:bg-zinc-800/40 z-10">
                      ATM±{row.offset}
                    </td>
                    {row.cells.map((cell, i) => {
                      const tone = cellTone(cell);
                      return (
                        <td key={data.expiries![i].expiry} className={`py-3 px-4 text-right tabular-nums ${tone.bg}`}>
                          {cell ? (
                            <>
                              <div className={`font-bold ${tone.text}`}>₹{cell.netPremium.toLocaleString('en-IN')}</div>
                              <div className="text-[10px] text-zinc-500">{cell.romPct.toFixed(2)}%</div>
                            </>
                          ) : (
                            <span className={tone.text}>—</span>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </main>
    </div>
  );
}
