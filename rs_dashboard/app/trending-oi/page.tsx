'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import NavBar from '@/components/NavBar';
import { TrendingOiTable } from '@/components/TrendingOiTable';
import type { TrendingOiResponse } from '@/app/api/trending-oi/route';
import { RefreshCw, TrendingUp, Search, ChevronDown } from 'lucide-react';

const INTERVALS = ['1', '3', '5', '10', '15'] as const;
type Mode = 'live' | 'historical';

/** Yesterday in the *local* calendar — toISOString() would shift the date back an extra day
 *  during the evening IST hours when UTC is still on the previous date. */
function yesterdayIso(): string {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Simple IST 09:15-15:30 weekday check — no shared market-hours helper exists in this project. */
function isNseLive(now: Date): boolean {
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

export default function TrendingOiPage() {
  const [data, setData] = useState<TrendingOiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [expiry, setExpiry] = useState<string>('nearest');
  const [interval_, setInterval_] = useState<string>('5');
  const [mode, setMode] = useState<Mode>('live');
  const [historicalDate, setHistoricalDate] = useState<string>(yesterdayIso);
  const [marketLive, setMarketLive] = useState(false);

  // null = "let the server pick the ATM band". Adopting the server's band into state instead
  // would change the query key on first response and re-spawn the whole ~25s backend run.
  const [selectedStrikes, setSelectedStrikes] = useState<number[] | null>(null);
  const [isStrikePickerOpen, setIsStrikePickerOpen] = useState(false);
  const [strikeSearch, setStrikeSearch] = useState('');
  const pickerRef = useRef<HTMLDivElement>(null);

  const initialLoading = loading && !data;
  const refreshing = loading && !!data;

  useEffect(() => {
    const update = () => setMarketLive(isNseLive(new Date()));
    update();
    const id = setInterval(update, 30_000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setIsStrikePickerOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const requestDate = mode === 'historical' ? historicalDate : '';
  const strikesParam = selectedStrikes?.length ? selectedStrikes.join(',') : '';

  const fetchData = useCallback(async () => {
    try {
      setError(null);
      const params = new URLSearchParams({ expiry, interval: interval_ });
      if (requestDate) params.set('date', requestDate);
      if (strikesParam) params.set('strikes', strikesParam);
      const res = await fetch(`/api/trending-oi?${params.toString()}`);
      const json = await res.json();
      if (json.success && json.data) {
        setData(json.data);
      } else {
        setError(json.error ?? 'Failed to load Trending OI');
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [expiry, interval_, requestDate, strikesParam]);

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  useEffect(() => {
    if (mode === 'historical') return;
    if (data?.backtrace_status === 'unavailable') return; // no point hammering a dead leg
    if (!marketLive) return;
    const pollMs = Math.max(5_000, (Number(interval_) * 60_000) / 4);
    const timer = setInterval(fetchData, pollMs);
    return () => clearInterval(timer);
  }, [mode, marketLive, interval_, data?.backtrace_status, fetchData]);

  const handleExpiryChange = (newExpiry: string) => {
    setExpiry(newExpiry);
    setSelectedStrikes(null); // re-centre on the new expiry's ATM
  };

  const rows = data?.rows ?? [];
  const spot = data?.spot;
  const backtraceStatus = data?.backtrace_status;
  const coverageNote = data?.coverage_note;
  const noData = backtraceStatus === 'unavailable' && rows.length === 0;

  // The server echoes the band it actually used (including any cap it applied), so the chips
  // and picker stay truthful whether the selection came from the user or the default.
  const activeSelectedStrikes = selectedStrikes ?? data?.selected_strikes ?? [];
  const availableStrikes = data?.available_strikes ?? activeSelectedStrikes;

  const atmStrike = useMemo(() => {
    if (!spot || availableStrikes.length === 0) return null;
    return availableStrikes.reduce((prev, curr) => (Math.abs(curr - spot) < Math.abs(prev - spot) ? curr : prev));
  }, [spot, availableStrikes]);

  const toggleStrike = (stk: number) => {
    if (activeSelectedStrikes.includes(stk)) {
      if (activeSelectedStrikes.length <= 1) return;
      setSelectedStrikes(activeSelectedStrikes.filter((s) => s !== stk));
    } else {
      setSelectedStrikes([...activeSelectedStrikes, stk].sort((a, b) => a - b));
    }
  };

  const applyPresetBand = (bandWidth: number) => {
    if (!availableStrikes.length) return;
    const atm = atmStrike || availableStrikes[Math.floor(availableStrikes.length / 2)];
    const atmIdx = availableStrikes.indexOf(atm);
    const lo = Math.max(0, atmIdx - bandWidth);
    const hi = Math.min(availableStrikes.length, atmIdx + bandWidth + 1);
    setSelectedStrikes(availableStrikes.slice(lo, hi));
  };

  // Back to the server-chosen ATM band. There is deliberately no "select all": the chain
  // carries 200+ strikes and the backend caps the band anyway, so it would only mislead.
  const resetStrikes = () => setSelectedStrikes(null);

  const strikeSummaryText = useMemo(() => {
    if (!activeSelectedStrikes.length) return 'Select Strikes';
    const sorted = [...activeSelectedStrikes].sort((a, b) => a - b);
    if (sorted.length <= 2) return sorted.join(', ');
    return `${sorted[0]}, ${sorted[1]}`;
  }, [activeSelectedStrikes]);

  const extraStrikeCount = activeSelectedStrikes.length > 2 ? activeSelectedStrikes.length - 2 : 0;
  const filteredAvailableStrikes = availableStrikes.filter((stk) => stk.toString().includes(strikeSearch.trim()));

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col font-sans">
      <NavBar />

      <main className="flex-1 p-4 mx-auto w-full flex flex-col gap-4">
        {/* TOP CONTROL BAR & TITLE */}
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3 bg-zinc-900/70 border border-zinc-800 p-3.5 rounded-xl shadow-md">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold tracking-tight text-white">Trending OI</h1>
                {refreshing && <RefreshCw className="w-3.5 h-3.5 text-emerald-400 animate-spin" />}
              </div>
              <p className="text-xs text-zinc-400">
                Chain-wide OI/LTP totals bucketed by interval, diffed against the previous bucket
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            {/* Spot Price */}
            <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
              <Search className="w-3.5 h-3.5 text-zinc-500" />
              <span className="text-zinc-400 font-semibold uppercase tracking-wider">Spot</span>
              <span className="font-bold tabular-nums text-zinc-100">
                NIFTY {spot != null && spot > 0 ? spot.toFixed(2) : '—'}
              </span>
            </div>

            {/* Strike Picker */}
            <div className="relative" ref={pickerRef}>
              <button
                type="button"
                onClick={() => setIsStrikePickerOpen(!isStrikePickerOpen)}
                className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg hover:border-zinc-600 transition"
              >
                <span className="text-zinc-400">Strikes:</span>
                <span className="font-mono font-semibold text-zinc-100">{strikeSummaryText}</span>
                {extraStrikeCount > 0 && (
                  <span className="px-1.5 py-0.5 rounded-full text-[10px] font-bold bg-emerald-500/20 text-emerald-400">
                    +{extraStrikeCount}
                  </span>
                )}
                <ChevronDown className="w-3 h-3 text-zinc-500" />
              </button>

              {isStrikePickerOpen && (
                <div className="absolute left-0 top-full mt-1.5 z-50 w-72 rounded-lg border border-zinc-800 bg-zinc-900 shadow-xl p-3 flex flex-col gap-2">
                  <div className="flex items-center justify-between border-b border-zinc-800 pb-1.5">
                    <span className="text-xs font-semibold text-zinc-200">Select Option Strikes</span>
                    <span className="text-[10px] text-zinc-500">{activeSelectedStrikes.length} selected</span>
                  </div>

                  <div className="flex flex-wrap gap-1">
                    {[3, 5, 10].map((w) => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => applyPresetBand(w)}
                        className="px-2 py-0.5 text-[11px] rounded border border-zinc-700 bg-zinc-950 text-zinc-300 hover:border-zinc-500"
                      >
                        ATM ±{w}
                      </button>
                    ))}
                    <button
                      type="button"
                      onClick={resetStrikes}
                      className="px-2 py-0.5 text-[11px] rounded border border-zinc-700 bg-zinc-950 text-zinc-500 hover:border-zinc-500"
                    >
                      Reset
                    </button>
                  </div>

                  <input
                    type="text"
                    placeholder="Search strike..."
                    value={strikeSearch}
                    onChange={(e) => setStrikeSearch(e.target.value)}
                    className="w-full px-2 py-1 text-xs rounded border border-zinc-700 bg-zinc-950 text-zinc-100"
                  />

                  <div className="max-h-48 overflow-y-auto flex flex-col gap-0.5 pr-1 text-xs">
                    {filteredAvailableStrikes.map((stk) => {
                      const checked = activeSelectedStrikes.includes(stk);
                      const isAtm = atmStrike === stk;
                      return (
                        <label
                          key={stk}
                          className="flex items-center justify-between px-2 py-1 rounded cursor-pointer hover:bg-zinc-800 transition-colors"
                        >
                          <div className="flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={checked}
                              onChange={() => toggleStrike(stk)}
                              className="rounded border-zinc-600 h-3.5 w-3.5"
                            />
                            <span className={`font-mono ${checked ? 'font-semibold text-emerald-400' : 'text-zinc-400'}`}>
                              {stk}
                            </span>
                          </div>
                          {isAtm && (
                            <span className="text-[10px] px-1 py-0.5 rounded font-bold bg-amber-500/20 text-amber-400">
                              ATM
                            </span>
                          )}
                        </label>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>

            {/* Expiry */}
            <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
              <span className="text-zinc-400">Expiry:</span>
              <select
                value={expiry}
                onChange={(e) => handleExpiryChange(e.target.value)}
                className="bg-transparent text-zinc-100 font-semibold focus:outline-none cursor-pointer"
              >
                <option value="nearest" className="bg-zinc-900 text-emerald-400 font-bold">
                  Nearest
                </option>
                {(data?.expiries ?? []).map((e) => (
                  <option key={e} value={e} className="bg-zinc-900 text-zinc-200">
                    {e}
                  </option>
                ))}
              </select>
            </div>

            {/* Interval */}
            <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
              <span className="text-zinc-400">Interval:</span>
              {INTERVALS.map((i) => (
                <button
                  key={i}
                  onClick={() => setInterval_(i)}
                  className={`px-2 py-0.5 rounded font-semibold transition ${
                    interval_ === i ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {i}m
                </button>
              ))}
            </div>

            {/* Live / Historical */}
            <div className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
              {(['live', 'historical'] as Mode[]).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-2 py-0.5 rounded font-semibold capitalize transition ${
                    mode === m ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            {mode === 'historical' ? (
              <input
                type="date"
                value={historicalDate}
                max={yesterdayIso()}
                onChange={(e) => setHistoricalDate(e.target.value)}
                className="bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg text-zinc-100"
              />
            ) : (
              <span className="flex items-center gap-1.5 bg-zinc-950 border border-zinc-800 px-2.5 py-1.5 rounded-lg">
                <span className={`w-2 h-2 rounded-full ${marketLive ? 'bg-emerald-400' : 'bg-zinc-600'}`} />
                <span className="text-zinc-400">{marketLive ? 'live' : 'closed'}</span>
              </span>
            )}
          </div>
        </div>

        {/* Selected Strikes chips */}
        <div className="flex flex-wrap items-center gap-2 text-xs px-1">
          <span className="font-medium text-zinc-400 whitespace-nowrap">Selected Strikes:</span>
          {activeSelectedStrikes.map((stk) => {
            const isAtm = atmStrike === stk;
            return (
              <button
                key={stk}
                type="button"
                onClick={() => toggleStrike(stk)}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-md text-xs font-mono font-medium transition-all hover:opacity-80 ${
                  isAtm ? 'bg-emerald-500/20 border border-emerald-500/50 text-emerald-300' : 'bg-emerald-500/10 border border-emerald-500/25 text-emerald-400'
                }`}
                title="Click to remove strike"
              >
                <span>{stk}</span>
                {isAtm && <span className="text-[9px] font-bold uppercase opacity-80">(ATM)</span>}
                <span className="ml-0.5 text-xs font-bold">×</span>
              </button>
            );
          })}
        </div>

        {coverageNote && (
          <div className="text-xs text-zinc-500 px-1">
            {backtraceStatus === 'unavailable' && <span className="text-rose-400">⚠ </span>}
            {coverageNote}
          </div>
        )}

        {initialLoading && (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-zinc-500">
            <RefreshCw className="w-6 h-6 animate-spin text-emerald-400" />
            <span className="text-xs font-medium">Loading Trending OI...</span>
          </div>
        )}

        {error && (
          <div className="bg-zinc-900 border border-rose-900 rounded-lg p-4 text-sm font-medium text-rose-400">
            {error}
          </div>
        )}

        {/* The backend returns a complete table or none at all, so "no rows" means the reason
            is already spelled out in the coverage note above — don't imply a fetch is pending. */}
        {!initialLoading && noData && (
          <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-4 text-sm text-zinc-400">
            No data to display for this selection.
          </div>
        )}

        {!initialLoading && !noData && <TrendingOiTable rows={rows} />}
      </main>
    </div>
  );
}
