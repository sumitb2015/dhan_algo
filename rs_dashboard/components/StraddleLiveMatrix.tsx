'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity,
  RefreshCw,
  TrendingUp,
  TrendingDown,
  Layers,
  Calendar,
  Clock,
  ShieldAlert,
  Percent,
  CheckCircle2,
  XCircle,
  X,
  Info,
  Maximize2,
  History,
  Radio,
  SlidersHorizontal,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { StraddleMatrixResponse, MatrixCell, ColumnData, SlRow } from '@/app/api/straddle-matrix/route';

interface CellDetailModalProps {
  cell: MatrixCell | null;
  colData: ColumnData | null;
  lotSize: number;
  unit: 'pts' | 'inr';
  onClose: () => void;
}

function CellDetailModal({ cell, colData, lotSize, unit, onClose }: CellDetailModalProps) {
  if (!cell || !colData) return null;

  const isProfit = cell.pnl_pts >= 0;
  const mult = unit === 'inr' ? lotSize : 1;
  const unitLabel = unit === 'inr' ? '₹' : 'pts';

  const formatVal = (val: number, showPlus = true) => {
    const formatted = (val * mult).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    if (val > 0 && showPlus) return `+${formatted}`;
    return formatted;
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-sm animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-zinc-900 border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-zinc-800 bg-zinc-950/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-lg bg-sky-500/10 border border-sky-500/20 text-sky-400">
              <Layers className="h-4 w-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-zinc-100 flex items-center gap-2">
                <span>{colData.strike} Straddle @ {cell.time}</span>
                <span className="text-xs px-2 py-0.5 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-300 font-mono">
                  SL {cell.sl_pct}%
                </span>
              </h3>
              <p className="text-[11px] text-zinc-400">Leg-wise execution & Stop Loss details</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-zinc-100 hover:bg-zinc-800 transition-colors"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Content */}
        <div className="p-5 space-y-4">
          {/* Status & Net PnL Card */}
          <div className={cn(
            "p-4 rounded-xl border flex items-center justify-between",
            isProfit
              ? "bg-emerald-950/30 border-emerald-500/30"
              : "bg-red-950/30 border-red-500/30"
          )}>
            <div>
              <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 block">
                Trade Result
              </span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={cn(
                  "text-xl font-bold font-mono",
                  isProfit ? "text-emerald-400" : "text-red-400"
                )}>
                  {formatVal(cell.pnl_pts)} {unitLabel}
                </span>
                <span className="text-xs text-zinc-400 font-mono">
                  ({cell.pnl_pts >= 0 ? '+' : ''}{cell.pnl_pts.toFixed(2)} pts)
                </span>
              </div>
            </div>
            <div className="text-right">
              <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 block">
                Status
              </span>
              <span className={cn(
                "inline-block px-2.5 py-1 rounded-md text-xs font-bold mt-0.5",
                cell.status === 'intact+' && "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40",
                cell.status === 'intact-' && "bg-red-500/20 text-red-300 border border-red-500/40",
                cell.status === 'ce_out' && "bg-amber-500/20 text-amber-300 border border-amber-500/40",
                cell.status === 'pe_out' && "bg-purple-500/20 text-purple-300 border border-purple-500/40",
                cell.status === 'both_out' && "bg-pink-500/20 text-pink-300 border border-pink-500/40",
              )}>
                {cell.status.toUpperCase().replace('_', ' ')}
              </span>
            </div>
          </div>

          {/* Leg Details Grid */}
          <div className="grid grid-cols-2 gap-3">
            {/* CE Leg */}
            <div className="p-3.5 rounded-xl bg-zinc-950/70 border border-zinc-800 space-y-2">
              <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
                <span className="text-xs font-bold text-sky-400">CALL (CE) LEG</span>
                <span className={cn(
                  "text-[10px] font-semibold px-2 py-0.5 rounded",
                  cell.ce_out ? "bg-amber-500/20 text-amber-400" : "bg-emerald-500/20 text-emerald-400"
                )}>
                  {cell.ce_out ? `SL Hit @ ${cell.ce_exit_time || '—'}` : 'Holding'}
                </span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between text-zinc-400">
                  <span>Entry:</span>
                  <span className="font-mono text-zinc-200">₹{cell.ce_entry.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>SL Trigger ({cell.sl_pct}%):</span>
                  <span className="font-mono text-amber-400">₹{(cell.ce_entry * (1 + cell.sl_pct / 100)).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Exit / LTP:</span>
                  <span className="font-mono text-zinc-200">₹{cell.ce_exit.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 pt-1 border-t border-zinc-800/60 font-medium">
                  <span>Leg P&L:</span>
                  <span className={cn("font-mono font-bold", (cell.ce_entry - cell.ce_exit) >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {formatVal(cell.ce_entry - cell.ce_exit)} {unitLabel}
                  </span>
                </div>
              </div>
            </div>

            {/* PE Leg */}
            <div className="p-3.5 rounded-xl bg-zinc-950/70 border border-zinc-800 space-y-2">
              <div className="flex items-center justify-between pb-2 border-b border-zinc-800/80">
                <span className="text-xs font-bold text-purple-400">PUT (PE) LEG</span>
                <span className={cn(
                  "text-[10px] font-semibold px-2 py-0.5 rounded",
                  cell.pe_out ? "bg-purple-500/20 text-purple-400" : "bg-emerald-500/20 text-emerald-400"
                )}>
                  {cell.pe_out ? `SL Hit @ ${cell.pe_exit_time || '—'}` : 'Holding'}
                </span>
              </div>
              <div className="space-y-1 text-xs">
                <div className="flex justify-between text-zinc-400">
                  <span>Entry:</span>
                  <span className="font-mono text-zinc-200">₹{cell.pe_entry.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>SL Trigger ({cell.sl_pct}%):</span>
                  <span className="font-mono text-purple-400">₹{(cell.pe_entry * (1 + cell.sl_pct / 100)).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400">
                  <span>Exit / LTP:</span>
                  <span className="font-mono text-zinc-200">₹{cell.pe_exit.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 pt-1 border-t border-zinc-800/60 font-medium">
                  <span>Leg P&L:</span>
                  <span className={cn("font-mono font-bold", (cell.pe_entry - cell.pe_exit) >= 0 ? "text-emerald-400" : "text-red-400")}>
                    {formatVal(cell.pe_entry - cell.pe_exit)} {unitLabel}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Additional Stats */}
          <div className="p-3 rounded-xl bg-zinc-950/40 border border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400">
            <span className="flex items-center gap-1.5">
              <ShieldAlert className="h-3.5 w-3.5 text-amber-400" />
              Worst Drawdown (VaR):
            </span>
            <span className="font-mono font-bold text-red-400">
              {formatVal(cell.var_pts, false)} {unitLabel} ({cell.var_pts.toFixed(2)} pts)
            </span>
          </div>
        </div>

        {/* Footer */}
        <div className="px-5 py-3 border-t border-zinc-800 bg-zinc-950/60 flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

export default function StraddleLiveMatrix() {
  const [mode, setMode] = useState<'live' | 'historical'>('historical');
  const [underlying, setUnderlying] = useState<string>('NIFTY');
  const [expiry, setExpiry] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>('2026-07-28');
  const [interval, setInterval] = useState<string>('30');
  const [unit, setUnit] = useState<'pts' | 'inr'>('pts');
  const [autoRefreshSecs, setAutoRefreshSecs] = useState<number>(0);

  const [data, setData] = useState<StraddleMatrixResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');

  // Selected cell for drilldown modal
  const [selectedModal, setSelectedModal] = useState<{
    cell: MatrixCell;
    colData: ColumnData;
  } | null>(null);

  // Monotonic sequence guard so a slow, abandoned fetch (e.g. from a fast
  // underlying/date switch) can't overwrite a response for a newer selection.
  const requestSeq = React.useRef(0);

  const fetchData = useCallback(async (isManual = false) => {
    if (isManual) setRefreshing(true);
    const seq = ++requestSeq.current;
    try {
      const params = new URLSearchParams({
        underlying,
        interval,
      });
      if (mode === 'historical' && selectedDate) {
        params.set('date', selectedDate);
      }
      if (expiry) params.set('expiry', expiry);

      const res = await fetch(`/api/straddle-matrix?${params.toString()}`);
      const json = await res.json();

      if (seq !== requestSeq.current) return;

      if (!res.ok || !json.success) {
        throw new Error(json.error || 'Failed to fetch straddle matrix data');
      }

      setData(json.data);
      if (!expiry && json.data.expiry) {
        setExpiry(json.data.expiry);
      }
      setError(null);
      setLastUpdated(new Date().toLocaleTimeString('en-IN', { hour12: false }));
    } catch (err: unknown) {
      if (seq !== requestSeq.current) return;
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    } finally {
      if (seq === requestSeq.current) {
        setLoading(false);
        if (isManual) setRefreshing(false);
      }
    }
  }, [underlying, expiry, interval, mode, selectedDate]);

  // Fetch when parameters change
  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

  // Auto-refresh interval (only when in live mode)
  useEffect(() => {
    if (mode !== 'live' || autoRefreshSecs <= 0) return;
    const timer = window.setInterval(() => {
      fetchData(false);
    }, autoRefreshSecs * 1000);
    return () => window.clearInterval(timer);
  }, [mode, autoRefreshSecs, fetchData]);

  const lotSize = data?.lot_size || 65;
  const mult = unit === 'inr' ? lotSize : 1;
  const unitLabel = unit === 'inr' ? '₹' : 'pts';

  const formatVal = (val: number, showPlus = true, decimals = 2) => {
    const num = val * mult;
    const formatted = num.toLocaleString('en-IN', {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
    if (val > 0 && showPlus) return `+${formatted}`;
    return formatted;
  };

  const getCellBgClass = (status: MatrixCell['status']) => {
    switch (status) {
      case 'intact+':
        return 'bg-emerald-950/40 text-emerald-300 border-emerald-700/40 hover:bg-emerald-900/60';
      case 'intact-':
        return 'bg-red-950/40 text-red-300 border-red-700/40 hover:bg-red-900/60';
      case 'ce_out':
        return 'bg-amber-700/85 text-amber-100 border-amber-500/50 hover:bg-amber-700';
      case 'pe_out':
        return 'bg-purple-700/85 text-purple-100 border-purple-500/50 hover:bg-purple-700';
      case 'both_out':
        return 'bg-pink-700/85 text-pink-100 border-pink-500/50 hover:bg-pink-700';
      default:
        return 'bg-zinc-850 text-zinc-300 border-zinc-700 hover:bg-zinc-800';
    }
  };

  // Map of best SL for each timestamp
  const bestSlMap = useMemo(() => {
    if (!data?.columns) return new Map<string, number>();
    const map = new Map<string, number>();
    data.columns.forEach((col) => {
      map.set(col.time, col.best_sl_pct);
    });
    return map;
  }, [data]);

  return (
    <div className="w-full space-y-4 pb-12">
      {/* Sticky Header Control Bar */}
      <div className="sticky top-0 z-30 bg-zinc-900/95 backdrop-blur-md border border-zinc-800 p-3 rounded-2xl shadow-xl space-y-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Left Title & Mode Switcher */}
          <div className="flex items-center flex-wrap gap-2.5">
            {/* Identity */}
            <div className="flex items-center gap-2 pr-2.5 mr-0.5 border-r border-zinc-800">
              <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-sky-500/10 border border-sky-500/25 shrink-0">
                <Layers className="h-3.5 w-3.5 text-sky-400" />
              </div>
              <div className="leading-tight">
                <p className="text-[9px] font-bold text-sky-500 uppercase tracking-[0.18em]">
                  Options · Straddle
                </p>
                <h1 className="text-xs font-bold text-white tracking-tight">SL Matrix</h1>
              </div>
            </div>

            {/* Mode Toggle (Live vs Past Days) */}
            <div className="flex items-center rounded-xl bg-zinc-900 border border-zinc-800 p-0.5 shadow-inner">
              <button
                onClick={() => {
                  setMode('live');
                  setAutoRefreshSecs(15);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer",
                  mode === 'live'
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                <Radio className={cn("h-3.5 w-3.5", mode === 'live' ? "text-emerald-400 animate-pulse" : "text-zinc-500")} />
                <span>Live Intraday</span>
              </button>

              <button
                onClick={() => {
                  setMode('historical');
                  setAutoRefreshSecs(0);
                }}
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1.5 text-xs font-bold rounded-lg transition-all cursor-pointer",
                  mode === 'historical'
                    ? "bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                <History className={cn("h-3.5 w-3.5", mode === 'historical' ? "text-sky-400" : "text-zinc-500")} />
                <span>Past Days (Full Day)</span>
              </button>
            </div>

            {/* Underlying Badge */}
            <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-zinc-900 border border-zinc-700/70">
              <span className="font-extrabold text-sm tracking-tight text-white flex items-center gap-1.5">
                {underlying}
              </span>
              {mode === 'live' ? (
                <span className="relative flex h-2.5 w-2.5">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500"></span>
                </span>
              ) : (
                <span className="px-1.5 py-0.2 rounded text-[10px] font-bold bg-sky-500/20 text-sky-300 border border-sky-500/30">
                  PAST
                </span>
              )}
            </div>

            {/* DTE Badge */}
            <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-300">
              <span>DTE: {data?.dte ?? 0}</span>
              <span className={cn(
                "h-2 w-2 rounded-full",
                (data?.dte ?? 0) === 0 ? "bg-red-500" : (data?.dte ?? 0) <= 2 ? "bg-amber-500" : "bg-emerald-500"
              )} />
            </div>

            {/* DATA Date Chip */}
            <div className="flex items-center gap-1 px-2.5 py-1.5 rounded-xl bg-amber-500/10 border border-amber-500/30 text-xs text-amber-300 font-bold tracking-wide">
              <span>DATA: {data?.data_date || selectedDate || '—'}</span>
            </div>
          </div>

          {/* Right Controls */}
          <div className="flex items-center flex-wrap gap-2">
            {/* Historical Calendar Date Picker */}
            {mode === 'historical' && (
              <div className="flex items-center gap-1.5 bg-zinc-900 border border-zinc-750 px-2.5 py-1 rounded-xl">
                <Calendar className="h-3.5 w-3.5 text-sky-400" />
                <span className="text-[11px] font-semibold text-zinc-400">Date:</span>
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(e) => {
                    setSelectedDate(e.target.value);
                    setExpiry('');
                  }}
                  className="bg-transparent text-xs font-bold text-zinc-100 outline-none cursor-pointer"
                />
              </div>
            )}

            {/* Quick Historical Shortcuts */}
            {mode === 'historical' && (
              <div className="hidden lg:flex items-center gap-1 bg-zinc-900 border border-zinc-800 p-0.5 rounded-xl">
                {[
                  { label: '2026-07-28', d: '2026-07-28' },
                  { label: '2026-07-21', d: '2026-07-21' },
                  { label: '2026-07-14', d: '2026-07-14' },
                ].map((s) => (
                  <button
                    key={s.d}
                    onClick={() => {
                      setSelectedDate(s.d);
                      setExpiry('');
                    }}
                    className={cn(
                      "px-2 py-0.8 text-[10px] font-mono font-semibold rounded-lg transition-all cursor-pointer",
                      selectedDate === s.d
                        ? "bg-sky-500/20 text-sky-300 border border-sky-500/40"
                        : "text-zinc-400 hover:text-zinc-200"
                    )}
                  >
                    {s.label}
                  </button>
                ))}
              </div>
            )}

            {/* Underlying Selector */}
            <div className="flex items-center rounded-xl bg-zinc-900 border border-zinc-800 p-0.5">
              {['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'].map((und) => (
                <button
                  key={und}
                  onClick={() => {
                    setUnderlying(und);
                    setExpiry('');
                  }}
                  className={cn(
                    "px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer",
                    underlying === und
                      ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm"
                      : "text-zinc-400 hover:text-zinc-200"
                  )}
                >
                  {und}
                </button>
              ))}
            </div>

            {/* Expiry Selector */}
            {data?.all_expiries && data.all_expiries.length > 0 && (
              <select
                value={expiry || data.expiry}
                onChange={(e) => setExpiry(e.target.value)}
                aria-label="Select Expiry Date"
                className="bg-zinc-900 border border-zinc-750 text-xs font-bold text-zinc-200 rounded-xl px-2.5 py-1.5 outline-none hover:border-emerald-500/40 cursor-pointer"
              >
                {data.all_expiries.map((exp) => (
                  <option key={exp} value={exp}>
                    Exp: {exp}
                  </option>
                ))}
              </select>
            )}

            {/* Unit Toggle: Points vs ₹ */}
            <div className="flex items-center rounded-xl bg-zinc-900 border border-zinc-800 p-0.5">
              <button
                onClick={() => setUnit('pts')}
                className={cn(
                  "px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer",
                  unit === 'pts'
                    ? "bg-zinc-800 text-white shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                Pts
              </button>
              <button
                onClick={() => setUnit('inr')}
                className={cn(
                  "px-2.5 py-1 text-xs font-bold rounded-lg transition-all cursor-pointer",
                  unit === 'inr'
                    ? "bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                )}
              >
                ₹ (Lot {lotSize})
              </button>
            </div>

            {/* Live Auto Refresh (only in live mode) */}
            {mode === 'live' && (
              <div className="flex items-center rounded-xl bg-zinc-900 border border-zinc-800 p-0.5">
                {[
                  { label: 'Off', val: 0 },
                  { label: '10s', val: 10 },
                  { label: '30s', val: 30 },
                ].map((opt) => (
                  <button
                    key={opt.label}
                    onClick={() => setAutoRefreshSecs(opt.val)}
                    className={cn(
                      "px-2 py-1 text-[11px] font-semibold rounded-lg transition-all cursor-pointer",
                      autoRefreshSecs === opt.val
                        ? "bg-zinc-800 text-emerald-400"
                        : "text-zinc-500 hover:text-zinc-300"
                    )}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            )}

            {/* Manual Run/Refresh Button */}
            <button
              onClick={() => fetchData(true)}
              disabled={refreshing || loading}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-zinc-900 hover:bg-zinc-800 border border-zinc-750 text-xs font-bold text-zinc-200 transition-all cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={cn("h-3.5 w-3.5 text-emerald-400", refreshing && "animate-spin")} />
              <span>{mode === 'historical' ? 'Simulate' : 'Refresh'}</span>
            </button>
          </div>
        </div>

        {/* Legend Row */}
        <div className="flex flex-wrap items-center justify-between pt-2 border-t border-zinc-800/80 text-xs gap-3">
          <div className="flex items-center flex-wrap gap-3">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider">Leg State:</span>
            
            {/* intact+ */}
            <div className="flex items-center gap-1.5 text-xs text-zinc-300">
              <span className="h-3 w-3 rounded-full border-2 border-emerald-400 bg-emerald-950/60" />
              <span>intact+</span>
            </div>

            {/* intact- */}
            <div className="flex items-center gap-1.5 text-xs text-zinc-300">
              <span className="h-3 w-3 rounded-full border-2 border-red-500 bg-red-950/60" />
              <span>intact-</span>
            </div>

            {/* CE out */}
            <div className="flex items-center gap-1.5 text-xs text-zinc-300">
              <span className="h-3 w-3 rounded-full bg-amber-500 shadow-sm" />
              <span>CE out</span>
            </div>

            {/* PE out */}
            <div className="flex items-center gap-1.5 text-xs text-zinc-300">
              <span className="h-3 w-3 rounded-full bg-purple-500 shadow-sm" />
              <span>PE out</span>
            </div>

            {/* both out */}
            <div className="flex items-center gap-1.5 text-xs text-zinc-300">
              <span className="h-3 w-3 rounded-full bg-pink-500 shadow-sm" />
              <span>both out</span>
            </div>

            {/* Best SL Highlight */}
            <div className="flex items-center gap-1.5 text-xs text-zinc-300 pl-2 border-l border-zinc-800">
              <span className="h-3 w-3 rounded ring-2 ring-sky-400 bg-sky-500/30" />
              <span className="text-sky-300 font-semibold">Best SL Box</span>
            </div>
          </div>

          {lastUpdated && (
            <div className="text-[11px] text-zinc-500 font-mono flex items-center gap-1">
              <Clock className="h-3 w-3 text-zinc-500" />
              <span>Calculated: {lastUpdated}</span>
            </div>
          )}
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="p-4 rounded-xl bg-red-950/40 border border-red-500/50 flex items-center justify-between text-sm text-red-300">
          <div className="flex items-center gap-2">
            <XCircle className="h-4 w-4 text-red-400 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            onClick={() => fetchData(true)}
            className="px-3 py-1 rounded-lg bg-red-500/20 hover:bg-red-500/30 text-xs font-bold text-red-200 transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {/* Summary Metrics Cards */}
      {data?.summary && (
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
          {/* Best Strategy PnL */}
          <div className="p-3.5 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-md">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">
              Combined Best SL P&L
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={cn(
                "text-xl font-extrabold font-mono",
                data.summary.total_best_pnl_pts >= 0 ? "text-emerald-400" : "text-red-400"
              )}>
                {formatVal(data.summary.total_best_pnl_pts)} {unitLabel}
              </span>
            </div>
            <span className="text-[11px] text-zinc-400 font-mono mt-0.5 block">
              {data.summary.total_best_pnl_pts >= 0 ? '+' : ''}{data.summary.total_best_pnl_pts.toFixed(2)} pts across {data.summary.entries_count} entries
            </span>
          </div>

          {/* Win Rate */}
          <div className="p-3.5 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-md">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">
              Win Rate (Best SL)
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-xl font-extrabold font-mono text-zinc-100">
                {data.summary.win_rate_pct.toFixed(1)}%
              </span>
              <span className="text-xs text-zinc-400 font-medium">
                ({data.summary.profitable_entries}/{data.summary.entries_count})
              </span>
            </div>
            <span className="text-[11px] text-emerald-400 font-semibold mt-0.5 block">
              Profitable entry timestamps
            </span>
          </div>

          {/* Best Fixed SL */}
          <div className="p-3.5 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-md">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">
              Best Fixed SL Overall
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-xl font-extrabold font-mono text-sky-400">
                {data.summary.best_fixed_sl}
              </span>
              <span className={cn(
                "text-xs font-mono font-bold",
                data.summary.best_fixed_sl_pnl >= 0 ? "text-emerald-400" : "text-red-400"
              )}>
                {formatVal(data.summary.best_fixed_sl_pnl)} {unitLabel}
              </span>
            </div>
            <span className="text-[11px] text-zinc-400 mt-0.5 block">
              Static SL across entire session
            </span>
          </div>

          {/* Total VaR / Drawdown */}
          <div className="p-3.5 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-md">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">
              Total VaR / Max DD
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className="text-xl font-extrabold font-mono text-red-400">
                {formatVal(data.summary.total_var_pts, false)} {unitLabel}
              </span>
            </div>
            <span className="text-[11px] text-zinc-400 font-mono mt-0.5 block">
              {data.summary.total_var_pts.toFixed(2)} pts worst intra-trade dip
            </span>
          </div>

          {/* Grand Row Total */}
          <div className="p-3.5 rounded-2xl bg-zinc-900 border border-zinc-800 shadow-md col-span-2 sm:col-span-1">
            <span className="text-[11px] font-bold text-zinc-400 uppercase tracking-wider block">
              SL Matrix Grand Sum
            </span>
            <div className="flex items-baseline gap-2 mt-1">
              <span className={cn(
                "text-xl font-extrabold font-mono",
                data.summary.grand_row_total >= 0 ? "text-emerald-400" : "text-red-400"
              )}>
                {formatVal(data.summary.grand_row_total)} {unitLabel}
              </span>
            </div>
            <span className="text-[11px] text-zinc-400 mt-0.5 block">
              Sum of all {data.summary.entries_count * 10} matrix cells
            </span>
          </div>
        </div>
      )}

      {/* Main Straddle Matrix Table */}
      <div className="rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl overflow-hidden">
        {loading && !data ? (
          <div className="p-16 flex flex-col items-center justify-center gap-3 text-zinc-400">
            <RefreshCw className="h-7 w-7 animate-spin text-emerald-400" />
            <span className="text-sm font-semibold">Simulating Straddles & Stop Losses for {selectedDate || 'Today'}…</span>
          </div>
        ) : !data || !data.columns || data.columns.length === 0 ? (
          <div className="p-16 text-center text-zinc-400 text-sm font-medium">
            No straddle simulation data available for {selectedDate || 'the current selection'}.
          </div>
        ) : (
          <div className="overflow-x-auto scrollbar-thin scrollbar-thumb-zinc-700">
            <table className="w-full text-xs border-collapse">
              <thead>
                {/* 1. Header: PnL / Timestamps */}
                <tr className="border-b border-zinc-800 bg-zinc-900/90 text-white">
                  <th className="sticky left-0 z-20 bg-zinc-900 px-3.5 py-3 text-left font-bold text-xs uppercase tracking-wider text-zinc-200 border-r border-zinc-800 min-w-[90px]">
                    PnL
                  </th>
                  {data.columns.map((col) => (
                    <th
                      key={col.time}
                      className="px-2.5 py-3 text-center font-bold text-xs font-mono text-zinc-100 min-w-[76px] whitespace-nowrap"
                    >
                      {col.time}
                    </th>
                  ))}
                  <th className="px-3.5 py-3 text-center font-extrabold text-xs uppercase tracking-wider text-emerald-400 border-l border-zinc-800 min-w-[84px]">
                    Total
                  </th>
                </tr>

                {/* 2. Strike Row */}
                <tr className="border-b border-zinc-800/80 bg-zinc-950/60">
                  <th className="sticky left-0 z-10 bg-zinc-950 px-3.5 py-2 text-left font-bold text-xs text-zinc-400 border-r border-zinc-800">
                    Strike
                  </th>
                  {data.columns.map((col) => (
                    <td
                      key={col.time}
                      className="px-2.5 py-2 text-center font-mono font-bold text-xs text-zinc-200 whitespace-nowrap"
                    >
                      {col.strike}
                    </td>
                  ))}
                  <td className="px-3.5 py-2 text-center font-mono text-xs text-zinc-400 border-l border-zinc-800">
                    —
                  </td>
                </tr>

                {/* 3. Entry Premium Row */}
                <tr className="border-b border-zinc-800/80 bg-zinc-950/60">
                  <th className="sticky left-0 z-10 bg-zinc-950 px-3.5 py-2 text-left font-bold text-xs text-zinc-400 border-r border-zinc-800">
                    Entry
                  </th>
                  {data.columns.map((col) => (
                    <td
                      key={col.time}
                      className="px-2.5 py-2 text-center font-mono text-xs text-zinc-300 whitespace-nowrap"
                    >
                      {col.entry.toFixed(2)}
                    </td>
                  ))}
                  <td className="px-3.5 py-2 text-center font-mono text-xs text-zinc-400 border-l border-zinc-800">
                    —
                  </td>
                </tr>

                {/* 4. LTP Row */}
                <tr className="border-b border-zinc-750 bg-zinc-950/90">
                  <th className="sticky left-0 z-10 bg-zinc-950 px-3.5 py-2 text-left font-bold text-xs text-zinc-400 border-r border-zinc-800">
                    Ltp
                  </th>
                  {data.columns.map((col) => (
                    <td
                      key={col.time}
                      className="px-2.5 py-2 text-center font-mono text-xs text-zinc-300 whitespace-nowrap"
                    >
                      {col.ltp.toFixed(2)}
                    </td>
                  ))}
                  <td className="px-3.5 py-2 text-center font-mono text-xs text-zinc-400 border-l border-zinc-800">
                    —
                  </td>
                </tr>
              </thead>

              {/* SL% Matrix Body (10% to 100%) */}
              <tbody className="divide-y divide-zinc-800/60 font-mono">
                {data.sl_rows.map((row) => (
                  <tr key={row.sl_pct} className="hover:bg-zinc-900/30 transition-colors">
                    {/* Left Sticky Label */}
                    <th className="sticky left-0 z-10 bg-zinc-950 px-3.5 py-2.5 text-left font-bold text-xs text-zinc-300 border-r border-zinc-800">
                      {row.sl_label}
                    </th>

                    {/* Matrix Cells */}
                    {row.cells.map((cell) => {
                      const isBest = bestSlMap.get(cell.time) === cell.sl_pct;
                      const colInfo = data.columns.find((c) => c.time === cell.time);

                      return (
                        <td
                          key={cell.time}
                          onClick={() => {
                            if (colInfo) {
                              setSelectedModal({ cell, colData: colInfo });
                            }
                          }}
                          className={cn(
                            "px-2 py-2 text-center text-xs font-semibold tabular-nums cursor-pointer transition-all border border-zinc-850",
                            getCellBgClass(cell.status),
                            isBest && "ring-4 ring-inset ring-sky-400 shadow-[0_0_12px_rgba(56,189,248,0.4)] z-10 font-bold text-white relative"
                          )}
                          title={`${cell.time} SL ${cell.sl_pct}%: ${cell.pnl_pts} pts (${cell.status}) — Click for breakdown`}
                        >
                          {formatVal(cell.pnl_pts)}
                        </td>
                      );
                    })}

                    {/* Row Total */}
                    <td className={cn(
                      "px-3.5 py-2.5 text-center text-xs font-bold font-mono border-l border-zinc-800 tabular-nums whitespace-nowrap",
                      row.row_total >= 0 ? "text-emerald-400 bg-emerald-950/20" : "text-red-400 bg-red-950/20"
                    )}>
                      {formatVal(row.row_total)}
                    </td>
                  </tr>
                ))}
              </tbody>

              {/* Bottom Summary Rows */}
              <tfoot className="border-t-2 border-zinc-700 bg-zinc-950/90 font-mono">
                {/* 1. Total across SLs */}
                <tr className="border-b border-zinc-800">
                  <th className="sticky left-0 z-10 bg-zinc-950 px-3.5 py-2.5 text-left font-bold text-xs text-zinc-300 border-r border-zinc-800">
                    Total
                  </th>
                  {data.columns.map((col) => (
                    <td
                      key={col.time}
                      className={cn(
                        "px-2.5 py-2.5 text-center text-xs font-bold tabular-nums whitespace-nowrap",
                        col.col_total >= 0 ? "text-emerald-400" : "text-red-400"
                      )}
                    >
                      {formatVal(col.col_total)}
                    </td>
                  ))}
                  <td className={cn(
                    "px-3.5 py-2.5 text-center text-xs font-extrabold border-l border-zinc-800 tabular-nums whitespace-nowrap",
                    data.summary.total_col_sum_pts >= 0 ? "text-emerald-400 bg-emerald-950/30" : "text-red-400 bg-red-950/30"
                  )}>
                    {formatVal(data.summary.total_col_sum_pts)}
                  </td>
                </tr>

                {/* 2. Best SL Row */}
                <tr className="border-b border-zinc-800 bg-zinc-900/40">
                  <th className="sticky left-0 z-10 bg-zinc-950 px-3.5 py-2.5 text-left font-bold text-xs text-sky-400 border-r border-zinc-800">
                    Best SL
                  </th>
                  {data.columns.map((col) => (
                    <td
                      key={col.time}
                      className="px-2.5 py-2.5 text-center text-xs font-extrabold text-sky-400 whitespace-nowrap"
                    >
                      {col.best_sl}
                    </td>
                  ))}
                  <td className="px-3.5 py-2.5 text-center text-xs text-zinc-400 border-l border-zinc-800">
                    —
                  </td>
                </tr>

                {/* 3. PnL pts (Best SL) */}
                <tr className="border-b border-zinc-800">
                  <th className="sticky left-0 z-10 bg-zinc-950 px-3.5 py-2.5 text-left font-bold text-xs text-emerald-400 border-r border-zinc-800">
                    PnL {unitLabel}
                  </th>
                  {data.columns.map((col) => (
                    <td
                      key={col.time}
                      className={cn(
                        "px-2.5 py-2.5 text-center text-xs font-extrabold tabular-nums whitespace-nowrap",
                        col.pnl_pts >= 0 ? "text-emerald-400" : "text-red-400"
                      )}
                    >
                      {formatVal(col.pnl_pts)}
                    </td>
                  ))}
                  <td className={cn(
                    "px-3.5 py-2.5 text-center text-xs font-black border-l border-zinc-800 tabular-nums whitespace-nowrap",
                    data.summary.total_best_pnl_pts >= 0 ? "text-emerald-400 bg-emerald-950/40" : "text-red-400 bg-red-950/40"
                  )}>
                    {formatVal(data.summary.total_best_pnl_pts)}
                  </td>
                </tr>

                {/* 4. VaR pts Row */}
                <tr>
                  <th className="sticky left-0 z-10 bg-zinc-950 px-3.5 py-2.5 text-left font-bold text-xs text-red-400 border-r border-zinc-800">
                    VaR {unitLabel}
                  </th>
                  {data.columns.map((col) => (
                    <td
                      key={col.time}
                      className="px-2.5 py-2.5 text-center text-xs font-bold text-red-400 tabular-nums whitespace-nowrap"
                    >
                      {formatVal(col.var_pts, false)}
                    </td>
                  ))}
                  <td className="px-3.5 py-2.5 text-center text-xs font-extrabold text-red-400 bg-red-950/30 border-l border-zinc-800 tabular-nums whitespace-nowrap">
                    {formatVal(data.summary.total_var_pts, false)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* Drilldown Modal */}
      {selectedModal && (
        <CellDetailModal
          cell={selectedModal.cell}
          colData={selectedModal.colData}
          lotSize={lotSize}
          unit={unit}
          onClose={() => setSelectedModal(null)}
        />
      )}
    </div>
  );
}
