'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Layers, RefreshCw, TrendingUp, TrendingDown, Clock, ShieldAlert,
  Calendar, Radio, History, X, BookOpen, Info, CheckCircle2,
  AlertTriangle, ArrowUpRight, ArrowDownRight, BarChart2, Zap, HelpCircle
} from 'lucide-react';
import {
  BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell
} from 'recharts';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import type {
  StraddleMatrixResponse, MatrixCell, ColumnData, SlRow
} from '@/app/api/straddle-matrix/route';

// ─── Formatters & Utility Functions ─────────────────────────────────────────
function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined) return '—';
  return n.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

// ─── Cell Color Helper ──────────────────────────────────────────────────────
function getCellVisuals(status: MatrixCell['status'], isBest: boolean) {
  let bg = 'bg-zinc-900/90 text-zinc-300 border-zinc-800';
  let badge = 'bg-zinc-800 text-zinc-400';
  let label = 'Unknown';

  switch (status) {
    case 'intact+':
      bg = 'bg-emerald-950/50 text-emerald-300 border-emerald-700/50 hover:bg-emerald-900/70';
      badge = 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40';
      label = 'INTACT (+)';
      break;
    case 'intact-':
      bg = 'bg-red-950/50 text-red-300 border-red-700/50 hover:bg-red-900/70';
      badge = 'bg-red-500/20 text-red-300 border-red-500/40';
      label = 'INTACT (-)';
      break;
    case 'ce_out':
      bg = 'bg-amber-950/60 text-amber-200 border-amber-600/60 hover:bg-amber-900/70';
      badge = 'bg-amber-500/20 text-amber-300 border-amber-500/40';
      label = 'CE OUT';
      break;
    case 'pe_out':
      bg = 'bg-purple-950/60 text-purple-200 border-purple-600/60 hover:bg-purple-900/70';
      badge = 'bg-purple-500/20 text-purple-300 border-purple-500/40';
      label = 'PE OUT';
      break;
    case 'both_out':
      bg = 'bg-pink-950/60 text-pink-200 border-pink-600/60 hover:bg-pink-900/70';
      badge = 'bg-pink-500/20 text-pink-300 border-pink-500/40';
      label = 'BOTH OUT';
      break;
  }

  return { bg, badge, label };
}

// ─── Quant-Terminal Pulse Stat Component ────────────────────────────────────
function PulseStat({
  label, value, sub, color = 'text-zinc-100', size = 'text-xl', icon: Icon, badge,
}: {
  label: string; value: React.ReactNode; sub?: React.ReactNode; color?: string; size?: string; icon?: React.ElementType; badge?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col min-w-0">
      <div className="flex items-center justify-between gap-1 mb-1">
        <div className="flex items-center gap-1.5 text-[9px] font-bold text-zinc-500 uppercase tracking-[0.14em]">
          {Icon && <Icon className="w-3 h-3 text-zinc-400" />}
          <span>{label}</span>
        </div>
        {badge}
      </div>
      <span className={cn(size, 'font-mono font-bold tabular-nums leading-none', color)}>{value}</span>
      {sub && <span className="text-[10px] text-zinc-400 mt-1 font-medium">{sub}</span>}
    </div>
  );
}

// ─── Card Panel Wrapper ─────────────────────────────────────────────────────
function CardPanel({
  title, eyebrow, count, icon: Icon, accent = 'text-sky-400', children,
  className, headerRight,
}: {
  title: string; eyebrow?: string; count?: number | string; icon?: React.ElementType;
  accent?: string; children: React.ReactNode; className?: string;
  headerRight?: React.ReactNode;
}) {
  return (
    <div className={cn('bg-zinc-900/60 border border-zinc-800 rounded-2xl overflow-hidden flex flex-col', className)}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-zinc-800 bg-zinc-950/40 shrink-0">
        <div className="flex items-center gap-2.5">
          {Icon && (
            <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-zinc-900 border border-zinc-700/60 shrink-0">
              <Icon className={cn('h-3.5 w-3.5', accent)} />
            </div>
          )}
          <div>
            {eyebrow && (
              <p className="text-[9px] font-bold text-zinc-500 uppercase tracking-[0.16em] leading-none mb-0.5">
                {eyebrow}
              </p>
            )}
            <div className="flex items-center gap-2">
              <h3 className="text-sm font-bold text-zinc-100 tracking-tight leading-none">{title}</h3>
              {count !== undefined && (
                <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                  {count}
                </span>
              )}
            </div>
          </div>
        </div>
        {headerRight && <div className="flex items-center gap-2">{headerRight}</div>}
      </div>

      <div className="overflow-x-auto flex-1">
        {children}
      </div>
    </div>
  );
}

// ─── Readme & Guide Modal ───────────────────────────────────────────────────
function StraddleReadmeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [guideTab, setGuideTab] = useState<'concepts' | 'matrix' | 'strategy'>('concepts');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-2xl bg-zinc-950 border border-zinc-700/80 rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
        {/* Modal Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-800 bg-zinc-900/60 shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400">
              <BookOpen className="w-4 h-4" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-white tracking-tight">ATM Straddle Matrix Guide &amp; Readme</h2>
              <p className="text-[11px] text-zinc-400">How to interpret Stop-Loss simulations, leg exits, and intraday edge</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Tab Navigation */}
        <div className="flex items-center px-6 pt-3 border-b border-zinc-800/80 bg-zinc-900/30 gap-2 shrink-0">
          {[
            { id: 'concepts', label: '1. What is Straddle Matrix?' },
            { id: 'matrix', label: '2. Interpreting the Grid & Colors' },
            { id: 'strategy', label: '3. Actionable Strategy Rules' },
          ].map(tab => (
            <button
              key={tab.id}
              onClick={() => setGuideTab(tab.id as typeof guideTab)}
              className={cn(
                'px-3.5 py-2 text-xs font-bold border-b-2 transition-all cursor-pointer',
                guideTab === tab.id
                  ? 'border-sky-400 text-sky-300'
                  : 'border-transparent text-zinc-400 hover:text-zinc-200'
              )}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Modal Content */}
        <div className="p-6 overflow-y-auto space-y-4 text-xs text-zinc-300 leading-relaxed font-sans">
          {guideTab === 'concepts' && (
            <div className="space-y-4">
              <div className="p-3.5 rounded-xl bg-sky-950/20 border border-sky-500/30 text-sky-300 space-y-1">
                <p className="font-bold flex items-center gap-1.5">
                  <Zap className="w-3.5 h-3.5" /> Core Concept: ATM Short Straddle with Leg-Wise Stop Loss
                </p>
                <p className="text-zinc-300 text-[11px]">
                  At every selected interval (e.g. 09:15, 09:45, 10:15...), the system simulates selling 1 Call (CE) and 1 Put (PE) at the exact ATM strike.
                </p>
              </div>

              <div>
                <h4 className="text-zinc-100 font-bold mb-1.5 text-xs uppercase tracking-wider">How Leg-Wise Stop Loss Works</h4>
                <p>
                  Instead of exiting both legs together, each leg has an independent Stop Loss set at:
                </p>
                <div className="mt-2 p-2.5 rounded-lg bg-zinc-900 border border-zinc-800 font-mono text-[11px] text-emerald-400 text-center">
                  SL Trigger Price = Entry Price × (1 + SL% / 100)
                </div>
                <p className="mt-2 text-zinc-400 text-[11px]">
                  <strong>Example with 25% SL:</strong> If you sell 24000 CE @ ₹100 and 24000 PE @ ₹100:
                </p>
                <ul className="list-disc pl-5 mt-1 space-y-1 text-zinc-400 text-[11px]">
                  <li>CE SL is ₹125 (+25 pts loss)</li>
                  <li>PE SL is ₹125 (+25 pts loss)</li>
                  <li>If market rallies, CE hits SL @ ₹125 and exits. The PE leg remains active and continues decaying towards ₹0.</li>
                </ul>
              </div>

              <div className="p-3 rounded-xl bg-zinc-900/80 border border-zinc-800">
                <h4 className="text-zinc-100 font-bold mb-1 text-xs">Why This Matrix Is Powerful</h4>
                <p className="text-zinc-400 text-[11px]">
                  It tests all Stop Loss settings from <strong>10% to 100%</strong> across every entry timestamp of the day simultaneously, revealing which entry times and SL percentages generate consistent alpha versus which ones suffer from whipsaws.
                </p>
              </div>
            </div>
          )}

          {guideTab === 'matrix' && (
            <div className="space-y-4">
              <div>
                <h4 className="text-zinc-100 font-bold mb-2 text-xs uppercase tracking-wider">Color-Coded Leg Status Guide</h4>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                  <div className="p-2.5 rounded-lg bg-emerald-950/40 border border-emerald-500/40">
                    <span className="font-bold text-emerald-400 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-emerald-400" /> INTACT (+)
                    </span>
                    <p className="text-[11px] text-zinc-300 mt-1">
                      Neither leg hit SL. Straddle is in profit (both premiums decayed).
                    </p>
                  </div>

                  <div className="p-2.5 rounded-lg bg-red-950/40 border border-red-500/40">
                    <span className="font-bold text-red-400 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-red-400" /> INTACT (-)
                    </span>
                    <p className="text-[11px] text-zinc-300 mt-1">
                      Neither leg hit SL, but combined premium expanded (temporary drawdown).
                    </p>
                  </div>

                  <div className="p-2.5 rounded-lg bg-amber-950/40 border border-amber-500/40">
                    <span className="font-bold text-amber-400 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-amber-400" /> CE OUT
                    </span>
                    <p className="text-[11px] text-zinc-300 mt-1">
                      Upside move hit CE SL. PE held to expiration and captured decay.
                    </p>
                  </div>

                  <div className="p-2.5 rounded-lg bg-purple-950/40 border border-purple-500/40">
                    <span className="font-bold text-purple-400 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-purple-400" /> PE OUT
                    </span>
                    <p className="text-[11px] text-zinc-300 mt-1">
                      Downside move hit PE SL. CE held to expiration and captured decay.
                    </p>
                  </div>

                  <div className="p-2.5 rounded-lg bg-pink-950/40 border border-pink-500/40 sm:col-span-2">
                    <span className="font-bold text-pink-400 flex items-center gap-1.5">
                      <span className="w-2 h-2 rounded-full bg-pink-400" /> BOTH OUT (Double SL Hit)
                    </span>
                    <p className="text-[11px] text-zinc-300 mt-1">
                      Market experienced a severe two-way whipsaw, triggering Stop Losses on both CE and PE legs.
                    </p>
                  </div>
                </div>
              </div>

              <div>
                <h4 className="text-zinc-100 font-bold mb-1.5 text-xs uppercase tracking-wider">Highlight Borders &amp; Metrics</h4>
                <ul className="list-disc pl-5 space-y-1.5 text-zinc-400 text-[11px]">
                  <li><strong className="text-sky-300">Sky Blue Highlight Box:</strong> The single SL% that generated the highest P&L for that specific timestamp column.</li>
                  <li><strong className="text-zinc-200">VaR (Value at Risk):</strong> The deepest intra-trade paper drawdown experienced before reaching the current PnL.</li>
                  <li><strong className="text-zinc-200">Click Any Cell:</strong> Opens the trade drilldown modal with exact fill prices, SL trigger levels, and time of exit.</li>
                </ul>
              </div>
            </div>
          )}

          {guideTab === 'strategy' && (
            <div className="space-y-4">
              <div className="p-3 rounded-xl bg-zinc-900 border border-zinc-800 space-y-2">
                <h4 className="text-emerald-400 font-bold text-xs flex items-center gap-1.5">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Best Practices for Straddle Execution
                </h4>
                <ul className="list-disc pl-5 space-y-1.5 text-zinc-300 text-[11px]">
                  <li>
                    <strong>Timing Edge:</strong> Avoid entering immediately at 09:15 during high opening spread. 09:20–09:45 entries consistently show lower whipsaws and better premium-to-decay capture.
                  </li>
                  <li>
                    <strong>Optimal SL Sweet Spot:</strong> 25% to 35% SL typically offers the best balance between cutting a trending move early and avoiding minor intraday chop.
                  </li>
                  <li>
                    <strong>Expiry Day (0 DTE) Behavior:</strong> On expiry days, theta decay accelerates dramatically after 13:00, making 15%–25% SL afternoon straddles highly profitable.
                  </li>
                </ul>
              </div>

              <div className="p-3 rounded-xl bg-amber-950/20 border border-amber-500/30 text-amber-300 space-y-1 text-[11px]">
                <p className="font-bold flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" /> Managing High-Volatility Days (Whipsaw Warning)
                </p>
                <p className="text-zinc-400">
                  If the matrix shows widespread &quot;BOTH OUT&quot; (pink cells) across morning timestamps, the market is range-expanding in both directions. In such regimes, widening SL to 40%+ or switching to directional credit spreads is advisable.
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Modal Footer */}
        <div className="px-6 py-3 border-t border-zinc-800 bg-zinc-900/60 flex justify-end shrink-0">
          <button
            onClick={onClose}
            className="px-4 py-1.5 rounded-lg bg-sky-500 hover:bg-sky-400 text-zinc-950 text-xs font-bold transition-colors cursor-pointer"
          >
            Got It
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Cell Detail Modal Component ────────────────────────────────────────────
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

  const { badge, label } = getCellVisuals(cell.status, false);

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
              <p className="text-[11px] text-zinc-400">Leg-wise execution &amp; Stop Loss details</p>
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
        <div className="p-5 space-y-4 font-sans text-xs">
          {/* Status & Net PnL Card */}
          <div className={cn(
            'p-4 rounded-xl border flex items-center justify-between',
            isProfit
              ? 'bg-emerald-950/30 border-emerald-500/30'
              : 'bg-red-950/30 border-red-500/30'
          )}>
            <div>
              <span className="text-[11px] font-medium uppercase tracking-wider text-zinc-400 block">
                Trade Result
              </span>
              <div className="flex items-center gap-2 mt-0.5">
                <span className={cn(
                  'text-xl font-bold font-mono',
                  isProfit ? 'text-emerald-400' : 'text-red-400'
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
              <span className={cn('inline-block px-2.5 py-1 rounded-md text-xs font-bold border mt-0.5', badge)}>
                {label}
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
                  'text-[10px] font-semibold px-2 py-0.5 rounded border',
                  cell.ce_out ? 'bg-amber-500/20 text-amber-400 border-amber-500/30' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                )}>
                  {cell.ce_out ? `SL Hit @ ${cell.ce_exit_time || '—'}` : 'Holding'}
                </span>
              </div>
              <div className="space-y-1 text-xs font-mono">
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Entry:</span>
                  <span className="text-zinc-200">₹{cell.ce_entry.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>SL ({cell.sl_pct}%):</span>
                  <span className="text-amber-400">₹{(cell.ce_entry * (1 + cell.sl_pct / 100)).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Exit / LTP:</span>
                  <span className="text-zinc-200">₹{cell.ce_exit.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 pt-1 border-t border-zinc-800/60 font-sans font-medium">
                  <span>Leg P&amp;L:</span>
                  <span className={cn('font-mono font-bold', (cell.ce_entry - cell.ce_exit) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
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
                  'text-[10px] font-semibold px-2 py-0.5 rounded border',
                  cell.pe_out ? 'bg-purple-500/20 text-purple-400 border-purple-500/30' : 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30'
                )}>
                  {cell.pe_out ? `SL Hit @ ${cell.pe_exit_time || '—'}` : 'Holding'}
                </span>
              </div>
              <div className="space-y-1 text-xs font-mono">
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Entry:</span>
                  <span className="text-zinc-200">₹{cell.pe_entry.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>SL ({cell.sl_pct}%):</span>
                  <span className="text-purple-400">₹{(cell.pe_entry * (1 + cell.sl_pct / 100)).toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 font-sans">
                  <span>Exit / LTP:</span>
                  <span className="text-zinc-200">₹{cell.pe_exit.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-zinc-400 pt-1 border-t border-zinc-800/60 font-sans font-medium">
                  <span>Leg P&amp;L:</span>
                  <span className={cn('font-mono font-bold', (cell.pe_entry - cell.pe_exit) >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                    {formatVal(cell.pe_entry - cell.pe_exit)} {unitLabel}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Additional Stats */}
          <div className="p-3 rounded-xl bg-zinc-950/40 border border-zinc-800/80 flex items-center justify-between text-xs text-zinc-400">
            <span className="flex items-center gap-1.5 font-sans">
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

// ─── Main Component ─────────────────────────────────────────────────────────
export default function StraddleLiveMatrix() {
  const [mode, setMode] = useState<'live' | 'historical'>('historical');
  const [underlying, setUnderlying] = useState<string>('NIFTY');
  const [expiry, setExpiry] = useState<string>('');
  const [selectedDate, setSelectedDate] = useState<string>('2026-07-28');
  const [interval, setInterval] = useState<string>('30');
  const [unit, setUnit] = useState<'pts' | 'inr'>('pts');
  const [autoRefreshSecs, setAutoRefreshSecs] = useState<number>(0);
  const [activeViewTab, setActiveViewTab] = useState<'matrix' | 'timeSeries' | 'slCurve'>('matrix');

  const [data, setData] = useState<StraddleMatrixResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [refreshing, setRefreshing] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<string>('');
  const [readmeOpen, setReadmeOpen] = useState<boolean>(false);

  // Selected cell for drilldown modal
  const [selectedModal, setSelectedModal] = useState<{
    cell: MatrixCell;
    colData: ColumnData;
  } | null>(null);

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

  useEffect(() => {
    setLoading(true);
    fetchData();
  }, [fetchData]);

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

  const bestSlMap = useMemo(() => {
    if (!data?.columns) return new Map<string, number>();
    const map = new Map<string, number>();
    data.columns.forEach((col) => {
      map.set(col.time, col.best_sl_pct);
    });
    return map;
  }, [data]);

  // Derived chart datasets
  const timeSeriesChartData = useMemo(() => {
    if (!data?.columns) return [];
    let cum = 0;
    return data.columns.map(col => {
      cum += col.pnl_pts;
      return {
        time: col.time,
        strike: col.strike,
        bestSl: col.best_sl,
        pnl_pts: col.pnl_pts,
        pnl_inr: +(col.pnl_pts * lotSize).toFixed(2),
        cum_pnl_pts: +cum.toFixed(2),
        cum_pnl_inr: +(cum * lotSize).toFixed(2),
        var_pts: col.var_pts,
      };
    });
  }, [data, lotSize]);

  const slCurveChartData = useMemo(() => {
    if (!data?.sl_rows) return [];
    return data.sl_rows.map(row => ({
      sl_label: row.sl_label,
      sl_pct: row.sl_pct,
      row_total_pts: row.row_total,
      row_total_inr: +(row.row_total * lotSize).toFixed(2),
    }));
  }, [data, lotSize]);

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      {/* ─── Sticky Header Control Bar ───────────────────────────────────── */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-sky-500/10 border border-sky-500/25 shrink-0">
            <Layers className="w-4 h-4 text-sky-400" />
          </div>
          <div>
            <p className="text-[9px] font-bold text-sky-500 uppercase tracking-[0.18em] mb-0.5">
              Options · ATM Straddle SL Matrix
            </p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">
              Straddle Performance &amp; Stop Loss Matrix
            </h1>
            <p className="text-[10px] text-zinc-500 font-medium mt-1">
              Multi-timestamp ATM entry simulations across 10% to 100% leg-wise Stop Losses
            </p>
          </div>
        </div>

        <NavBar />

        {/* Global Controls & Buttons */}
        <div className="flex items-center gap-2.5 flex-wrap ml-auto">
          {/* Readme Button */}
          <button
            onClick={() => setReadmeOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-sky-500/15 hover:bg-sky-500/25 border border-sky-500/30 text-sky-300 text-xs font-bold transition-all cursor-pointer shadow-sm"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>How to Use / Readme</span>
          </button>

          {/* Mode Switcher */}
          <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
            <button
              onClick={() => {
                setMode('live');
                setAutoRefreshSecs(15);
              }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-md transition-all cursor-pointer',
                mode === 'live'
                  ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              <Radio className={cn('h-3.5 w-3.5', mode === 'live' ? 'text-emerald-400 animate-pulse' : 'text-zinc-500')} />
              <span>Live</span>
            </button>
            <button
              onClick={() => {
                setMode('historical');
                setAutoRefreshSecs(0);
              }}
              className={cn(
                'flex items-center gap-1.5 px-3 py-1 text-xs font-bold rounded-md transition-all cursor-pointer',
                mode === 'historical'
                  ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40 shadow-sm'
                  : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              <History className={cn('h-3.5 w-3.5', mode === 'historical' ? 'text-sky-400' : 'text-zinc-500')} />
              <span>Past Simulation</span>
            </button>
          </div>

          {/* Underlying Picker */}
          <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
            {['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'SENSEX'].map((und) => (
              <button
                key={und}
                onClick={() => {
                  setUnderlying(und);
                  setExpiry('');
                }}
                className={cn(
                  'px-2.5 py-1 text-xs font-bold rounded-md transition-all cursor-pointer',
                  underlying === und
                    ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                    : 'text-zinc-400 hover:text-zinc-200'
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
              className="bg-zinc-900 border border-zinc-800 text-xs font-bold text-zinc-200 rounded-lg px-2.5 py-1.5 outline-none hover:border-emerald-500/40 cursor-pointer"
            >
              {data.all_expiries.map((exp) => (
                <option key={exp} value={exp}>
                  Exp: {exp}
                </option>
              ))}
            </select>
          )}

          {/* Unit Toggle: Pts vs ₹ */}
          <div className="flex items-center rounded-lg bg-zinc-900 border border-zinc-800 p-0.5">
            <button
              onClick={() => setUnit('pts')}
              className={cn(
                'px-2.5 py-1 text-xs font-bold rounded-md transition-all cursor-pointer',
                unit === 'pts' ? 'bg-zinc-800 text-white shadow-sm' : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              Pts
            </button>
            <button
              onClick={() => setUnit('inr')}
              className={cn(
                'px-2.5 py-1 text-xs font-bold rounded-md transition-all cursor-pointer',
                unit === 'inr' ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40' : 'text-zinc-400 hover:text-zinc-200'
              )}
            >
              ₹ ({lotSize})
            </button>
          </div>

          {/* Data Date Chip */}
          <span className="text-[10px] font-mono font-bold text-amber-300 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
            DATA: {data?.data_date || selectedDate || '—'}
          </span>

          {/* Refresh / Run Button */}
          <button
            onClick={() => fetchData(true)}
            disabled={refreshing || loading}
            className="h-8 w-8 flex items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-emerald-400 hover:border-emerald-500/40 transition-colors disabled:opacity-50 cursor-pointer"
            title="Refresh straddle matrix"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin text-emerald-400')} />
          </button>
        </div>
      </header>

      {/* ─── Main Content Body ────────────────────────────────────────────── */}
      <main className="flex-1 flex flex-col gap-4 px-6 py-5">
        {/* Historical Date Picker Bar (when in historical mode) */}
        {mode === 'historical' && (
          <div className="flex items-center gap-3 p-3 rounded-xl bg-zinc-900/60 border border-zinc-800 flex-wrap">
            <div className="flex items-center gap-2">
              <Calendar className="w-4 h-4 text-sky-400" />
              <span className="text-xs font-bold text-zinc-300">Simulation Date:</span>
              <input
                type="date"
                value={selectedDate}
                onChange={(e) => {
                  setSelectedDate(e.target.value);
                  setExpiry('');
                }}
                className="bg-zinc-950 border border-zinc-800 text-xs font-bold text-zinc-100 rounded-lg px-2.5 py-1 outline-none focus:border-sky-500 cursor-pointer"
              />
            </div>

            <div className="flex items-center gap-1.5 ml-auto">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider">Quick Expiries:</span>
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
                    'px-2.5 py-1 text-xs font-mono font-semibold rounded-lg transition-all cursor-pointer',
                    selectedDate === s.d
                      ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                      : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
                  )}
                >
                  {s.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Error Banner */}
        {error && (
          <div className="p-4 rounded-xl border border-red-500/30 bg-red-950/20 text-red-400 text-xs font-mono flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => fetchData(true)}
              className="px-3 py-1 rounded bg-red-500/20 text-red-300 hover:bg-red-500/30 text-xs font-bold"
            >
              Retry
            </button>
          </div>
        )}

        {/* Loading Spinner */}
        {loading && !data && (
          <div className="flex flex-col items-center justify-center py-28 gap-3">
            <div className="w-8 h-8 border-2 border-zinc-700 border-t-sky-400 rounded-full animate-spin" />
            <p className="text-sm text-zinc-400 font-medium">Simulating Straddles &amp; Stop Losses for {selectedDate || 'Today'}…</p>
          </div>
        )}

        {!loading && data && (
          <>
            {/* ─── Straddle Pulse Ribbon ───────────────────────────────── */}
            <div className="relative overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
              <div className="pointer-events-none absolute inset-0 bg-gradient-to-r from-sky-500/[0.06] via-transparent to-emerald-500/[0.04]" />

              <div className="relative grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-5">
                {/* 1. Best Combined SL P&L */}
                <PulseStat
                  label="Combined Best SL P&L"
                  value={formatVal(data.summary.total_best_pnl_pts)}
                  color={data.summary.total_best_pnl_pts >= 0 ? 'text-emerald-400' : 'text-red-400'}
                  sub={`${data.summary.total_best_pnl_pts >= 0 ? '+' : ''}${data.summary.total_best_pnl_pts.toFixed(2)} pts across ${data.summary.entries_count} entries`}
                  icon={TrendingUp}
                />

                {/* 2. Win Rate */}
                <PulseStat
                  label="Win Rate (Best SL)"
                  value={`${data.summary.win_rate_pct.toFixed(1)}%`}
                  color="text-emerald-400"
                  sub={`${data.summary.profitable_entries} of ${data.summary.entries_count} entries profitable`}
                  icon={CheckCircle2}
                />

                {/* 3. Optimal Fixed SL */}
                <PulseStat
                  label="Best Fixed SL Overall"
                  value={data.summary.best_fixed_sl}
                  color="text-sky-400"
                  sub={`Total: ${formatVal(data.summary.best_fixed_sl_pnl)} ${unitLabel}`}
                  icon={Zap}
                />

                {/* 4. Total VaR / Max Drawdown */}
                <PulseStat
                  label="Total VaR (Worst Dip)"
                  value={formatVal(data.summary.total_var_pts, false)}
                  color="text-red-400"
                  sub={`${data.summary.total_var_pts.toFixed(2)} pts maximum adverse excursion`}
                  icon={ShieldAlert}
                />

                {/* 5. Grand Row Total */}
                <PulseStat
                  label="Matrix Grand Sum"
                  value={formatVal(data.summary.grand_row_total)}
                  color={data.summary.grand_row_total >= 0 ? 'text-emerald-400' : 'text-red-400'}
                  sub={`Sum of all ${data.summary.entries_count * 10} simulated cells`}
                  icon={Layers}
                />

                {/* 6. Current Spot / DTE */}
                <PulseStat
                  label="Underlying & DTE"
                  value={`${data.underlying} (${data.dte} DTE)`}
                  color="text-zinc-200"
                  sub={`Current Spot: ₹${fmt(data.current_spot, 2)}`}
                  icon={Clock}
                />
              </div>
            </div>

            {/* ─── View Mode Switcher & Legend ─────────────────────────── */}
            <div className="flex items-center justify-between gap-3 border-b border-zinc-800 pb-2 flex-wrap">
              <div className="flex items-center bg-zinc-900 border border-zinc-800 p-1 rounded-xl gap-1">
                {[
                  { id: 'matrix', label: 'Straddle SL Matrix Grid', icon: Layers },
                  { id: 'timeSeries', label: 'Entry P&L & Cumulative Curve', icon: BarChart2 },
                  { id: 'slCurve', label: 'SL% Efficacy Curve (10%-100%)', icon: TrendingUp },
                ].map(tab => {
                  const Icon = tab.icon;
                  const isActive = activeViewTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => setActiveViewTab(tab.id as typeof activeViewTab)}
                      className={cn(
                        'flex items-center gap-2 px-3.5 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer',
                        isActive
                          ? 'bg-sky-500/15 text-sky-400 border border-sky-500/30 shadow-sm'
                          : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                      )}
                    >
                      <Icon className="w-3.5 h-3.5" />
                      <span>{tab.label}</span>
                    </button>
                  );
                })}
              </div>

              {/* Matrix Legend */}
              <div className="flex items-center gap-3 text-xs text-zinc-400 flex-wrap">
                <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-500">States:</span>
                <span className="inline-flex items-center gap-1 text-[11px] text-emerald-300">
                  <span className="w-2 h-2 rounded-full bg-emerald-400" /> intact+
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-red-300">
                  <span className="w-2 h-2 rounded-full bg-red-400" /> intact-
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-amber-300">
                  <span className="w-2 h-2 rounded-full bg-amber-400" /> CE out
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-purple-300">
                  <span className="w-2 h-2 rounded-full bg-purple-400" /> PE out
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-pink-300">
                  <span className="w-2 h-2 rounded-full bg-pink-400" /> both out
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-sky-300 font-bold pl-2 border-l border-zinc-800">
                  <span className="w-2.5 h-2.5 rounded border border-sky-400 bg-sky-500/30" /> Best SL
                </span>
              </div>
            </div>

            {/* ─── TAB 1: STRADDLE MATRIX GRID ─────────────────────────── */}
            {activeViewTab === 'matrix' && (
              <CardPanel
                title={`ATM Straddle Simulation Grid — ${data.underlying} (${data.expiry})`}
                eyebrow="Stop-Loss vs Timestamp Matrix"
                icon={Layers}
                accent="text-sky-400"
              >
                <div className="overflow-x-auto">
                  <table className="w-full border-collapse font-mono text-xs">
                    <thead>
                      {/* Row 1: PnL / Timestamps */}
                      <tr className="bg-zinc-800 border-b border-zinc-700">
                        <th className="py-2.5 px-3 text-xs font-bold text-white uppercase tracking-wider text-left sticky left-0 z-20 bg-zinc-800 min-w-[90px] border-r border-zinc-700">
                          PnL
                        </th>
                        {data.columns.map((col) => (
                          <th
                            key={col.time}
                            className="py-2.5 px-2 text-xs font-bold text-white uppercase tracking-wider text-center min-w-[76px] whitespace-nowrap"
                          >
                            {col.time}
                          </th>
                        ))}
                        <th className="py-2.5 px-3 text-xs font-bold text-white uppercase tracking-wider text-right border-l border-zinc-700 min-w-[90px]">
                          Total
                        </th>
                      </tr>

                      {/* Row 2: ATM Strike */}
                      <tr className="border-b border-zinc-800 bg-zinc-950/80 font-bold">
                        <th className="py-2 px-3 text-left text-zinc-400 sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800 font-sans text-[11px]">
                          ATM Strike
                        </th>
                        {data.columns.map((col) => (
                          <td key={col.time} className="py-2 px-2 text-center text-zinc-200">
                            {col.strike}
                          </td>
                        ))}
                        <td className="py-2 px-3 text-right text-zinc-600 border-l border-zinc-800">
                          —
                        </td>
                      </tr>

                      {/* Row 3: Entry Premium */}
                      <tr className="border-b border-zinc-800 bg-zinc-950/80">
                        <th className="py-2 px-3 text-left text-zinc-400 sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800 font-sans text-[11px]">
                          Combined Entry
                        </th>
                        {data.columns.map((col) => (
                          <td key={col.time} className="py-2 px-2 text-center text-zinc-400">
                            {col.entry.toFixed(2)}
                          </td>
                        ))}
                        <td className="py-2 px-3 text-right text-zinc-600 border-l border-zinc-800">
                          —
                        </td>
                      </tr>

                      {/* Row 4: LTP Premium */}
                      <tr className="border-b border-zinc-700 bg-zinc-950/90 font-bold">
                        <th className="py-2 px-3 text-left text-zinc-400 sticky left-0 z-10 bg-zinc-950 border-r border-zinc-700 font-sans text-[11px]">
                          LTP / Settlement
                        </th>
                        {data.columns.map((col) => (
                          <td key={col.time} className="py-2 px-2 text-center text-zinc-300">
                            {col.ltp.toFixed(2)}
                          </td>
                        ))}
                        <td className="py-2 px-3 text-right text-zinc-600 border-l border-zinc-700">
                          —
                        </td>
                      </tr>
                    </thead>

                    {/* SL Rows Body (10% to 100%) */}
                    <tbody>
                      {data.sl_rows.map((row) => (
                        <tr key={row.sl_pct} className="border-b border-zinc-900/80 hover:bg-zinc-850/50 transition-colors">
                          <th className="py-2 px-3 text-left font-bold text-zinc-200 sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800/80">
                            {row.sl_label}
                          </th>

                          {row.cells.map((cell) => {
                            const isBest = bestSlMap.get(cell.time) === cell.sl_pct;
                            const colInfo = data.columns.find((c) => c.time === cell.time);
                            const { bg } = getCellVisuals(cell.status, isBest);

                            return (
                              <td
                                key={cell.time}
                                onClick={() => {
                                  if (colInfo) setSelectedModal({ cell, colData: colInfo });
                                }}
                                className={cn(
                                  'py-2 px-2 text-center text-xs font-semibold tabular-nums cursor-pointer transition-all border border-zinc-900',
                                  bg,
                                  isBest && 'ring-2 ring-inset ring-sky-400 font-bold text-white shadow-[0_0_8px_rgba(56,189,248,0.3)] z-10'
                                )}
                                title={`Click for breakdown: ${cell.time} SL ${cell.sl_pct}% (P&L: ${cell.pnl_pts} pts)`}
                              >
                                {formatVal(cell.pnl_pts)}
                              </td>
                            );
                          })}

                          {/* Row Total */}
                          <td className={cn(
                            'py-2 px-3 text-right font-bold border-l border-zinc-800 tabular-nums whitespace-nowrap',
                            row.row_total >= 0 ? 'text-emerald-400 bg-emerald-950/20' : 'text-red-400 bg-red-950/20'
                          )}>
                            {formatVal(row.row_total)}
                          </td>
                        </tr>
                      ))}
                    </tbody>

                    {/* Summary Footer */}
                    <tfoot className="border-t-2 border-zinc-700 bg-zinc-950/95 font-bold">
                      {/* 1. Sum across SLs */}
                      <tr className="border-b border-zinc-800">
                        <td className="py-2.5 px-3 text-left text-zinc-300 uppercase sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800 font-sans text-xs">
                          Column Sum
                        </td>
                        {data.columns.map((col) => (
                          <td
                            key={col.time}
                            className={cn(
                              'py-2.5 px-2 text-center tabular-nums whitespace-nowrap',
                              col.col_total >= 0 ? 'text-emerald-400' : 'text-red-400'
                            )}
                          >
                            {formatVal(col.col_total)}
                          </td>
                        ))}
                        <td className={cn(
                          'py-2.5 px-3 text-right font-extrabold border-l border-zinc-800 tabular-nums whitespace-nowrap',
                          data.summary.total_col_sum_pts >= 0 ? 'text-emerald-400 bg-emerald-950/30' : 'text-red-400 bg-red-950/30'
                        )}>
                          {formatVal(data.summary.total_col_sum_pts)}
                        </td>
                      </tr>

                      {/* 2. Best SL setting */}
                      <tr className="border-b border-zinc-800 bg-zinc-900/50">
                        <td className="py-2 px-3 text-left text-sky-400 uppercase sticky left-0 z-10 bg-zinc-900 border-r border-zinc-800 font-sans text-xs">
                          Best SL
                        </td>
                        {data.columns.map((col) => (
                          <td key={col.time} className="py-2 px-2 text-center text-sky-300 font-extrabold">
                            {col.best_sl}
                          </td>
                        ))}
                        <td className="py-2 px-3 text-right text-zinc-500 border-l border-zinc-800">
                          —
                        </td>
                      </tr>

                      {/* 3. PnL of Best SL */}
                      <tr className="border-b border-zinc-800 bg-zinc-950">
                        <td className="py-2.5 px-3 text-left text-emerald-400 uppercase sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800 font-sans text-xs">
                          Best SL PnL
                        </td>
                        {data.columns.map((col) => (
                          <td
                            key={col.time}
                            className={cn(
                              'py-2.5 px-2 text-center font-extrabold tabular-nums whitespace-nowrap',
                              col.pnl_pts >= 0 ? 'text-emerald-400' : 'text-red-400'
                            )}
                          >
                            {formatVal(col.pnl_pts)}
                          </td>
                        ))}
                        <td className={cn(
                          'py-2.5 px-3 text-right font-black border-l border-zinc-800 tabular-nums whitespace-nowrap',
                          data.summary.total_best_pnl_pts >= 0 ? 'text-emerald-400 bg-emerald-950/40' : 'text-red-400 bg-red-950/40'
                        )}>
                          {formatVal(data.summary.total_best_pnl_pts)}
                        </td>
                      </tr>

                      {/* 4. VaR / Worst Dip */}
                      <tr className="bg-zinc-950">
                        <td className="py-2 px-3 text-left text-red-400 uppercase sticky left-0 z-10 bg-zinc-950 border-r border-zinc-800 font-sans text-xs">
                          VaR (Worst Dip)
                        </td>
                        {data.columns.map((col) => (
                          <td key={col.time} className="py-2 px-2 text-center text-red-400 font-bold tabular-nums whitespace-nowrap">
                            {formatVal(col.var_pts, false)}
                          </td>
                        ))}
                        <td className="py-2 px-3 text-right font-bold text-red-400 bg-red-950/30 border-l border-zinc-800 tabular-nums whitespace-nowrap">
                          {formatVal(data.summary.total_var_pts, false)}
                        </td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </CardPanel>
            )}

            {/* ─── TAB 2: TIME SERIES & CUMULATIVE PnL ─────────────────── */}
            {activeViewTab === 'timeSeries' && (
              <div className="flex flex-col gap-4">
                {/* 1. Bar Chart: Best SL P&L per Entry Timestamp */}
                <CardPanel
                  title="Best SL P&L by Entry Timestamp"
                  eyebrow="Intraday Timing Alpha"
                  icon={BarChart2}
                  accent="text-emerald-400"
                >
                  <div className="p-5">
                    <ResponsiveContainer width="100%" height={340}>
                      <BarChart
                        data={timeSeriesChartData}
                        margin={{ top: 15, right: 15, left: -10, bottom: 5 }}
                        barCategoryGap="25%"
                      >
                        <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 11, fill: '#a1a1aa', fontWeight: 600, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={{ stroke: '#27272a' }}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={v => `${v} ${unitLabel}`}
                        />
                        <Tooltip
                          cursor={{ fill: '#27272a', opacity: 0.5 }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload as { time: string; strike: number; bestSl: string; pnl_pts: number; pnl_inr: number; var_pts: number };
                            return (
                              <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[210px] font-mono">
                                <p className="text-zinc-100 font-bold mb-2 font-sans">{label} Straddle ({d.strike})</p>
                                <div className="flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
                                  <span>Optimal SL</span>
                                  <span className="text-sky-400 font-bold font-mono">{d.bestSl}</span>
                                </div>
                                <div className="flex justify-between gap-6 mb-1 text-zinc-400 font-sans">
                                  <span>PnL</span>
                                  <span className={cn('font-bold font-mono', d.pnl_pts >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                    {unit === 'inr' ? `₹${d.pnl_inr}` : `${d.pnl_pts.toFixed(2)} pts`}
                                  </span>
                                </div>
                                <div className="pt-2 border-t border-zinc-800 flex justify-between gap-6 text-zinc-400 font-sans">
                                  <span>Worst Intra-Trade Dip</span>
                                  <span className="text-red-400 font-bold font-mono">{d.var_pts.toFixed(2)} pts</span>
                                </div>
                              </div>
                            );
                          }}
                        />
                        <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                        <Bar dataKey={unit === 'inr' ? 'pnl_inr' : 'pnl_pts'} radius={[3, 3, 0, 0]}>
                          {timeSeriesChartData.map(d => (
                            <Cell key={d.time} fill={d.pnl_pts >= 0 ? '#34d399' : '#f87171'} />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardPanel>

                {/* 2. Cumulative Return Line Chart */}
                <CardPanel
                  title="Cumulative Straddle Returns Across Session"
                  eyebrow="Session Compounding Progression"
                  icon={TrendingUp}
                  accent="text-sky-400"
                >
                  <div className="p-5">
                    <ResponsiveContainer width="100%" height={320}>
                      <LineChart
                        data={timeSeriesChartData}
                        margin={{ top: 15, right: 15, left: -10, bottom: 5 }}
                      >
                        <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                        <XAxis
                          dataKey="time"
                          tick={{ fontSize: 11, fill: '#a1a1aa', fontWeight: 600, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={{ stroke: '#27272a' }}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={v => `${v} ${unitLabel}`}
                        />
                        <Tooltip
                          cursor={{ stroke: '#3f3f46', strokeWidth: 1, strokeDasharray: '4 4' }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload as { time: string; cum_pnl_pts: number; cum_pnl_inr: number };
                            return (
                              <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[200px] font-mono">
                                <p className="text-zinc-100 font-bold mb-1.5 font-sans">Cumulative @ {label}</p>
                                <div className="flex justify-between gap-6 text-zinc-400 font-sans">
                                  <span>Cum PnL</span>
                                  <span className={cn('font-bold font-mono', d.cum_pnl_pts >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                    {unit === 'inr' ? `₹${d.cum_pnl_inr}` : `${d.cum_pnl_pts.toFixed(2)} pts`}
                                  </span>
                                </div>
                              </div>
                            );
                          }}
                        />
                        <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                        <Line
                          type="monotone"
                          dataKey={unit === 'inr' ? 'cum_pnl_inr' : 'cum_pnl_pts'}
                          stroke="#38bdf8"
                          strokeWidth={2.5}
                          dot={{ fill: '#38bdf8', stroke: '#0369a1', strokeWidth: 2, r: 4 }}
                          activeDot={{ fill: '#38bdf8', stroke: '#ffffff', strokeWidth: 2, r: 6 }}
                        />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                </CardPanel>
              </div>
            )}

            {/* ─── TAB 3: SL% EFFICACY CURVE ───────────────────────────── */}
            {activeViewTab === 'slCurve' && (
              <div className="flex flex-col gap-4">
                <CardPanel
                  title="Aggregate P&L by Stop Loss Setting (10% to 100%)"
                  eyebrow="Stop-Loss Parameter Optimization"
                  icon={TrendingUp}
                  accent="text-emerald-400"
                >
                  <div className="p-5">
                    <ResponsiveContainer width="100%" height={380}>
                      <BarChart
                        data={slCurveChartData}
                        margin={{ top: 15, right: 15, left: -10, bottom: 5 }}
                        barCategoryGap="25%"
                      >
                        <CartesianGrid strokeDasharray="3 6" stroke="#20202399" vertical={false} />
                        <XAxis
                          dataKey="sl_label"
                          tick={{ fontSize: 11, fill: '#a1a1aa', fontWeight: 600, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={{ stroke: '#27272a' }}
                        />
                        <YAxis
                          tick={{ fontSize: 10, fill: '#a1a1aa', fontWeight: 500, fontFamily: 'var(--font-mono)' }}
                          tickLine={false}
                          axisLine={false}
                          tickFormatter={v => `${v} ${unitLabel}`}
                        />
                        <Tooltip
                          cursor={{ fill: '#27272a', opacity: 0.5 }}
                          content={({ active, payload, label }) => {
                            if (!active || !payload?.length) return null;
                            const d = payload[0].payload as { sl_label: string; row_total_pts: number; row_total_inr: number };
                            return (
                              <div className="bg-zinc-950/98 border border-zinc-700/70 rounded-xl px-4 py-3 text-xs shadow-2xl backdrop-blur min-w-[200px] font-mono">
                                <p className="text-zinc-100 font-bold mb-1.5 font-sans">Stop Loss: {label}</p>
                                <div className="flex justify-between gap-6 text-zinc-400 font-sans">
                                  <span>Total Return</span>
                                  <span className={cn('font-bold font-mono', d.row_total_pts >= 0 ? 'text-emerald-400' : 'text-red-400')}>
                                    {unit === 'inr' ? `₹${d.row_total_inr}` : `${d.row_total_pts.toFixed(2)} pts`}
                                  </span>
                                </div>
                              </div>
                            );
                          }}
                        />
                        <ReferenceLine y={0} stroke="#52525b" strokeWidth={1.5} />
                        <Bar dataKey={unit === 'inr' ? 'row_total_inr' : 'row_total_pts'} radius={[3, 3, 0, 0]}>
                          {slCurveChartData.map(d => (
                            <Cell
                              key={d.sl_label}
                              fill={d.row_total_pts >= 0 ? (d.sl_label === data.summary.best_fixed_sl ? '#38bdf8' : '#34d399') : '#f87171'}
                            />
                          ))}
                        </Bar>
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </CardPanel>

                {/* Parameter Explanation Notice */}
                <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 text-xs text-zinc-400 space-y-1">
                  <p className="font-bold text-zinc-200 flex items-center gap-1.5">
                    <Info className="w-4 h-4 text-sky-400" /> Stop-Loss Sensitivity Note
                  </p>
                  <p>
                    Tighter Stop Losses (10%–20%) exit quickly on minor noise, reducing single-trade drawdowns but suffering from multiple re-entry friction. Wider Stop Losses (40%–60%) endure higher intra-day drawdown (VaR) but allow the winning leg to capture full theta decay during normal consolidations.
                  </p>
                </div>
              </div>
            )}
          </>
        )}
      </main>

      {/* ─── Cell Drilldown Modal ─────────────────────────────────────────── */}
      {selectedModal && (
        <CellDetailModal
          cell={selectedModal.cell}
          colData={selectedModal.colData}
          lotSize={lotSize}
          unit={unit}
          onClose={() => setSelectedModal(null)}
        />
      )}

      {/* ─── Readme & Guide Modal ─────────────────────────────────────────── */}
      <StraddleReadmeModal
        open={readmeOpen}
        onClose={() => setReadmeOpen(false)}
      />
    </div>
  );
}
