'use client';

import React, { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import NavBar from './NavBar';
import {
  Copy, Trash2, Settings, Share2, Save, Info, Plus, Calendar,
  Square, RefreshCw, History, ExternalLink, Download, FileText, Search, X,
  Clock, Eye, ChevronLeft, ChevronRight, Layers, CheckCircle2, ArrowUpRight, ArrowDownRight
} from 'lucide-react';
import { toast } from 'sonner';

// Lazy-load recharts so initial bundle stays lightweight
const BacktestCharts = dynamic(() => import('@/components/BacktestCharts'), {
  ssr: false,
  loading: () => <div className="h-64 bg-zinc-900 border border-zinc-800 rounded-xl animate-pulse" />,
});

// ─── Types ───────────────────────────────────────────────────────────────────

export interface BacktestHistoryItem {
  id: string;
  name: string;
  timestamp: string;
  strategy_type?: string;
  start_date?: string;
  end_date?: string;
  trades?: number;
  win_rate?: number;
  total_pnl?: number;
  max_drawdown?: number;
  has_tearsheet?: boolean;
  has_trades_csv?: boolean;
  has_scans_summary?: boolean;
  has_report?: boolean;
  tags?: string[];
}

type StrikeMode = 'offset' | 'atm_percent' | 'closest_premium' | 'straddle_width' | 'cp_based_on_sp' | 'closest_delta';

type CpOperator = 'closest' | 'gte' | 'lte';

type WaitAndTradeType = 'pct_up' | 'pct_down' | 'pts_up' | 'pts_down';

type ReEntryType = 'asap' | 'cost';

interface LegConfig {
  option_type: 'CE' | 'PE';
  position: 'sell' | 'buy';
  lots: number;
  strike: string;          // offset string, or a %/premium/delta value depending on strike_type
  leg_sl_pct: number;      // 0 = disabled
  leg_target_pct: number;  // 0 = disabled
  leg_trail_sl_pct?: number; // 0 = disabled
  strike_type?: StrikeMode;
  cp_operator?: CpOperator; // 'closest' (~), 'gte' (>=), 'lte' (<=)
  wait_and_trade_val?: number; // 0 = disabled (immediate entry)
  wait_and_trade_type?: WaitAndTradeType; // 'pct_up' (% ↑), 'pct_down' (% ↓), 'pts_up' (Pts ↑), 'pts_down' (Pts ↓)
  re_entry_sl_count?: number; // 0 = disabled
  re_entry_sl_type?: ReEntryType; // 'asap' | 'cost'
  re_execute_sl_count?: number; // 0 = disabled
  re_execute_tp_count?: number; // 0 = disabled
  re_entry_tp_count?: number; // 0 = disabled
}

interface LegResult {
  option_type: string;
  position: string;
  strike: number;
  lots: number;
  entry_price: number | null;
  exit_price: number | null;
  pnl: number;
  exit_reason: string;
  entry_time?: string | null;
  exit_time?: string | null;
}

interface CycleResult {
  expiry_date: string;
  entry_dt: string | null;
  exit_dt: string | null;
  entry_spot: number | null;
  vix: number | null;
  net_credit: number | null;
  exit_combined: number | null;
  pnl: number;
  exit_reason: string;
  is_complete: boolean;
  rolls?: number;
  legs: LegResult[];
}

interface BacktestSummary {
  total_cycles: number;
  traded_cycles: number;
  wins: number;
  losses: number;
  win_rate: number;
  total_pnl: number;
  avg_pnl: number;
  max_win: number;
  max_loss: number;
  avg_win: number;
  avg_loss: number;
  max_drawdown: number;
  max_drawdown_start: string;
  max_drawdown_end: string;
  max_drawdown_days: number | null;
  max_trades_in_drawdown: number;
  max_win_streak: number;
  max_loss_streak: number;
  return_maxdd_ratio: number | null;
  reward_risk_ratio: number | null;
  expectancy: number;
  expectancy_ratio: number | null;
  commission_paid: number;
}

type MonthlyPnl = Record<string, Record<string, number>>;

interface VbtComparisonRow {
  Metric: string;
  [col: string]: string;
}

interface VbtBlock {
  stats?: Record<string, unknown>;
  comparison?: VbtComparisonRow[];
  tearsheet_available?: boolean;
  monte_carlo_summary?: string | null;
  error?: string;
}

interface BacktestResult {
  summary: BacktestSummary;
  cycles: CycleResult[];
  equity_curve: { date: string; cumulative_pnl: number }[];
  monthly_pnl: MonthlyPnl;
  params: Record<string, unknown>;
  vbt?: VbtBlock | null;
}

// pf.stats() ships raw float precision — same 2-decimal-cap convention as the
// (now-retired) directional-strategy VectorBT page.
function formatVbtStat(key: string, val: unknown): string {
  if (val === null || val === undefined) return '—';
  if (typeof val === 'number') {
    const isWhole = Number.isInteger(val);
    const rounded = val.toLocaleString('en-IN', {
      maximumFractionDigits: 2,
      minimumFractionDigits: isWhole ? 0 : 2,
    });
    return key.includes('[%]') ? `${rounded}%` : rounded;
  }
  return String(val);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const STRIKE_MODES = [
  'ATM Point',
  'ATM Percent',
  'Straddle Width',
  'Closest Premium (CP)',
  'CP based on Straddle Premium (SP)',
] as const;

type StrikeModeLabel = typeof STRIKE_MODES[number];

const STRIKE_OPTIONS = [
  'ATM',
  ...Array.from({ length: 10 }, (_, i) => `ATM+${i + 1}`),
  ...Array.from({ length: 10 }, (_, i) => `ATM-${i + 1}`),
];

// StockMock ATM Percent increments (0.25% steps up to 5%)
const ATM_PERCENT_OPTIONS = [
  'ATM',
  ...Array.from({ length: 20 }, (_, i) => `ATM+${((i + 1) * 0.25).toFixed(2).replace(/\.?0+$/, '')}%`),
  ...Array.from({ length: 20 }, (_, i) => `ATM-${((i + 1) * 0.25).toFixed(2).replace(/\.?0+$/, '')}%`),
];

// StockMock Straddle Width increments (0.25*SP steps up to 5*SP)
const STRADDLE_WIDTH_OPTIONS = [
  'ATM',
  ...Array.from({ length: 20 }, (_, i) => `ATM+${((i + 1) * 0.25).toFixed(2).replace(/\.?0+$/, '')}*SP`),
  ...Array.from({ length: 20 }, (_, i) => `ATM-${((i + 1) * 0.25).toFixed(2).replace(/\.?0+$/, '')}*SP`),
];

// StockMock Closest Premium Operators (~, >=, <=)
const CP_OPERATORS = [
  { label: 'CP ~', value: 'closest' as CpOperator, title: 'Closest to target premium' },
  { label: 'CP >=', value: 'gte' as CpOperator, title: 'Closest premium greater than or equal to target' },
  { label: 'CP <=', value: 'lte' as CpOperator, title: 'Closest premium less than or equal to target' },
] as const;

// StockMock CP based on Straddle Premium percentage options (5% SP to 100% SP)
const CP_SP_OPTIONS = Array.from({ length: 20 }, (_, i) => `${(i + 1) * 5}% SP`);

// StockMock Wait & Trade direction types
const WAIT_AND_TRADE_TYPES = [
  { label: 'W&T % ↑', value: 'pct_up' as WaitAndTradeType, title: 'Wait for price to rise by percentage' },
  { label: 'W&T % ↓', value: 'pct_down' as WaitAndTradeType, title: 'Wait for price to fall by percentage' },
  { label: 'W&T Pts ↑', value: 'pts_up' as WaitAndTradeType, title: 'Wait for price to rise by points' },
  { label: 'W&T Pts ↓', value: 'pts_down' as WaitAndTradeType, title: 'Wait for price to fall by points' },
] as const;

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const EXIT_REASON_CLS: Record<string, string> = {
  TARGET:        'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  SCALP_FLOOR:   'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  LEG_TARGET:    'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
  EOD:           'bg-sky-500/15 text-sky-400 border border-sky-500/30',
  LEG_SL:        'bg-red-500/15 text-red-400 border border-red-500/30',
  LEG_TRAIL_SL:  'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  TRAIL_SL:      'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  ALL_LEGS_DONE: 'bg-red-500/15 text-red-400 border border-red-500/30',
  SQUARE_OFF_ALL: 'bg-purple-500/15 text-purple-400 border border-purple-500/30',
  OVERALL_SL:    'bg-red-500/20 text-red-400 border border-red-500/40',
  INCOMPLETE:    'bg-amber-500/15 text-amber-400 border border-amber-500/30',
  ROLL_ATM:      'bg-purple-500/15 text-purple-400 border border-purple-500/30',
  NO_ENTRY:      'bg-zinc-800 text-zinc-400 border border-zinc-700',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────

function fmt(n: number) {
  return Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 });
}
function fmtPnl(n: number) {
  return `${n >= 0 ? '+' : '-'}₹${fmt(n)}`;
}
function fmtNum(n: number | null, decimals = 2): string {
  if (n == null) return '—';
  return n.toFixed(decimals);
}
function fmtDate(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}
function fmtTime(iso: string | null): string {
  return iso ? iso.slice(11, 16) : '—';
}

// Short label for a cycle's actual leg composition — the trade log used to hardcode
// "STRADDLE" for every row, which is wrong for anything but a 2-leg ATM CE+PE sell
// (e.g. the Iron Condor preset, or a single naked leg). Falls back to that label only
// when the legs genuinely match a short straddle shape.
function cycleTypeLabel(legs: LegResult[]): string {
  if (!legs.length) return '—';
  const isShortStraddle = legs.length === 2
    && legs.every(l => l.position === 'sell')
    && legs.some(l => l.option_type === 'CE') && legs.some(l => l.option_type === 'PE');
  if (isShortStraddle) return 'STRADDLE';
  return legs.map(l => `${l.position === 'sell' ? 'S' : 'B'}${l.option_type}`).join('/');
}

function formatStockMockDate(dateStr: string): string {
  try {
    const parts = dateStr.split('-');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${days[d.getDay()]}, ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`;
    }
    return dateStr;
  } catch {
    return dateStr;
  }
}

function formatExpiryShort(dateStr: string): string {
  try {
    const cleanDate = dateStr.slice(0, 10);
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const months = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
      return `${String(d.getDate()).padStart(2, '0')} ${months[d.getMonth()]}`;
    }
    return dateStr;
  } catch {
    return dateStr;
  }
}

function formatDayFull(dateStr: string | null): string {
  if (!dateStr) return '—';
  try {
    const cleanDate = dateStr.slice(0, 10);
    const parts = cleanDate.split('-');
    if (parts.length === 3) {
      const d = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10));
      const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      return `${days[d.getDay()]}, ${months[d.getMonth()]} ${String(d.getDate()).padStart(2, '0')}, ${d.getFullYear()}`;
    }
    return dateStr;
  } catch {
    return dateStr;
  }
}

export interface OrderExecutionItem {
  id: number;
  time: string;
  side: 'BUY' | 'SELL';
  action: 'ENTRY' | 'EXIT' | 'ADJUSTMENT';
  instrument: string;
  lots: number;
  qty: number;
  price: number;
  turnover: number;
  pnl?: number;
  reason: string;
  strike: number;
  optionType: string;
}

export function getTimewiseOrders(c: CycleResult, lotSize: number = 65): OrderExecutionItem[] {
  const orders: OrderExecutionItem[] = [];
  let seq = 1;
  const expiryFormatted = c.expiry_date ? formatExpiryShort(c.expiry_date) : '';
  const defaultEntryTime = c.entry_dt ? fmtTime(c.entry_dt) : '09:20';
  const defaultExitTime = c.exit_dt ? fmtTime(c.exit_dt) : '15:15';

  // 1. Entry orders for each leg
  c.legs.forEach((leg) => {
    if (leg.entry_price != null && leg.entry_price > 0) {
      const time = leg.entry_time || defaultEntryTime;
      const side = (leg.position.toUpperCase() === 'BUY' ? 'BUY' : 'SELL') as 'BUY' | 'SELL';
      const lots = leg.lots || 1;
      const qty = lots * lotSize;
      const price = leg.entry_price;
      orders.push({
        id: seq++,
        time,
        side,
        action: 'ENTRY',
        instrument: `NIFTY ${expiryFormatted} ${Math.round(leg.strike)} ${leg.option_type}`.trim(),
        lots,
        qty,
        price,
        turnover: price * qty,
        reason: 'Initial Strategy Entry',
        strike: leg.strike,
        optionType: leg.option_type,
      });
    }
  });

  // 2. Exit orders for each leg
  c.legs.forEach((leg) => {
    const exitPrice = leg.exit_price != null 
      ? Math.abs(leg.exit_price) 
      : (c.exit_combined != null ? Math.abs(c.exit_combined) / c.legs.length : leg.entry_price);
    if (exitPrice != null && exitPrice > 0) {
      const time = leg.exit_time || defaultExitTime;
      // Exit side is reverse of entry position: sell leg is bought back, buy leg is sold
      const side = (leg.position.toLowerCase() === 'sell' ? 'BUY' : 'SELL') as 'BUY' | 'SELL';
      const lots = leg.lots || 1;
      const qty = lots * lotSize;
      const reason = leg.exit_reason || c.exit_reason || 'Exit';
      const action = reason.includes('ROLL') || reason.includes('SHIFT') ? 'ADJUSTMENT' : 'EXIT';
      orders.push({
        id: seq++,
        time,
        side,
        action,
        instrument: `NIFTY ${expiryFormatted} ${Math.round(leg.strike)} ${leg.option_type}`.trim(),
        lots,
        qty,
        price: exitPrice,
        turnover: exitPrice * qty,
        pnl: leg.pnl,
        reason,
        strike: leg.strike,
        optionType: leg.option_type,
      });
    }
  });

  // Sort orders chronologically by execution time (ENTRY before ADJUSTMENT before EXIT)
  const actionPriority: Record<string, number> = { ENTRY: 1, ADJUSTMENT: 2, EXIT: 3 };
  orders.sort((a, b) => {
    const tCmp = a.time.localeCompare(b.time);
    if (tCmp !== 0) return tCmp;
    const pA = actionPriority[a.action] || 2;
    const pB = actionPriority[b.action] || 2;
    if (pA !== pB) return pA - pB;
    return a.id - b.id;
  });
  // Re-number sequence IDs
  orders.forEach((o, idx) => { o.id = idx + 1; });
  return orders;
}

function computeYearMDD(curve: { date: string; cumulative_pnl: number }[], year: string) {
  const pts = curve.filter(p => p.date.startsWith(year));
  if (!pts.length) return { mdd: 0, days: null };
  let peak = pts[0].cumulative_pnl;
  let peakIdx = 0;
  let mdd = 0;
  let mddDays: number | null = null;
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].cumulative_pnl > peak) {
      peak = pts[i].cumulative_pnl;
      peakIdx = i;
    }
    const dd = peak - pts[i].cumulative_pnl;
    if (dd > mdd) {
      mdd = dd;
      try {
        const d1 = new Date(pts[peakIdx].date);
        const d2 = new Date(pts[i].date);
        mddDays = Math.round((d2.getTime() - d1.getTime()) / 86400000);
      } catch { mddDays = null; }
    }
  }
  return { mdd: Math.round(mdd), days: mddDays };
}

// ─── Subcomponents ────────────────────────────────────────────────────────────

function DateInputBox({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const formatted = formatStockMockDate(value);

  return (
    <div className="flex-1 flex flex-col">
      <span className="text-[11px] text-zinc-400 font-medium mb-1">{label}</span>
      <div
        onClick={() => inputRef.current?.showPicker ? inputRef.current.showPicker() : inputRef.current?.focus()}
        className="relative bg-zinc-800 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-100 font-medium cursor-pointer flex items-center justify-between hover:border-teal-400 transition-colors shadow-xs"
      >
        <span>{formatted}</span>
        <Calendar className="w-3.5 h-3.5 text-zinc-400" />
        <input
          ref={inputRef}
          type="date"
          value={value}
          onChange={e => e.target.value && onChange(e.target.value)}
          className="absolute inset-0 opacity-0 cursor-pointer w-full h-full"
        />
      </div>
    </div>
  );
}

// ─── Default Initial Legs ────────────────────────────────────────────────────

const DEFAULT_STOCKMOCK_LEGS: LegConfig[] = [
  { option_type: 'CE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0, strike_type: 'offset' },
  { option_type: 'PE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0, strike_type: 'offset' },
];

interface OptionsBacktesterProps {
  /** Base API route this page's Start/Stop/poll requests hit — lets
   * /backtest-signals point the identical leg-builder UI at the VectorBT
   * CLI (app/api/backtest-vectorbt) instead of the plain Python engine
   * (app/api/backtest, the default) while running the exact same simulation. */
  apiBase?: string;
  pageTitle?: string;
}

export default function OptionsBacktester({
  apiBase = '/api/backtest',
  pageTitle,
}: OptionsBacktesterProps = {}) {
  // ── Strike mode selection (Top radios)
  const [selectedStrikeMode, setSelectedStrikeMode] = useState<StrikeModeLabel>('ATM Point');

  // ── Form builder row
  const [builderIndex, setBuilderIndex] = useState('Nifty');
  const [builderSegment, setBuilderSegment] = useState<'Futures' | 'Options'>('Options');
  const [builderOptionType, setBuilderOptionType] = useState<'Call' | 'Put'>('Call');
  const [builderActionType, setBuilderActionType] = useState<'Buy' | 'Sell'>('Sell');
  const [builderStrike, setBuilderStrike] = useState('ATM');
  const [builderCpOperator, setBuilderCpOperator] = useState<CpOperator>('closest');
  const [builderLots, setBuilderLots] = useState(1);

  // ── Underlying & execution options
  const [selectedMainIndex, setSelectedMainIndex] = useState('Nifty');
  const [squareOffMode, setSquareOffMode] = useState<'one_leg' | 'all_legs'>('one_leg');
  const [waitAndTradeActive, setWaitAndTradeActive] = useState(false);
  const [reEntryActive, setReEntryActive] = useState(false);

  // ── Active Legs
  const [legs, setLegs] = useState<LegConfig[]>(DEFAULT_STOCKMOCK_LEGS);
  const [lotSize, setLotSize] = useState(65);

  // ── Strategy timing & exits
  const [entryH, setEntryH] = useState('9');
  const [entryM, setEntryM] = useState('22');
  const [entryS, setEntryS] = useState('00');

  const [exitH, setExitH] = useState('15');
  const [exitM, setExitM] = useState('15');
  const [exitS, setExitS] = useState('00');

  // Strategy target & SL
  const [strategyTargetActive, setStrategyTargetActive] = useState(false);
  const [profitTargetType, setProfitTargetType] = useState<'mtm' | 'pct'>('mtm');
  const [profitTargetVal, setProfitTargetVal] = useState(0);

  const [strategySlActive, setStrategySlActive] = useState(false);
  const [overallSlType, setOverallSlType] = useState<'mtm' | 'pct'>('mtm');
  const [overallSlVal, setOverallSlVal] = useState(0);

  const [protectProfitsActive, setProtectProfitsActive] = useState(false);
  const [trailSlPct, setTrailSlPct] = useState(0);

  // Dates & bottom controls
  const [startDate, setStartDate] = useState('2026-08-17');
  const [endDate, setEndDate] = useState('2026-09-17');
  const [executionType, setExecutionType] = useState<'INTRADAY' | 'POSITIONAL'>('INTRADAY');

  // Advanced settings & modal
  const [settingsModalOpen, setSettingsModalOpen] = useState(false);
  const [includeCosts, setIncludeCosts] = useState(false);
  const [commissionPerLot, setCommissionPerLot] = useState(40);
  const [slippagePct, setSlippagePct] = useState(0);
  const [adjustmentMode, setAdjustmentMode] = useState<'none' | 'rolling_straddle'>('none');
  const [rollBuffer, setRollBuffer] = useState(35);
  const [rollType, setRollType] = useState<'points' | 'percentage'>('points');
  const [maxRolls, setMaxRolls] = useState(5);
  const [scalpFloorPct, setScalpFloorPct] = useState(0);

  // Balanced Entry / Price Diff Gate
  const [priceDiffActive, setPriceDiffActive] = useState(false);
  const [maxDiffPct, setMaxDiffPct] = useState(10);
  const [entryCutoffTime, setEntryCutoffTime] = useState('15:00');

  // Results & execution
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusData, setStatusData] = useState<{
    percent?: number;
    current?: number;
    total?: number;
    date?: string;
    stage?: string;
    pnl?: number;
    trades?: number;
  } | null>(null);

  const pollRef = useRef<NodeJS.Timeout | null>(null);
  const resultsRef = useRef<HTMLDivElement>(null);

  // Past Backtests History
  const [historyModalOpen, setHistoryModalOpen] = useState(false);
  const [historyList, setHistoryList] = useState<BacktestHistoryItem[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const [historySearch, setHistorySearch] = useState('');
  const [loadedFromHistory, setLoadedFromHistory] = useState<BacktestHistoryItem | null>(null);
  const [viewingTearsheetId, setViewingTearsheetId] = useState<string | null>(null);
  const [viewingReportId, setViewingReportId] = useState<string | null>(null);

  // Day trade execution modal
  const [selectedDayCycle, setSelectedDayCycle] = useState<CycleResult | null>(null);
  const [dayModalTab, setDayModalTab] = useState<'timeline' | 'legs'>('timeline');

  // Keyboard navigation for Day Trade Execution modal
  useEffect(() => {
    if (!selectedDayCycle || !result) return;
    const filtered = result.cycles.filter(c => c.exit_reason !== 'NO_ENTRY');
    const idx = filtered.findIndex(
      item => item === selectedDayCycle || (item.entry_dt === selectedDayCycle.entry_dt && item.expiry_date === selectedDayCycle.expiry_date)
    );

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setSelectedDayCycle(null);
      } else if (e.key === 'ArrowLeft' && idx > 0) {
        setSelectedDayCycle(filtered[idx - 1]);
      } else if (e.key === 'ArrowRight' && idx < filtered.length - 1) {
        setSelectedDayCycle(filtered[idx + 1]);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedDayCycle, result]);

  const fetchHistory = React.useCallback(async () => {
    setLoadingHistory(true);
    try {
      const res = await fetch('/api/backtest/history');
      const data = await res.json();
      if (Array.isArray(data.backtests)) {
        setHistoryList(data.backtests);
      }
    } catch (e) {
      console.error('Failed to fetch backtest history:', e);
    } finally {
      setLoadingHistory(false);
    }
  }, []);

  useEffect(() => {
    fetchHistory();
  }, [fetchHistory]);

  async function handleLoadHistoryItem(id: string) {
    try {
      const res = await fetch(`/api/backtest/history?id=${encodeURIComponent(id)}`);
      const data = await res.json();
      if (!data.result) {
        toast.error('Failed to load backtest result');
        return;
      }
      setResult(data.result);
      setLoadedFromHistory(data.metadata || null);

      const p = data.result.params || {};
      if (p.start_date) setStartDate(String(p.start_date));
      if (p.end_date) setEndDate(String(p.end_date));
      if (p.lot_size) setLotSize(Number(p.lot_size));
      if (p.profit_target_val !== undefined && Number(p.profit_target_val) > 0) {
        setProfitTargetVal(Number(p.profit_target_val));
        setProfitTargetType((p.profit_target_type as 'mtm' | 'pct') || 'pct');
        setStrategyTargetActive(true);
      } else if (p.profit_target_pct) {
        setProfitTargetVal(Number(p.profit_target_pct));
        setProfitTargetType('pct');
        setStrategyTargetActive(true);
      }
      if (p.overall_sl_val !== undefined && Number(p.overall_sl_val) > 0) {
        setOverallSlVal(Number(p.overall_sl_val));
        setOverallSlType((p.overall_sl_type as 'mtm' | 'pct') || 'pct');
        setStrategySlActive(true);
      } else if (p.overall_sl_pct) {
        setOverallSlVal(Number(p.overall_sl_pct));
        setOverallSlType('pct');
        setStrategySlActive(true);
      }
      if (p.max_diff_pct !== undefined && Number(p.max_diff_pct) > 0) {
        setMaxDiffPct(Number(p.max_diff_pct));
        setPriceDiffActive(true);
      } else if (p.max_diff_pct !== undefined) {
        setPriceDiffActive(false);
      }
      if (p.entry_cutoff_time) {
        setEntryCutoffTime(String(p.entry_cutoff_time));
      }
      if (p.entry_time) {
        const parts = String(p.entry_time).split(':');
        if (parts[0]) setEntryH(parts[0]);
        if (parts[1]) setEntryM(parts[1]);
      }
      if (p.eod_time) {
        const parts = String(p.eod_time).split(':');
        if (parts[0]) setExitH(parts[0]);
        if (parts[1]) setExitM(parts[1]);
      }
      if (Array.isArray(p.legs) && p.legs.length > 0) {
        setLegs(p.legs.map((l: any) => ({
          option_type: l.option_type || 'CE',
          position: l.position || 'sell',
          lots: l.lots || 1,
          strike: String(l.strike || 'ATM'),
          strike_type: l.strike_type || 'offset',
          leg_sl_pct: l.leg_sl_pct || 0,
          leg_target_pct: l.leg_target_pct || 0,
          leg_trail_sl_pct: l.leg_trail_sl_pct || 0,
        })));
      }
      setHistoryModalOpen(false);
      toast.success(`Loaded backtest: ${data.metadata?.name || id}`);
      setTimeout(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth' });
      }, 200);
    } catch (e) {
      toast.error(`Error loading backtest: ${e}`);
    }
  }

  const filteredHistory = historyList.filter(item => {
    if (!historySearch.trim()) return true;
    const query = historySearch.toLowerCase();
    const nameMatch = (item.name || '').toLowerCase().includes(query);
    const idMatch = (item.id || '').toLowerCase().includes(query);
    const tagMatch = (item.tags || []).some(t => t.toLowerCase().includes(query));
    const dateMatch = `${item.start_date || ''} ${item.end_date || ''}`.toLowerCase().includes(query);
    return nameMatch || idMatch || tagMatch || dateMatch;
  });

  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  // Fetch current NIFTY lot size
  useEffect(() => {
    fetch('/api/lotsize?symbol=NIFTY')
      .then(r => r.json())
      .then(d => { if (d.lot_size) setLotSize(d.lot_size); })
      .catch(() => {});
  }, []);

  // Map strike mode to Leg strike_type.
  function strikeModeToType(m: StrikeModeLabel): StrikeMode {
    if (m === 'ATM Percent') return 'atm_percent';
    if (m === 'Closest Premium (CP)') return 'closest_premium';
    if (m === 'Straddle Width') return 'straddle_width';
    if (m === 'CP based on Straddle Premium (SP)') return 'cp_based_on_sp';
    return 'offset';
  }

  // Placeholder/default strike value per mode, used both by the top toolbar and
  // by a leg row's own strike-mode dropdown so a mode switch always leaves a
  // valid option instead of a stale offset string like "ATM+3".
  function defaultStrikeValueFor(m: StrikeModeLabel): string {
    if (m === 'ATM Point') return 'ATM';
    if (m === 'ATM Percent') return 'ATM';
    if (m === 'Straddle Width') return 'ATM';
    if (m === 'Closest Premium (CP)') return '25';
    return '5% SP'; // CP based on Straddle Premium (SP)
  }

  // ─── Actions ───────────────────────────────────────────────────────────────

  function handleAddPosition() {
    // The backtest engine only prices CE/PE option legs (Options Data/NIFTY/) — there
    // is no futures-leg support at all. Silently adding a mislabeled options leg when
    // "Futures" is selected would be worse than refusing, since nothing on screen
    // would show the leg doesn't actually match what was picked.
    if (builderSegment === 'Futures') {
      toast.error('Futures legs are not supported yet — switch Select Segment to Options');
      return;
    }
    const isCpMode = selectedStrikeMode.includes('(CP)') || selectedStrikeMode.includes('(SP)');
    const defaultStrike = selectedStrikeMode.includes('(SP)') ? '5% SP' : selectedStrikeMode.includes('(CP)') ? '25' : 'ATM';
    const newLeg: LegConfig = {
      option_type: builderOptionType === 'Call' ? 'CE' : 'PE',
      position: builderActionType.toLowerCase() as 'buy' | 'sell',
      lots: Math.max(1, builderLots),
      strike: builderStrike || defaultStrike,
      strike_type: strikeModeToType(selectedStrikeMode),
      cp_operator: isCpMode ? builderCpOperator : undefined,
      leg_sl_pct: 0,
      leg_target_pct: 0,
      leg_trail_sl_pct: 0,
      wait_and_trade_val: 0,
      wait_and_trade_type: 'pct_up',
    };
    setLegs(prev => [...prev, newLeg]);
    toast.success(`Added ${builderActionType} ${builderOptionType} (${newLeg.strike})`);
  }

  function handleCloneLeg(index: number) {
    const target = legs[index];
    if (!target) return;
    setLegs(prev => [...prev, { ...target }]);
    toast.success(`Cloned Leg ${index + 1}`);
  }

  function handleRemoveLeg(index: number) {
    if (legs.length <= 1) {
      toast.error('Strategy must contain at least one leg');
      return;
    }
    setLegs(prev => prev.filter((_, i) => i !== index));
  }

  function handleUpdateLeg(index: number, patch: Partial<LegConfig>) {
    setLegs(prev => prev.map((l, i) => (i === index ? { ...l, ...patch } : l)));
  }

  function applyPreset(name: string) {
    if (name === 'straddle_35sl') {
      setEntryH('9'); setEntryM('20');
      setExitH('15'); setExitM('15');
      setProfitTargetVal(50);
      setProfitTargetType('pct');
      setStrategyTargetActive(true);
      setOverallSlVal(0);
      setOverallSlType('pct');
      setStrategySlActive(false);
      setAdjustmentMode('none');
      setScalpFloorPct(0);
      setTrailSlPct(0);
      setLegs([
        { option_type: 'CE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 35, leg_target_pct: 0, strike_type: 'offset' },
        { option_type: 'PE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 35, leg_target_pct: 0, strike_type: 'offset' },
      ]);
      toast.success('Loaded 9:20 Short Straddle (35% Leg SL)');
    } else if (name === 'rolling_straddle') {
      setEntryH('9'); setEntryM('20');
      setExitH('15'); setExitM('15');
      setProfitTargetVal(60);
      setProfitTargetType('pct');
      setStrategyTargetActive(true);
      setAdjustmentMode('rolling_straddle');
      setRollBuffer(35);
      setRollType('points');
      setMaxRolls(5);
      setLegs([
        { option_type: 'CE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0, strike_type: 'offset' },
        { option_type: 'PE', position: 'sell', lots: 1, strike: 'ATM', leg_sl_pct: 0, leg_target_pct: 0, strike_type: 'offset' },
      ]);
      toast.success('Loaded Intraday Rolling Straddle');
    } else if (name === 'strangle_20delta') {
      setEntryH('9'); setEntryM('25');
      setExitH('15'); setExitM('15');
      setLegs([
        { option_type: 'CE', position: 'sell', lots: 1, strike: '20', strike_type: 'closest_delta', leg_sl_pct: 40, leg_target_pct: 0 },
        { option_type: 'PE', position: 'sell', lots: 1, strike: '20', strike_type: 'closest_delta', leg_sl_pct: 40, leg_target_pct: 0 },
      ]);
      toast.success('Loaded 20-Delta Strangle');
    } else if (name === 'iron_condor') {
      setEntryH('9'); setEntryM('30');
      setExitH('15'); setExitM('15');
      setLegs([
        { option_type: 'CE', position: 'sell', lots: 1, strike: '25', strike_type: 'closest_delta', leg_sl_pct: 0, leg_target_pct: 0 },
        { option_type: 'PE', position: 'sell', lots: 1, strike: '25', strike_type: 'closest_delta', leg_sl_pct: 0, leg_target_pct: 0 },
        { option_type: 'CE', position: 'buy',  lots: 1, strike: '10', strike_type: 'closest_delta', leg_sl_pct: 0, leg_target_pct: 0 },
        { option_type: 'PE', position: 'buy',  lots: 1, strike: '10', strike_type: 'closest_delta', leg_sl_pct: 0, leg_target_pct: 0 },
      ]);
      toast.success('Loaded Iron Condor');
    }
  }

  async function stopBacktest() {
    try {
      await fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop' }),
      });
    } catch { /* ignore */ }
    if (pollRef.current) clearInterval(pollRef.current);
    setLoading(false);
    setStatusData(null);
    toast.info('Backtest cancelled');
  }

  async function runBacktest() {
    if (legs.length === 0) {
      toast.error('Add at least one leg before starting backtest');
      return;
    }

    const entryTimeFormatted = `${String(entryH).padStart(2, '0')}:${String(entryM).padStart(2, '0')}`;
    const eodTimeFormatted = `${String(exitH).padStart(2, '0')}:${String(exitM).padStart(2, '0')}`;

    setLoading(true);
    setError(null);
    setResult(null);
    setStatusData({ percent: 0, current: 0, total: 0 });

    if (pollRef.current) clearInterval(pollRef.current);

    try {
      const res = await fetch(apiBase, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'start',
          legs: legs.map(l => ({
            ...l,
            wait_and_trade_val: waitAndTradeActive ? (l.wait_and_trade_val ?? 0) : 0,
            wait_and_trade_type: l.wait_and_trade_type ?? 'pct_up',
            re_entry_sl_count: reEntryActive ? (l.re_entry_sl_count ?? 0) : 0,
            re_entry_sl_type: l.re_entry_sl_type ?? 'asap',
            re_execute_sl_count: reEntryActive ? (l.re_execute_sl_count ?? 0) : 0,
            re_execute_tp_count: reEntryActive ? (l.re_execute_tp_count ?? 0) : 0,
            re_entry_tp_count: reEntryActive ? (l.re_entry_tp_count ?? 0) : 0,
          })),
          lot_size: lotSize,
          profit_target_val: strategyTargetActive ? profitTargetVal : 0,
          profit_target_type: profitTargetType,
          profit_target_pct: strategyTargetActive && profitTargetType === 'pct' ? profitTargetVal : 0,
          overall_sl_val: strategySlActive ? overallSlVal : 0,
          overall_sl_type: overallSlType,
          overall_sl_pct: strategySlActive && overallSlType === 'pct' ? overallSlVal : 0,
          entry_time: entryTimeFormatted,
          eod_time: eodTimeFormatted,
          commission_per_lot: includeCosts ? commissionPerLot : 0,
          slippage_pct: includeCosts ? slippagePct : 0,
          strategy_type: executionType === 'POSITIONAL' ? 'first_day' : 'intraday',
          start_date: startDate,
          end_date: endDate,
          adjustment_mode: adjustmentMode,
          roll_buffer: rollBuffer,
          roll_type: rollType,
          max_rolls: maxRolls,
          scalp_floor_pct: scalpFloorPct,
          trail_sl_pct: protectProfitsActive ? trailSlPct : 0,
          square_off_mode: squareOffMode,
          max_diff_pct: priceDiffActive ? maxDiffPct : 0,
          entry_cutoff_time: entryCutoffTime,
        }),
      });

      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || 'Failed to start backtest');

      // The VectorBT CLI writes its own "done" status the instant the Python-engine
      // simulation finishes, then briefly flips it back to "running" while it computes
      // VectorBT stats before writing the final result — a poll can in principle land
      // in that sub-millisecond gap and see done=true with no result/error/stopped yet.
      // Tolerate a few consecutive empty "done" reads before treating it as a real
      // failure, instead of bailing out (and stopping the poll) on the first one.
      let emptyDoneStreak = 0;
      const MAX_EMPTY_DONE_POLLS = 3;

      pollRef.current = setInterval(async () => {
        try {
          const sRes = await fetch(apiBase);
          const sData = await sRes.json();
          if (sData.running || (!sData.done && sData.percent !== undefined)) {
            emptyDoneStreak = 0;
            setStatusData({
              percent: sData.percent ?? 0,
              current: sData.current ?? 0,
              total: sData.total ?? 0,
              date: sData.date,
              stage: sData.stage,
              pnl: sData.pnl,
              trades: sData.trades,
            });
          } else if (sData.done) {
            if (sData.stopped) {
              if (pollRef.current) clearInterval(pollRef.current);
              setLoading(false);
              setError('Backtest stopped by user');
            } else if (sData.result) {
              if (pollRef.current) clearInterval(pollRef.current);
              setLoading(false);
              setResult(sData.result);
              setLoadedFromHistory(null);
              fetchHistory();
              setStatusData(null);
              toast.success('Backtest complete!');
              setTimeout(() => {
                resultsRef.current?.scrollIntoView({ behavior: 'smooth' });
              }, 200);
            } else if (sData.error) {
              if (pollRef.current) clearInterval(pollRef.current);
              setLoading(false);
              setError(sData.error);
              toast.error(sData.error);
            } else if (emptyDoneStreak < MAX_EMPTY_DONE_POLLS) {
              emptyDoneStreak += 1;
            } else {
              if (pollRef.current) clearInterval(pollRef.current);
              setLoading(false);
              const msg = 'Backtest completed or exited unexpectedly without results';
              setError(msg);
              toast.error(msg);
            }
          }
        } catch {
          // ignore transient poll error
        }
      }, 1000);
    } catch (e) {
      if (pollRef.current) clearInterval(pollRef.current);
      setLoading(false);
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      toast.error(msg);
    }
  }

  function handleSaveStrategy() {
    const payload = {
      legs,
      entryTime: `${entryH}:${entryM}`,
      exitTime: `${exitH}:${exitM}`,
      startDate,
      endDate,
      lotSize,
      target: strategyTargetActive ? profitTargetVal : 0,
      targetType: profitTargetType,
      sl: strategySlActive ? overallSlVal : 0,
      slType: overallSlType,
    };
    try {
      localStorage.setItem('stockmock_saved_strategy', JSON.stringify(payload));
      toast.success('Strategy configuration saved to browser cache!');
    } catch {
      toast.error('Could not save strategy');
    }
  }

  function handleShareStrategy() {
    try {
      navigator.clipboard.writeText(window.location.href);
      toast.success('Strategy link copied to clipboard!');
    } catch {
      toast.error('Failed to copy link');
    }
  }

  const s = result?.summary;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-300 font-sans pb-28 select-none">
      {/* ── Standard Sticky Page Header ── */}
      <div className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-2.5 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur shadow-xs">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-teal-500/10 border border-teal-500/25">
            <History className="w-4 h-4 text-teal-400" />
          </div>
          <div>
            <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-teal-400 mb-0.5">Options · Backtesting</p>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">{pageTitle ?? 'Options Backtester'}</h1>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setSettingsModalOpen(true)}
            className="border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
          >
            <Settings className="w-3.5 h-3.5 text-teal-400" /> Change Settings
          </button>
          <button
            type="button"
            onClick={() => { setHistoryModalOpen(true); fetchHistory(); }}
            className="border border-teal-500/40 bg-teal-500/15 hover:bg-teal-500/25 text-teal-300 px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
          >
            <History className="w-3.5 h-3.5" /> Past Backtests
            {historyList.length > 0 && (
              <span className="ml-1 px-1.5 py-0.2 bg-teal-500/30 rounded-full text-[10px] font-bold text-teal-200">
                {historyList.length}
              </span>
            )}
          </button>
          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </div>

      {/* ── Persistent error banner — the toasts above auto-dismiss, so a run that
           fails or exits without a result needs a non-transient explanation too,
           otherwise the page just silently drops back to the idle builder view. ── */}
      {error && !loading && (
        <div className="w-full max-w-[1550px] mx-auto px-4 pt-3">
          <div className="flex items-start justify-between gap-3 bg-red-50 border border-red-300 text-red-700 rounded px-3 py-2 text-xs">
            <span><strong className="font-bold">Backtest did not complete:</strong> {error}</span>
            <button
              type="button"
              onClick={() => setError(null)}
              className="text-red-500 hover:text-red-700 shrink-0"
            >
              ✕
            </button>
          </div>
        </div>
      )}

      {/* ── Main Container ── */}
      <div className="w-full max-w-[1550px] mx-auto px-4 py-3">

        {/* ── Strike Selection Mode Radios ── */}
        <div className="flex items-center justify-center flex-wrap gap-4 md:gap-7 py-2 text-xs text-zinc-400 font-medium">
          {STRIKE_MODES.map(mode => (
            <label key={mode} className="flex items-center gap-1.5 cursor-pointer hover:text-white transition-colors">
              <input
                type="radio"
                name="strikeMode"
                checked={selectedStrikeMode === mode}
                onChange={() => {
                  setSelectedStrikeMode(mode);
                  // Reset the toolbar's Strike Price field too — without this, switching
                  // to a % / premium mode while an offset like "ATM+3" is still selected
                  // sends that non-numeric string as the strike value, which the backend
                  // silently can't parse and falls back to plain ATM with no indication.
                  setBuilderStrike(defaultStrikeValueFor(mode));
                }}
                className="w-3.5 h-3.5 accent-teal-500 cursor-pointer"
              />
              <span>{mode}</span>
              {(mode.includes('(CP)') || mode.includes('(SP)')) && (
                <span
                  title={
                    mode.includes('(CP)')
                      ? 'This will select strike which is closest to the choosen premium at entry time.'
                      : 'This will select strike which is closest to the choosen percent value of straddle premium at entry time.'
                  }
                  className="cursor-help inline-flex items-center"
                >
                  <Info className="w-3.5 h-3.5 text-zinc-400 hover:text-zinc-200 inline" />
                </span>
              )}
            </label>
          ))}
        </div>

        {/* Dotted Divider */}
        <div className="w-full border-b border-dashed border-zinc-800 my-2.5" />

        {/* ── Position Builder Controls Row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 items-end pt-1 pb-3">
          {/* 1. Select Index — only Nifty has local option data (see the notice below
               the leg rows); the others are shown per the StockMock layout but disabled
               rather than silently accepted and ignored. */}
          <div>
            <label className="block text-[11px] text-zinc-400 font-medium mb-1">Select Index:</label>
            <select
              value={builderIndex}
              onChange={e => setBuilderIndex(e.target.value)}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 font-medium focus:outline-hidden focus:border-teal-500 shadow-xs"
            >
              <option value="Nifty">Nifty</option>
              <option value="Banknifty" disabled title="No local Banknifty option data">Banknifty (no data)</option>
              <option value="FinNifty" disabled title="No local FinNifty option data">FinNifty (no data)</option>
              <option value="Sensex" disabled title="No local Sensex option data">Sensex (no data)</option>
            </select>
          </div>

          {/* 2. Select Segment */}
          <div>
            <label className="block text-[11px] text-zinc-400 font-medium mb-1">Select Segment:</label>
            <div className="flex rounded overflow-hidden border border-zinc-700 shadow-xs">
              <button
                type="button"
                onClick={() => setBuilderSegment('Futures')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderSegment === 'Futures'
                    ? 'bg-teal-600 text-oncolor font-bold'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                Futures
              </button>
              <button
                type="button"
                onClick={() => setBuilderSegment('Options')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderSegment === 'Options'
                    ? 'bg-teal-600 text-oncolor font-bold'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                Options
              </button>
            </div>
          </div>

          {/* 3. Option Type */}
          <div>
            <label className="block text-[11px] text-zinc-400 font-medium mb-1">Option Type:</label>
            <div className="flex rounded overflow-hidden border border-zinc-700 shadow-xs">
              <button
                type="button"
                onClick={() => setBuilderOptionType('Call')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderOptionType === 'Call'
                    ? 'bg-teal-600 text-oncolor font-bold'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                Call
              </button>
              <button
                type="button"
                onClick={() => setBuilderOptionType('Put')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderOptionType === 'Put'
                    ? 'bg-teal-600 text-oncolor font-bold'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                Put
              </button>
            </div>
          </div>

          {/* 4. Action Type */}
          <div>
            <label className="block text-[11px] text-zinc-400 font-medium mb-1">Action Type:</label>
            <div className="flex rounded overflow-hidden border border-zinc-700 shadow-xs">
              <button
                type="button"
                onClick={() => setBuilderActionType('Buy')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderActionType === 'Buy'
                    ? 'bg-teal-600 text-oncolor font-bold'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                Buy
              </button>
              <button
                type="button"
                onClick={() => setBuilderActionType('Sell')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderActionType === 'Sell'
                    ? 'bg-teal-600 text-oncolor font-bold'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                }`}
              >
                Sell
              </button>
            </div>
          </div>

          {/* 5. Strike Price / Closest Premium */}
          <div>
            <label className="block text-[11px] text-zinc-400 font-medium mb-1">
              {(selectedStrikeMode.includes('(CP)') || selectedStrikeMode.includes('(SP)'))
                ? 'Closest Premium:'
                : 'Strike Price:'}
            </label>
            {selectedStrikeMode === 'ATM Point' ? (
              <select
                value={builderStrike}
                onChange={e => setBuilderStrike(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 font-medium focus:outline-hidden focus:border-teal-500 shadow-xs"
              >
                {STRIKE_OPTIONS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : selectedStrikeMode === 'ATM Percent' ? (
              <select
                value={builderStrike}
                onChange={e => setBuilderStrike(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 font-medium focus:outline-hidden focus:border-teal-500 shadow-xs"
              >
                {ATM_PERCENT_OPTIONS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : selectedStrikeMode === 'Straddle Width' ? (
              <select
                value={builderStrike}
                onChange={e => setBuilderStrike(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 font-medium focus:outline-hidden focus:border-teal-500 shadow-xs"
              >
                {STRADDLE_WIDTH_OPTIONS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : selectedStrikeMode === 'Closest Premium (CP)' ? (
              <div className="flex rounded overflow-hidden border border-zinc-700 shadow-xs">
                <select
                  value={builderCpOperator}
                  onChange={e => setBuilderCpOperator(e.target.value as CpOperator)}
                  className="bg-zinc-800 text-teal-400 font-semibold px-2 py-1.5 text-xs border-r border-zinc-700 focus:outline-hidden cursor-pointer"
                  title="Comparator: Closest (~), Greater than or equal (>=), Less than or equal (<=)"
                >
                  {CP_OPERATORS.map(op => (
                    <option key={op.value} value={op.value} title={op.title}>{op.label}</option>
                  ))}
                </select>
                <input
                  type="number"
                  min={0}
                  step={0.5}
                  value={builderStrike}
                  onChange={e => setBuilderStrike(e.target.value)}
                  placeholder="25"
                  className="w-full bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 font-medium focus:outline-hidden focus:border-teal-500"
                />
              </div>
            ) : (
              /* CP based on Straddle Premium (SP) */
              <div className="flex rounded overflow-hidden border border-zinc-700 shadow-xs">
                <select
                  value={builderCpOperator}
                  onChange={e => setBuilderCpOperator(e.target.value as CpOperator)}
                  className="bg-zinc-800 text-teal-400 font-semibold px-2 py-1.5 text-xs border-r border-zinc-700 focus:outline-hidden cursor-pointer"
                  title="Comparator: Closest (~), Greater than or equal (>=), Less than or equal (<=)"
                >
                  {CP_OPERATORS.map(op => (
                    <option key={op.value} value={op.value} title={op.title}>{op.label}</option>
                  ))}
                </select>
                <select
                  value={builderStrike}
                  onChange={e => setBuilderStrike(e.target.value)}
                  className="w-full bg-zinc-800 px-2.5 py-1.5 text-xs text-zinc-100 font-medium focus:outline-hidden focus:border-teal-500 cursor-pointer"
                >
                  {CP_SP_OPTIONS.map(opt => (
                    <option key={opt} value={opt}>{opt}</option>
                  ))}
                </select>
              </div>
            )}
          </div>

          {/* 6. Total Lot */}
          <div>
            <label className="block text-[11px] text-zinc-400 font-medium mb-1">Total Lot</label>
            <input
              type="number"
              min={1}
              value={builderLots}
              onChange={e => setBuilderLots(Math.max(1, Number(e.target.value)))}
              className="w-full bg-zinc-800 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-100 font-medium text-center focus:outline-hidden focus:border-teal-500 shadow-xs"
            />
          </div>

          {/* 7. Expiry Type — same single-expiry-cycle limitation as the per-leg
               dropdown below; the engine always trades the nearest weekly cycle. */}
          <div>
            <label className="block text-[11px] text-zinc-400 font-medium mb-1">Expiry Type:</label>
            <select
              disabled
              defaultValue="Weekly"
              title="Not implemented yet — the engine always trades the nearest weekly expiry"
              className="w-full bg-zinc-800/50 border border-zinc-700 rounded px-2.5 py-1.5 text-xs text-zinc-500 font-medium cursor-not-allowed"
            >
              <option value="Weekly">Weekly</option>
              <option value="Next Weekly">Next Weekly</option>
              <option value="Monthly">Monthly</option>
            </select>
          </div>
        </div>

        {/* Add Position Button */}
        <div className="flex justify-center my-2">
          <button
            type="button"
            onClick={handleAddPosition}
            className="bg-teal-600 hover:bg-teal-500 text-oncolor font-semibold text-xs px-5 py-1.5 rounded shadow-xs transition-colors cursor-pointer flex items-center gap-1.5"
          >
            Add Position
          </button>
        </div>

        {/* ── Settings Bar above Leg Rows ── */}
        <div className="flex items-center justify-between flex-wrap gap-4 pt-3 pb-2 text-xs text-zinc-400">
          {/* Left: Spot / Futures toggle & Index */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2" title="Futures-as-ATM needs a futures price series; the option data here only carries spot">
              <span className="flex items-center gap-1.5 text-xs cursor-not-allowed opacity-50">
                <span className="font-semibold text-zinc-300">
                  Use Spot as ATM
                </span>
                <div className="w-7 h-4 bg-zinc-700 rounded-full relative p-0.5">
                  <div className="w-3 h-3 rounded-full bg-zinc-400 shadow-xs" />
                </div>
                <span className="text-zinc-500">
                  Use Futures as ATM
                </span>
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-zinc-500">Index:</span>
              <select
                value={selectedMainIndex}
                onChange={e => setSelectedMainIndex(e.target.value)}
                className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200 font-medium focus:outline-hidden"
              >
                <option value="Nifty">Nifty</option>
                <option value="Banknifty" disabled title="No local Banknifty option data">Banknifty (no data)</option>
                <option value="Sensex" disabled title="No local Sensex option data">Sensex (no data)</option>
              </select>
            </div>
          </div>

          {/* Right: Square Off mode & check toggles */}
          <div className="flex items-center gap-4 flex-wrap">
            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 cursor-pointer select-none">
                <input
                  type="radio"
                  name="squareOffMode"
                  checked={squareOffMode === 'one_leg'}
                  onChange={() => setSquareOffMode('one_leg')}
                  className="w-3.5 h-3.5 accent-teal-500 cursor-pointer"
                />
                <span className={squareOffMode === 'one_leg' ? 'text-teal-400 font-semibold' : 'text-zinc-300'}>
                  Square Off One Leg
                </span>
                <span
                  title="If any leg Stop Loss or Target Profit Condition is met then only that leg will be Squared off."
                  className="cursor-help inline-flex items-center"
                >
                  <Info className="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
                </span>
              </label>
              <label className="flex items-center gap-1 cursor-pointer select-none">
                <input
                  type="radio"
                  name="squareOffMode"
                  checked={squareOffMode === 'all_legs'}
                  onChange={() => setSquareOffMode('all_legs')}
                  className="w-3.5 h-3.5 accent-teal-500 cursor-pointer"
                />
                <span className={squareOffMode === 'all_legs' ? 'text-teal-400 font-semibold' : 'text-zinc-300'}>
                  Square Off All Legs
                </span>
                <span
                  title="If any leg Stop Loss or Target Profit Condition is met then Square off entire Strategy."
                  className="cursor-help inline-flex items-center"
                >
                  <Info className="w-3 h-3 text-zinc-500 hover:text-zinc-300" />
                </span>
              </label>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={waitAndTradeActive}
                  onChange={e => setWaitAndTradeActive(e.target.checked)}
                  className="w-3.5 h-3.5 accent-teal-500 rounded cursor-pointer"
                />
                <span className={waitAndTradeActive ? 'text-teal-400 font-semibold' : 'text-zinc-300'}>
                  Wait &amp; Trade
                </span>
                <span
                  title="After your entry time, the leg will wait for premium to increase/decrease by specific percent/point to take the entry. Click to watch video."
                  className="cursor-help inline-flex items-center"
                >
                  <Info className="w-3 h-3 text-zinc-500 hover:text-zinc-300 inline" />
                </span>
              </label>
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50" title="Not implemented yet — needs a defined profit threshold that moves the SL">
                <input type="checkbox" disabled className="w-3.5 h-3.5 rounded" />
                <span>Move SL to Cost</span>
                <Info className="w-3 h-3 text-zinc-500" />
              </label>
              <label className="flex items-center gap-1 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={reEntryActive}
                  onChange={e => setReEntryActive(e.target.checked)}
                  className="w-3.5 h-3.5 accent-teal-500 rounded cursor-pointer"
                />
                <span className={reEntryActive ? 'text-teal-400 font-semibold' : 'text-zinc-300'}>
                  Re-Entry / Re-Execute
                </span>
                <span
                  title="Re-Execute: Re-runs entry logic and takes a fresh strike at current market price after SL/TP. Re-Entry: Re-enters the same strike/leg either immediately (ASAP) or when price retraces to original Cost."
                  className="cursor-help inline-flex items-center"
                >
                  <Info className="w-3 h-3 text-zinc-500 hover:text-zinc-300 inline" />
                </span>
              </label>
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50" title="Not implemented yet — needs auto-generated hedge legs">
                <input type="checkbox" disabled className="w-3.5 h-3.5 rounded" />
                <span>Associated Hedge</span>
              </label>
            </div>
          </div>
        </div>

        {/* ── Leg Cards / Rows ── */}
        <div className="flex flex-col gap-2 my-2">
          {legs.map((leg, index) => {
            const isSell = leg.position === 'sell';
            const isCall = leg.option_type === 'CE';
            const strikeMode = leg.strike_type || 'offset';

            return (
              <div
                key={index}
                className="bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-2.5 flex items-center justify-between flex-wrap gap-2.5 shadow-xs"
              >
                {/* Left controls */}
                <div className="flex items-center gap-2.5 flex-wrap">
                  <input
                    type="checkbox"
                    defaultChecked
                    className="w-3.5 h-3.5 accent-teal-500 rounded cursor-pointer"
                  />

                  {/* Leg index badge */}
                  <div className="flex flex-col">
                    <span className="text-[9px] font-bold text-zinc-500 leading-none">L{index + 1}</span>
                    <span className="text-[10px] text-zinc-500 font-medium">Lots:</span>
                  </div>

                  {/* Lots input */}
                  <input
                    type="number"
                    min={1}
                    value={leg.lots}
                    onChange={e => handleUpdateLeg(index, { lots: Math.max(1, Number(e.target.value)) })}
                    className="w-11 bg-zinc-800 border border-zinc-700 rounded px-1 py-0.5 text-xs text-zinc-100 text-center font-semibold focus:outline-hidden"
                  />

                  {/* Sell / Buy action badge */}
                  <button
                    type="button"
                    onClick={() => handleUpdateLeg(index, { position: isSell ? 'buy' : 'sell' })}
                    className={`text-[11px] font-bold px-2 py-0.5 rounded cursor-pointer transition-colors ${
                      isSell
                        ? 'border border-red-500/40 text-red-400 bg-red-500/10 hover:bg-red-500/20'
                        : 'border border-emerald-500/40 text-emerald-400 bg-emerald-500/10 hover:bg-emerald-500/20'
                    }`}
                  >
                    {leg.position.toUpperCase()}
                  </button>

                  {/* Strike Mode selector */}
                  <div className="flex flex-col">
                    <select
                      value={
                        strikeMode === 'atm_percent' ? 'ATM Percent' :
                        strikeMode === 'straddle_width' ? 'Straddle Width' :
                        strikeMode === 'closest_premium' ? 'Closest Premium (CP)' :
                        strikeMode === 'cp_based_on_sp' ? 'CP based on Straddle Premium (SP)' : 'ATM Point'
                      }
                      onChange={e => {
                        const m = e.target.value as StrikeModeLabel;
                        handleUpdateLeg(index, {
                          strike_type: strikeModeToType(m),
                          strike: defaultStrikeValueFor(m),
                          cp_operator: (m.includes('(CP)') || m.includes('(SP)')) ? (leg.cp_operator || 'closest') : undefined,
                        });
                      }}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200 font-medium focus:outline-hidden"
                    >
                      <option value="ATM Point">ATM Point</option>
                      <option value="ATM Percent">ATM Percent</option>
                      <option value="Straddle Width">Straddle Width</option>
                      <option value="Closest Premium (CP)">Closest Premium (CP)</option>
                      <option value="CP based on Straddle Premium (SP)">CP based on SP</option>
                    </select>
                  </div>

                  {/* Strike Value selector */}
                  {strikeMode === 'offset' ? (
                    <select
                      value={leg.strike}
                      onChange={e => handleUpdateLeg(index, { strike: e.target.value })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200 font-medium focus:outline-hidden"
                    >
                      {STRIKE_OPTIONS.map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  ) : strikeMode === 'atm_percent' ? (
                    <select
                      value={leg.strike}
                      onChange={e => handleUpdateLeg(index, { strike: e.target.value })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200 font-medium focus:outline-hidden"
                    >
                      {ATM_PERCENT_OPTIONS.map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  ) : strikeMode === 'straddle_width' ? (
                    <select
                      value={leg.strike}
                      onChange={e => handleUpdateLeg(index, { strike: e.target.value })}
                      className="bg-zinc-800 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-200 font-medium focus:outline-hidden"
                    >
                      {STRADDLE_WIDTH_OPTIONS.map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  ) : strikeMode === 'closest_premium' ? (
                    <div className="flex items-center rounded overflow-hidden border border-zinc-700 shadow-xs">
                      <select
                        value={leg.cp_operator || 'closest'}
                        onChange={e => handleUpdateLeg(index, { cp_operator: e.target.value as CpOperator })}
                        className="bg-zinc-800 text-teal-400 font-semibold px-1.5 py-0.5 text-xs border-r border-zinc-700 focus:outline-hidden cursor-pointer"
                        title="Comparator: Closest (~), Greater than or equal (>=), Less than or equal (<=)"
                      >
                        {CP_OPERATORS.map(op => (
                          <option key={op.value} value={op.value} title={op.title}>{op.label}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={leg.strike}
                        onChange={e => handleUpdateLeg(index, { strike: e.target.value })}
                        placeholder="25"
                        className="w-14 bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-100 font-medium focus:outline-hidden text-center"
                      />
                    </div>
                  ) : (
                    /* cp_based_on_sp */
                    <div className="flex items-center rounded overflow-hidden border border-zinc-700 shadow-xs">
                      <select
                        value={leg.cp_operator || 'closest'}
                        onChange={e => handleUpdateLeg(index, { cp_operator: e.target.value as CpOperator })}
                        className="bg-zinc-800 text-teal-400 font-semibold px-1.5 py-0.5 text-xs border-r border-zinc-700 focus:outline-hidden cursor-pointer"
                        title="Comparator: Closest (~), Greater than or equal (>=), Less than or equal (<=)"
                      >
                        {CP_OPERATORS.map(op => (
                          <option key={op.value} value={op.value} title={op.title}>{op.label}</option>
                        ))}
                      </select>
                      <select
                        value={leg.strike}
                        onChange={e => handleUpdateLeg(index, { strike: e.target.value })}
                        className="bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-100 font-medium focus:outline-hidden cursor-pointer"
                      >
                        {CP_SP_OPTIONS.map(opt => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                  )}

                  {/* Call / Put option badge */}
                  <button
                    type="button"
                    onClick={() => handleUpdateLeg(index, { option_type: isCall ? 'PE' : 'CE' })}
                    className="bg-teal-600 hover:bg-teal-500 text-oncolor font-bold text-[11px] px-2.5 py-0.5 rounded cursor-pointer transition-colors shadow-xs"
                  >
                    {isCall ? 'CALL' : 'PUT'}
                  </button>
                </div>

                {/* Right controls: W&T, + Target Profit, + Stop Loss, + Trail Stop Loss, + Journey, Expiry, Copy, Trash */}
                <div className="flex items-center gap-3.5 flex-wrap">
                  {/* Wait & Trade Chip */}
                  {waitAndTradeActive && (
                    <div className="flex items-center rounded overflow-hidden border border-zinc-700 shadow-xs">
                      <select
                        value={leg.wait_and_trade_type || 'pct_up'}
                        onChange={e => handleUpdateLeg(index, { wait_and_trade_type: e.target.value as WaitAndTradeType })}
                        className="bg-zinc-800 text-teal-400 font-semibold px-2 py-0.5 text-xs border-r border-zinc-700 focus:outline-hidden cursor-pointer"
                        title="Wait & Trade Type"
                      >
                        {WAIT_AND_TRADE_TYPES.map(w => (
                          <option key={w.value} value={w.value} title={w.title}>{w.label}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        min={0}
                        step={0.5}
                        value={leg.wait_and_trade_val ?? 0}
                        onChange={e => handleUpdateLeg(index, { wait_and_trade_val: Math.max(0, Number(e.target.value)) })}
                        placeholder="0"
                        className="w-12 bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-100 font-medium focus:outline-hidden text-center"
                      />
                    </div>
                  )}
                  {/* Target Profit Chip */}
                  {leg.leg_target_pct > 0 ? (
                    <div className="flex items-center gap-1 bg-blue-500/10 border border-blue-500/30 text-blue-400 px-1.5 py-0.5 rounded text-xs font-semibold shadow-xs">
                      <span className="text-[10px]">Tgt:</span>
                      <input
                        type="number"
                        value={leg.leg_target_pct}
                        onChange={e => handleUpdateLeg(index, { leg_target_pct: Number(e.target.value) })}
                        className="w-10 bg-zinc-800 border border-zinc-700 rounded px-1 text-center text-xs text-zinc-100"
                      />
                      <span>%</span>
                      <button
                        type="button"
                        onClick={() => handleUpdateLeg(index, { leg_target_pct: 0 })}
                        className="text-zinc-500 hover:text-red-500 ml-0.5 leading-none"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleUpdateLeg(index, { leg_target_pct: 50 })}
                      className="text-xs text-teal-400 hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Target Profit
                    </button>
                  )}

                  {/* Stop Loss Chip */}
                  {leg.leg_sl_pct > 0 ? (
                    <div className="flex items-center gap-1 bg-red-500/10 border border-red-500/30 text-red-400 px-1.5 py-0.5 rounded text-xs font-semibold shadow-xs">
                      <span className="text-[10px]">SL:</span>
                      <input
                        type="number"
                        value={leg.leg_sl_pct}
                        onChange={e => handleUpdateLeg(index, { leg_sl_pct: Number(e.target.value) })}
                        className="w-10 bg-zinc-800 border border-zinc-700 rounded px-1 text-center text-xs text-zinc-100"
                      />
                      <span>%</span>
                      <button
                        type="button"
                        onClick={() => handleUpdateLeg(index, { leg_sl_pct: 0 })}
                        className="text-zinc-500 hover:text-red-500 ml-0.5 leading-none"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleUpdateLeg(index, { leg_sl_pct: 35 })}
                      className="text-xs text-teal-400 hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Stop Loss
                    </button>
                  )}

                  {/* Trail Stop Loss Chip */}
                  {(leg.leg_trail_sl_pct ?? 0) > 0 ? (
                    <div className="flex items-center gap-1 bg-amber-500/10 border border-amber-500/30 text-amber-400 px-1.5 py-0.5 rounded text-xs font-semibold shadow-xs">
                      <span className="text-[10px]">Trail:</span>
                      <input
                        type="number"
                        value={leg.leg_trail_sl_pct}
                        onChange={e => handleUpdateLeg(index, { leg_trail_sl_pct: Number(e.target.value) })}
                        className="w-10 bg-zinc-800 border border-zinc-700 rounded px-1 text-center text-xs text-zinc-100"
                      />
                      <span>%</span>
                      <button
                        type="button"
                        onClick={() => handleUpdateLeg(index, { leg_trail_sl_pct: 0 })}
                        className="text-zinc-500 hover:text-red-500 ml-0.5 leading-none"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleUpdateLeg(index, { leg_trail_sl_pct: 10 })}
                      className="text-xs text-teal-400 hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Trail Stop Loss
                    </button>
                  )}

                  {/* Re-Entry / Re-Execute Controls */}
                  {reEntryActive && (
                    <>
                      {/* SL Action Chip or Buttons */}
                      {(leg.re_execute_sl_count ?? 0) > 0 ? (
                        <div className="flex items-center gap-1 bg-indigo-500/10 border border-indigo-500/30 text-indigo-400 px-1.5 py-0.5 rounded text-xs font-semibold shadow-xs">
                          <span className="text-[10px] uppercase font-bold text-indigo-300">REX-SL:</span>
                          <span className="text-[10px] text-zinc-400">Fresh</span>
                          <select
                            value={leg.re_execute_sl_count || 1}
                            onChange={e => handleUpdateLeg(index, { re_execute_sl_count: Number(e.target.value) })}
                            className="bg-zinc-800 text-indigo-300 border border-zinc-700 rounded px-1 text-xs"
                          >
                            {[1, 2, 3, 4, 5].map(n => (
                              <option key={n} value={n}>{n}x</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => handleUpdateLeg(index, { re_execute_sl_count: 0 })}
                            className="text-zinc-500 hover:text-red-500 ml-0.5 leading-none"
                            title="Remove Re-Execute (SL)"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (leg.re_entry_sl_count ?? 0) > 0 ? (
                        <div className="flex items-center gap-1 bg-purple-500/10 border border-purple-500/30 text-purple-400 px-1.5 py-0.5 rounded text-xs font-semibold shadow-xs">
                          <span className="text-[10px] uppercase font-bold text-purple-300">RE-SL:</span>
                          <select
                            value={leg.re_entry_sl_type || 'asap'}
                            onChange={e => handleUpdateLeg(index, { re_entry_sl_type: e.target.value as ReEntryType })}
                            className="bg-zinc-800 text-purple-300 border border-zinc-700 rounded px-1 text-xs"
                          >
                            <option value="asap">ASAP</option>
                            <option value="cost">Cost</option>
                          </select>
                          <select
                            value={leg.re_entry_sl_count || 1}
                            onChange={e => handleUpdateLeg(index, { re_entry_sl_count: Number(e.target.value) })}
                            className="bg-zinc-800 text-purple-300 border border-zinc-700 rounded px-1 text-xs"
                          >
                            {[1, 2, 3, 4, 5].map(n => (
                              <option key={n} value={n}>{n}x</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => handleUpdateLeg(index, { re_entry_sl_count: 0 })}
                            className="text-zinc-500 hover:text-red-500 ml-0.5 leading-none"
                            title="Remove Re-Entry (SL)"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => handleUpdateLeg(index, { re_entry_sl_count: 1, re_entry_sl_type: 'asap', re_execute_sl_count: 0 })}
                            className="text-xs text-teal-400 hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Re-Entry (SL)
                          </button>
                          <button
                            type="button"
                            onClick={() => handleUpdateLeg(index, { re_execute_sl_count: 1, re_entry_sl_count: 0 })}
                            className="text-xs text-indigo-400 hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                          >
                            <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Re-Execute (SL)
                          </button>
                        </div>
                      )}

                      {/* TP Action Chip or Button */}
                      {(leg.re_execute_tp_count ?? 0) > 0 ? (
                        <div className="flex items-center gap-1 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 px-1.5 py-0.5 rounded text-xs font-semibold shadow-xs">
                          <span className="text-[10px] uppercase font-bold text-emerald-300">REX-TP:</span>
                          <span className="text-[10px] text-zinc-400">Fresh</span>
                          <select
                            value={leg.re_execute_tp_count || 1}
                            onChange={e => handleUpdateLeg(index, { re_execute_tp_count: Number(e.target.value) })}
                            className="bg-zinc-800 text-emerald-300 border border-zinc-700 rounded px-1 text-xs"
                          >
                            {[1, 2, 3, 4, 5].map(n => (
                              <option key={n} value={n}>{n}x</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => handleUpdateLeg(index, { re_execute_tp_count: 0 })}
                            className="text-zinc-500 hover:text-red-500 ml-0.5 leading-none"
                            title="Remove Re-Execute (TP)"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (leg.re_entry_tp_count ?? 0) > 0 ? (
                        <div className="flex items-center gap-1 bg-teal-500/10 border border-teal-500/30 text-teal-400 px-1.5 py-0.5 rounded text-xs font-semibold shadow-xs">
                          <span className="text-[10px] uppercase font-bold text-teal-300">RE-TP:</span>
                          <select
                            value={leg.re_entry_tp_count || 1}
                            onChange={e => handleUpdateLeg(index, { re_entry_tp_count: Number(e.target.value) })}
                            className="bg-zinc-800 text-teal-300 border border-zinc-700 rounded px-1 text-xs"
                          >
                            {[1, 2, 3, 4, 5].map(n => (
                              <option key={n} value={n}>{n}x</option>
                            ))}
                          </select>
                          <button
                            type="button"
                            onClick={() => handleUpdateLeg(index, { re_entry_tp_count: 0 })}
                            className="text-zinc-500 hover:text-red-500 ml-0.5 leading-none"
                            title="Remove Re-Entry (TP)"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleUpdateLeg(index, { re_execute_tp_count: 1, re_entry_tp_count: 0 })}
                          className="text-xs text-teal-400 hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                        >
                          <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Re-Execute (TP)
                        </button>
                      )}
                    </>
                  )}

                  {/* Journey Link — not implemented; a real multi-stage SL/target ladder */}
                  <button
                    type="button"
                    disabled
                    title="Not implemented yet — a multi-stage SL/target ladder per leg"
                    className="text-xs text-zinc-500 font-semibold flex items-center gap-0.5 cursor-not-allowed opacity-60"
                  >
                    <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Journey
                  </button>

                  {/* Expiry Dropdown — the engine simulates one expiry cycle at a time for
                      every leg together, so a per-leg expiry can't mean anything until it
                      supports calendar/diagonal spreads across two different expiries. */}
                  <select
                    disabled
                    defaultValue="Weekly"
                    title="Not implemented yet — every leg shares the same expiry cycle"
                    className="bg-zinc-800/50 border border-zinc-700 rounded px-2 py-0.5 text-xs text-zinc-500 font-medium cursor-not-allowed"
                  >
                    <option value="Weekly">Weekly</option>
                    <option value="Next Weekly">Next Weekly</option>
                    <option value="Monthly">Monthly</option>
                  </select>

                  {/* Clone Icon */}
                  <button
                    type="button"
                    onClick={() => handleCloneLeg(index)}
                    title="Clone leg"
                    className="text-zinc-500 hover:text-zinc-300 transition-colors p-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>

                  {/* Trash Icon */}
                  <button
                    type="button"
                    onClick={() => handleRemoveLeg(index)}
                    title="Remove leg"
                    className="text-zinc-500 hover:text-red-500 transition-colors p-1"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* No ReEntry toggle on right — moot while Re-Entry/Re-Execute and Journey
             above are themselves disabled */}
        <div className="flex justify-end items-center gap-2 py-1 text-xs text-zinc-400">
          <label className="flex items-center gap-2 cursor-not-allowed opacity-50" title="Depends on Re-Entry/Re-Execute and Journey, both not implemented yet">
            <div className="w-7 h-4 bg-zinc-700 rounded-full relative p-0.5">
              <div className="w-3 h-3 rounded-full bg-zinc-400 shadow-xs" />
            </div>
            <span>No ReEntry/ReExecute/Journey After</span>
          </label>
        </div>

        {/* ── Timing & Strategy Controls Section ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 my-4 pt-2">
          {/* Left Column: Range Breakout & Entry Time */}
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-xs text-zinc-400 cursor-not-allowed opacity-50" title="Not implemented yet — needs opening-range computation + breakout-triggered entry">
              <input type="checkbox" disabled className="w-3.5 h-3.5 rounded" />
              <span>Range Breakout</span>
              <Info className="w-3 h-3 text-zinc-500" />
            </label>

            <div className="flex items-center gap-2 text-xs text-zinc-400 mt-1">
              <span className="w-20 font-medium">Entry Time:</span>
              <div className="flex items-center gap-1">
                <select
                  value={entryH}
                  onChange={e => setEntryH(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 font-medium focus:outline-hidden"
                >
                  {['9', '10', '11', '12', '13', '14', '15'].map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span>:</span>
                <select
                  value={entryM}
                  onChange={e => setEntryM(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 font-medium focus:outline-hidden"
                >
                  {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')).map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <span>:</span>
                <select
                  value={entryS}
                  onChange={e => setEntryS(e.target.value)}
                  disabled
                  title="Option data is 1-minute resolution — seconds aren't meaningful"
                  className="bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-500 font-medium cursor-not-allowed"
                >
                  {['00', '15', '30', '45'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Strategy Target Profit */}
            {strategyTargetActive ? (
              <div className="flex items-center gap-2 mt-2 text-xs text-zinc-300">
                <span className="font-medium text-zinc-300">Target Profit:</span>
                <select
                  value={profitTargetType}
                  onChange={e => setProfitTargetType(e.target.value as 'mtm' | 'pct')}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 font-medium focus:outline-hidden cursor-pointer"
                >
                  <option value="mtm">Total MTM</option>
                  <option value="pct">% of Total Premium</option>
                </select>
                <div className="flex items-center border border-zinc-700 rounded overflow-hidden shadow-xs">
                  <span className="bg-teal-500/20 text-teal-400 font-semibold px-2 py-1 text-xs border-r border-zinc-700 select-none">
                    {profitTargetType === 'mtm' ? '₹' : '%'}
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={profitTargetType === 'mtm' ? 100 : 1}
                    value={profitTargetVal || ''}
                    onChange={e => setProfitTargetVal(Math.max(0, Number(e.target.value)))}
                    placeholder="0"
                    className="w-20 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 font-medium focus:outline-hidden"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { setStrategyTargetActive(false); setProfitTargetVal(0); }}
                  className="text-zinc-500 hover:text-red-400 p-0.5 cursor-pointer leading-none text-sm"
                  title="Remove Target Profit"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setStrategyTargetActive(true); setProfitTargetVal(2000); setProfitTargetType('mtm'); }}
                className="text-xs text-teal-400 hover:underline font-semibold flex items-center gap-0.5 mt-2 cursor-pointer w-fit"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Target Profit
              </button>
            )}

            {/* Price Difference Gate Link / Badge */}
            {priceDiffActive ? (
              <div className="flex items-center gap-2 mt-2 bg-zinc-850 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-200 w-fit shadow-xs">
                <span className="font-semibold text-emerald-400">Price Diff Gate: &lt;</span>
                <input
                  type="number"
                  min={1}
                  max={100}
                  value={maxDiffPct}
                  onChange={e => setMaxDiffPct(Number(e.target.value))}
                  className="w-12 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-xs text-zinc-100 font-semibold"
                />
                <span>%</span>
                <button
                  type="button"
                  onClick={() => { setPriceDiffActive(false); }}
                  className="text-zinc-500 hover:text-red-500 ml-1 cursor-pointer"
                  title="Remove Price Diff Filter"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setPriceDiffActive(true); setMaxDiffPct(10); }}
                className="text-xs text-emerald-400 hover:underline font-semibold flex items-center gap-0.5 mt-2 cursor-pointer w-fit"
                title="Only enter when CE and PE prices are balanced within threshold"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Price Diff Gate (&lt; 10%)
              </button>
            )}
          </div>

          {/* Right Column: Same Day / Next Day & Exit Time */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-4 text-xs text-zinc-400" title="Use the INTRADAY / POSITIONAL toggle at the bottom of the page for this instead">
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50">
                <input type="radio" name="exitDay" checked disabled className="w-3.5 h-3.5" />
                <span>Same Day</span>
              </label>
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50">
                <input type="radio" name="exitDay" disabled className="w-3.5 h-3.5" />
                <span>Next Day (BTST/STBT)</span>
              </label>
            </div>

            <div className="flex items-center gap-2 text-xs text-zinc-400 mt-1">
              <span className="w-20 font-medium">Exit Time:</span>
              <div className="flex items-center gap-1">
                <select
                  value={exitH}
                  onChange={e => setExitH(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 font-medium focus:outline-hidden"
                >
                  {['9', '10', '11', '12', '13', '14', '15'].map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span>:</span>
                <select
                  value={exitM}
                  onChange={e => setExitM(e.target.value)}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 font-medium focus:outline-hidden"
                >
                  {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, '0')).map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
                <span>:</span>
                <select
                  value={exitS}
                  onChange={e => setExitS(e.target.value)}
                  disabled
                  title="Option data is 1-minute resolution — seconds aren't meaningful"
                  className="bg-zinc-800/50 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-500 font-medium cursor-not-allowed"
                >
                  {['00', '15', '30', '45'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Strategy Stop Loss */}
            {strategySlActive ? (
              <div className="flex items-center gap-2 mt-2 text-xs text-zinc-300">
                <span className="font-medium text-zinc-300">Stop Loss:</span>
                <select
                  value={overallSlType}
                  onChange={e => setOverallSlType(e.target.value as 'mtm' | 'pct')}
                  className="bg-zinc-800 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 font-medium focus:outline-hidden cursor-pointer"
                >
                  <option value="mtm">Total MTM</option>
                  <option value="pct">% of Total Premium</option>
                </select>
                <div className="flex items-center border border-zinc-700 rounded overflow-hidden shadow-xs">
                  <span className="bg-red-500/20 text-red-400 font-semibold px-2 py-1 text-xs border-r border-zinc-700 select-none">
                    {overallSlType === 'mtm' ? '- ₹' : '- %'}
                  </span>
                  <input
                    type="number"
                    min={0}
                    step={overallSlType === 'mtm' ? 100 : 1}
                    value={overallSlVal || ''}
                    onChange={e => setOverallSlVal(Math.max(0, Number(e.target.value)))}
                    placeholder="0"
                    className="w-20 bg-zinc-800 px-2 py-1 text-xs text-zinc-100 font-medium focus:outline-hidden"
                  />
                </div>
                <button
                  type="button"
                  onClick={() => { setStrategySlActive(false); setOverallSlVal(0); }}
                  className="text-zinc-500 hover:text-red-400 p-0.5 cursor-pointer leading-none text-sm"
                  title="Remove Stop Loss"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setStrategySlActive(true); setOverallSlVal(2000); setOverallSlType('mtm'); }}
                className="text-xs text-teal-400 hover:underline font-semibold flex items-center gap-0.5 mt-2 cursor-pointer w-fit"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Stop Loss
              </button>
            )}
          </div>
        </div>

        {/* Protect The Profits link centered */}
        <div className="flex justify-center my-3">
          {protectProfitsActive ? (
            <div className="flex items-center gap-2 bg-zinc-850 border border-zinc-700 rounded px-3 py-1.5 text-xs text-zinc-200 shadow-xs">
              <span className="font-semibold text-amber-400">Protect Profits (Trail SL %):</span>
              <input
                type="number"
                min={1}
                value={trailSlPct}
                onChange={e => setTrailSlPct(Number(e.target.value))}
                className="w-14 bg-zinc-800 border border-zinc-700 rounded px-1.5 py-0.5 text-center text-xs text-zinc-100 font-semibold"
              />
              <span>%</span>
              <button
                type="button"
                onClick={() => { setProtectProfitsActive(false); setTrailSlPct(0); }}
                className="text-zinc-500 hover:text-red-500 ml-1"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setProtectProfitsActive(true); setTrailSlPct(15); }}
              className="text-xs text-teal-400 hover:underline font-semibold flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Protect The Profits <Info className="w-3 h-3 text-zinc-500" />
            </button>
          )}
        </div>

        {/* ── Data Notice & Change Settings ── */}
        <div className="text-center text-[11px] text-zinc-500 leading-relaxed max-w-4xl mx-auto my-3">
          <p>
            Only <strong className="text-zinc-200 font-semibold">Nifty</strong> option data is backed by this backtester today — Banknifty/FinNifty/Sensex selections above run against no real data and won&apos;t produce trades. Nifty data is available from <strong className="text-zinc-200 font-semibold">Thu Dec 31 2020</strong>.
          </p>
          <p>
            Nifty lot size is fetched live per period from the master contract, not hardcoded (see the Lot Size field under Change Settings).
          </p>

          <div className="flex justify-center items-center gap-3 mt-2.5">
            <button
              type="button"
              onClick={() => setSettingsModalOpen(true)}
              className="border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-300 px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
            >
              <Settings className="w-3.5 h-3.5" /> Change Settings
            </button>
            <button
              type="button"
              onClick={() => { setHistoryModalOpen(true); fetchHistory(); }}
              className="border border-teal-500/40 bg-teal-500/15 hover:bg-teal-500/25 text-teal-300 px-3.5 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-xs"
            >
              <History className="w-3.5 h-3.5" /> Past Backtests
              {historyList.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-teal-500/25 text-teal-200 rounded-full text-[10px] font-bold">
                  {historyList.length}
                </span>
              )}
            </button>
          </div>
        </div>

        {/* ── Date Range Selectors ── */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 max-w-4xl mx-auto my-4">
          <DateInputBox
            label="From Date:"
            value={startDate}
            onChange={setStartDate}
          />
          <DateInputBox
            label="To Date:"
            value={endDate}
            onChange={setEndDate}
          />
        </div>

      </div>

      {/* ── Bottom Fixed Action Bar ── */}
      <div
        className="fixed bottom-0 right-0 z-30 bg-zinc-950/95 border-t border-zinc-800 px-4 sm:px-6 py-2.5 backdrop-blur-md shadow-lg flex items-center justify-between gap-3 text-zinc-300 transition-[left] duration-200 ease-out overflow-x-auto sm:overflow-visible"
        style={{ left: 'var(--sidebar-w, 56px)' }}
      >
        {/* Left: INTRADAY / POSITIONAL */}
        <div className="flex rounded overflow-hidden border border-zinc-700 shadow-xs shrink-0">
          <button
            type="button"
            onClick={() => setExecutionType('INTRADAY')}
            className={`px-3 py-1.5 text-xs font-bold transition-colors ${
              executionType === 'INTRADAY'
                ? 'bg-teal-600 text-oncolor'
                : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            INTRADAY
          </button>
          <button
            type="button"
            onClick={() => setExecutionType('POSITIONAL')}
            className={`px-3 py-1.5 text-xs font-bold transition-colors ${
              executionType === 'POSITIONAL'
                ? 'bg-teal-600 text-oncolor'
                : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200'
            }`}
          >
            POSITIONAL
          </button>
        </div>

        {/* Center: Past Runs, Save Strategy & Share Strategy */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap justify-center">
          <button
            type="button"
            onClick={() => { setHistoryModalOpen(true); fetchHistory(); }}
            className="border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-semibold text-xs px-3.5 py-1.5 rounded shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <History className="w-3.5 h-3.5 text-teal-400" /> Past Runs ({historyList.length})
          </button>
          <button
            type="button"
            onClick={handleSaveStrategy}
            className="border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-semibold text-xs px-3.5 py-1.5 rounded shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Save className="w-3.5 h-3.5 text-teal-400" /> Save Strategy
          </button>
          <button
            type="button"
            onClick={handleShareStrategy}
            className="border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-zinc-200 font-semibold text-xs px-3.5 py-1.5 rounded shadow-xs flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Share2 className="w-3.5 h-3.5 text-teal-400" /> Share Strategy
          </button>
        </div>

        {/* Right: START BACKTEST */}
        <div className="shrink-0">
          {loading ? (
            <button
              type="button"
              onClick={stopBacktest}
              className="bg-red-600 hover:bg-red-700 text-white font-bold text-xs uppercase px-6 py-2 rounded shadow-md flex items-center gap-2 cursor-pointer animate-pulse"
            >
              <Square className="w-3.5 h-3.5 fill-current" /> Stop Backtest
            </button>
          ) : (
            <button
              type="button"
              onClick={runBacktest}
              className="bg-emerald-600 hover:bg-emerald-500 text-oncolor font-bold text-xs uppercase px-7 py-2 rounded shadow-md tracking-wider cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              START BACKTEST
            </button>
          )}
        </div>
      </div>

      {/* ── Settings Modal ── */}
      {settingsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 backdrop-blur-xs p-4">
          <div className="bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 max-w-lg w-full p-5 text-zinc-200 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-4">
              <h2 className="text-sm font-bold text-white flex items-center gap-2">
                <Settings className="w-4 h-4 text-teal-400" /> Strategy &amp; Simulation Settings
              </h2>
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="text-zinc-500 hover:text-zinc-300 p-1"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-4 text-xs">
              {/* Preset Strategies Quick Loader */}
              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Quick Strategy Presets</label>
                <select
                  onChange={e => {
                    applyPreset(e.target.value);
                    setSettingsModalOpen(false);
                  }}
                  defaultValue=""
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded p-2 text-xs focus:outline-hidden"
                >
                  <option value="" disabled>Load a standard preset...</option>
                  <option value="straddle_35sl">9:20 Short Straddle (35% Leg SL)</option>
                  <option value="rolling_straddle">Intraday Rolling Straddle (35 pt Buffer Roll)</option>
                  <option value="strangle_20delta">0DTE 20-Delta Strangle (40% SL)</option>
                  <option value="iron_condor">Weekly Iron Condor (Sell 25D, Buy 10D)</option>
                </select>
              </div>

              {/* Lot size */}
              <div>
                <label className="block font-semibold text-zinc-300 mb-1">Lot Size</label>
                <input
                  type="number"
                  min={1}
                  value={lotSize}
                  onChange={e => setLotSize(Number(e.target.value))}
                  className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded p-1.5 text-xs focus:outline-hidden"
                />
              </div>

              {/* Costs & Slippage */}
              <div className="border border-zinc-800 rounded-xl p-3 bg-zinc-850/50">
                <label className="flex items-center gap-2 cursor-pointer mb-2 font-semibold">
                  <input
                    type="checkbox"
                    checked={includeCosts}
                    onChange={e => setIncludeCosts(e.target.checked)}
                    className="accent-teal-500 rounded"
                  />
                  <span>Include Costs &amp; Slippage</span>
                </label>
                {includeCosts && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <span className="block text-[11px] text-zinc-500 mb-1">Commission / Lot (₹)</span>
                      <input
                        type="number"
                        min={0}
                        value={commissionPerLot}
                        onChange={e => setCommissionPerLot(Number(e.target.value))}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded p-1.5 text-xs focus:outline-hidden"
                      />
                    </div>
                    <div>
                      <span className="block text-[11px] text-zinc-500 mb-1">Slippage %</span>
                      <input
                        type="number"
                        min={0}
                        step={0.05}
                        value={slippagePct}
                        onChange={e => setSlippagePct(Number(e.target.value))}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded p-1.5 text-xs focus:outline-hidden"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Rolling straddle mode */}
              <div className="border border-zinc-800 rounded-xl p-3 bg-zinc-850/50">
                <span className="block font-semibold mb-2">Dynamic Roll Adjustment</span>
                <div className="flex gap-4 mb-2">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="adjMode"
                      checked={adjustmentMode === 'none'}
                      onChange={() => setAdjustmentMode('none')}
                      className="accent-teal-500"
                    />
                    <span>Static Hold</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="adjMode"
                      checked={adjustmentMode === 'rolling_straddle'}
                      onChange={() => setAdjustmentMode('rolling_straddle')}
                      className="accent-teal-500"
                    />
                    <span>ATM Roll (Rolling Straddle)</span>
                  </label>
                </div>
                {adjustmentMode === 'rolling_straddle' && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <span className="block text-[11px] text-zinc-500 mb-1">Roll Buffer</span>
                      <input
                        type="number"
                        value={rollBuffer}
                        onChange={e => setRollBuffer(Number(e.target.value))}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded p-1.5 text-xs focus:outline-hidden"
                      />
                    </div>
                    <div>
                      <span className="block text-[11px] text-zinc-500 mb-1">Max Rolls / Day</span>
                      <input
                        type="number"
                        value={maxRolls}
                        onChange={e => setMaxRolls(Number(e.target.value))}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded p-1.5 text-xs focus:outline-hidden"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Balanced Entry Gate (Price Parity) */}
              <div className="border border-zinc-800 rounded-xl p-3 bg-zinc-850/50">
                <label className="flex items-center gap-2 cursor-pointer mb-1.5 font-semibold">
                  <input
                    type="checkbox"
                    checked={priceDiffActive}
                    onChange={e => setPriceDiffActive(e.target.checked)}
                    className="accent-teal-500 rounded"
                  />
                  <span>Balanced Entry Gate (CE/PE Price Parity)</span>
                </label>
                <p className="text-[11px] text-zinc-500 mb-2 leading-relaxed">
                  Waits past Entry Time until |CE − PE| / max(CE, PE) is below threshold before entering. Dynamically checks nearest ATM strike every minute. Skips day if never balanced before cutoff.
                </p>
                {priceDiffActive && (
                  <div className="grid grid-cols-2 gap-3 mt-2 pt-2 border-t border-zinc-800">
                    <div>
                      <span className="block text-[11px] text-zinc-500 mb-1">Max CE/PE Price Diff %</span>
                      <input
                        type="number"
                        min={1}
                        max={100}
                        value={maxDiffPct}
                        onChange={e => setMaxDiffPct(Number(e.target.value))}
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded p-1.5 text-xs focus:outline-hidden"
                      />
                    </div>
                    <div>
                      <span className="block text-[11px] text-zinc-500 mb-1">Entry Cutoff Time (HH:MM)</span>
                      <input
                        type="text"
                        value={entryCutoffTime}
                        onChange={e => setEntryCutoffTime(e.target.value)}
                        placeholder="15:00"
                        className="w-full bg-zinc-800 border border-zinc-700 text-zinc-100 rounded p-1.5 text-xs focus:outline-hidden"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 pt-3 border-t border-zinc-800 flex justify-end">
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="bg-teal-600 hover:bg-teal-500 text-oncolor px-4 py-1.5 rounded text-xs font-semibold cursor-pointer"
              >
                Apply &amp; Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Progress Overlay Modal during Backtest ── */}
      {loading && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 backdrop-blur-xs p-4">
          <div className="bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 p-6 max-w-md w-full text-center text-zinc-200">
            <div className="w-12 h-12 rounded-full bg-teal-500/15 flex items-center justify-center mx-auto mb-4 animate-spin text-teal-400">
              <RefreshCw className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-bold text-white mb-1">
              {statusData?.stage === 'loading_data'
                ? 'Loading Historical Options Data'
                : 'Simulating Historical Option Trades'}
            </h3>
            <p className="text-xs text-zinc-500 mb-4">
              {statusData?.stage === 'loading_data'
                ? 'Extracting multi-leg option cycles and building memory cache…'
                : 'Analyzing 1-min OHLC, underlying spot & strikes across historical cycles…'}
            </p>

            {/* Progress bar */}
            <div className="w-full bg-zinc-800 rounded-full h-3.5 overflow-hidden p-0.5 border border-zinc-700 mb-2">
              <div
                className="bg-teal-500 h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.max(3, statusData?.percent ?? 0)}%` }}
              />
            </div>

            <div className="flex justify-between text-xs font-medium text-zinc-500 mb-4">
              <span>{statusData?.percent?.toFixed(1) ?? '0.0'}% completed</span>
              <span>
                {statusData?.current ?? 0} / {statusData?.total || '—'}{' '}
                {statusData?.stage === 'loading_data' ? 'expiries' : 'days'}
              </span>
            </div>

            {statusData?.date && (
              <div className="bg-zinc-850 border border-zinc-800 rounded px-3 py-1.5 text-xs text-zinc-400 mb-4 flex justify-between font-mono">
                <span>{statusData.stage === 'loading_data' ? 'Expiry Date:' : 'Processing Date:'}</span>
                <span className="font-bold text-white">{statusData.date}</span>
              </div>
            )}

            <button
              type="button"
              onClick={stopBacktest}
              className="px-4 py-1.5 rounded text-xs font-semibold text-red-600 bg-red-50 hover:bg-red-100 border border-red-200 transition-colors"
            >
              Cancel Simulation
            </button>
          </div>
        </div>
      )}

      {/* ── Backtest Results Section ── */}
      {result && s && (
        <div ref={resultsRef} className="w-full max-w-[1550px] mx-auto px-4 mt-8 pt-6 border-t border-zinc-800">
          {/* Loaded from History Banner */}
          {loadedFromHistory && (
            <div className="mb-4 bg-teal-500/10 border border-teal-500/30 text-teal-200 rounded-xl p-3.5 flex items-center justify-between shadow-xs flex-wrap gap-2">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-teal-500/20 flex items-center justify-center text-teal-400">
                  <History className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-white flex items-center gap-2">
                    <span>Viewing Archived Backtest:</span>
                    <span className="text-teal-400 font-bold">{loadedFromHistory.name}</span>
                  </div>
                  <div className="text-[11px] text-zinc-500 font-mono">
                    ID: {loadedFromHistory.id} &bull; Period: {loadedFromHistory.start_date || '—'} &rarr; {loadedFromHistory.end_date || '—'} &bull; {loadedFromHistory.trades} cycles
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {loadedFromHistory.has_report && (
                  <button
                    type="button"
                    onClick={() => setViewingReportId(loadedFromHistory.id)}
                    className="border border-emerald-500/40 text-emerald-300 bg-emerald-500/10 hover:bg-emerald-500/20 px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-xs"
                  >
                    <FileText className="w-3.5 h-3.5 text-emerald-400" /> Research Report
                  </button>
                )}
                {loadedFromHistory.has_tearsheet && (
                  <button
                    type="button"
                    onClick={() => setViewingTearsheetId(loadedFromHistory.id)}
                    className="border border-teal-500/40 text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-xs"
                  >
                    <FileText className="w-3.5 h-3.5 text-teal-400" /> Tearsheet
                  </button>
                )}
                {loadedFromHistory.has_trades_csv && (
                  <a
                    href={`/api/backtest/history?id=${encodeURIComponent(loadedFromHistory.id)}&file=csv`}
                    download
                    className="border border-zinc-700 text-zinc-300 bg-zinc-800 hover:bg-zinc-700 px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-xs"
                  >
                    <Download className="w-3.5 h-3.5" /> CSV
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setLoadedFromHistory(null)}
                  className="text-zinc-500 hover:text-zinc-300 px-1 text-xs"
                  title="Dismiss banner"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <span className="text-[10px] font-bold text-teal-400 uppercase tracking-wider block">Simulation Complete</span>
              <h2 className="text-lg font-bold text-white">Backtest Performance Report</h2>
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              {(loadedFromHistory?.has_report || historyList.some(h => h.has_report)) && (
                <button
                  type="button"
                  onClick={() => setViewingReportId(loadedFromHistory?.id || historyList.find(h => h.has_report)?.id || 'nifty_straddle_10diff_20sl_shift')}
                  className="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs px-3.5 py-1.5 rounded-lg shadow-sm flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <FileText className="w-3.5 h-3.5" /> View Research Report &amp; Trade Details
                </button>
              )}
              <div className="text-xs font-mono text-zinc-400 bg-zinc-900 border border-zinc-800 rounded px-3 py-1">
                {s.traded_cycles} Trades ({startDate} &rarr; {endDate})
              </div>
            </div>
          </div>

          {/* Headline KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Overall Profit</span>
              <span className={`text-xl font-bold font-mono ${s.total_pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {fmtPnl(s.total_pnl)}
              </span>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Win Rate</span>
              <span className={`text-xl font-bold font-mono ${s.win_rate >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                {s.win_rate.toFixed(1)}%
              </span>
              <span className="text-[10px] text-zinc-500 block mt-0.5">{s.wins}W / {s.losses}L</span>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Max Drawdown</span>
              <span className="text-xl font-bold font-mono text-amber-600">
                ₹{fmt(s.max_drawdown)}
              </span>
              {s.max_drawdown_days != null && (
                <span className="text-[10px] text-zinc-500 block mt-0.5">{s.max_drawdown_days} days</span>
              )}
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Traded Cycles</span>
              <span className="text-xl font-bold font-mono text-zinc-100">
                {s.traded_cycles}
              </span>
              <span className="text-[10px] text-zinc-500 block mt-0.5">of {s.total_cycles} evaluated</span>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Return / Max DD</span>
              <span className="text-xl font-bold font-mono text-zinc-100">
                {s.return_maxdd_ratio != null ? s.return_maxdd_ratio.toFixed(2) : '—'}
              </span>
            </div>

            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-zinc-500 uppercase tracking-wider block mb-1">Reward : Risk</span>
              <span className="text-xl font-bold font-mono text-zinc-100">
                {s.reward_risk_ratio != null ? s.reward_risk_ratio.toFixed(2) : '—'}
              </span>
            </div>
          </div>

          {/* Detailed Statistics Matrix */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 shadow-xs mb-6">
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wider mb-3">Detailed Statistics</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-xs">
              <div>
                <span className="text-zinc-500 block mb-0.5">Avg Profit / Trade</span>
                <span className={`font-mono font-bold ${s.avg_pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {fmtPnl(s.avg_pnl)}
                </span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Avg Winning Trade</span>
                <span className="font-mono font-bold text-emerald-600">{fmtPnl(s.avg_win)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Avg Losing Trade</span>
                <span className="font-mono font-bold text-red-600">-₹{fmt(s.avg_loss)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Max Single Profit</span>
                <span className="font-mono font-bold text-emerald-600">{fmtPnl(s.max_win)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Max Single Loss</span>
                <span className="font-mono font-bold text-red-600">{fmtPnl(s.max_loss)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Commission Paid</span>
                <span className="font-mono font-bold text-zinc-200">₹{fmt(s.commission_paid)}</span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Max Win Streak</span>
                <span className="font-mono font-bold text-emerald-600">{s.max_win_streak}</span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Max Loss Streak</span>
                <span className="font-mono font-bold text-red-600">{s.max_loss_streak}</span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Max Trades in DD</span>
                <span className="font-mono font-bold text-amber-600">{s.max_trades_in_drawdown}</span>
              </div>
              <div>
                <span className="text-zinc-500 block mb-0.5">Expectancy Ratio</span>
                <span className="font-mono font-bold text-zinc-200">{s.expectancy_ratio != null ? s.expectancy_ratio.toFixed(2) : '—'}</span>
              </div>
            </div>
          </div>

          {/* Year-wise Returns Matrix */}
          {Object.keys(result.monthly_pnl).length > 0 && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-xs mb-6">
              <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-850/60 flex items-center justify-between">
                <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wider">Year-wise &amp; Month-wise Returns</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs whitespace-nowrap w-full">
                  <thead>
                    <tr className="bg-zinc-800 text-white border-b border-zinc-700">
                      <th className="font-bold text-left px-3 py-2">Year</th>
                      {MONTHS.map(m => (
                        <th key={m} className="font-bold text-right px-2 py-2">{m}</th>
                      ))}
                      <th className="font-bold text-right px-3 py-2 border-l border-zinc-800">Total</th>
                      <th className="font-bold text-right px-3 py-2">Max DD</th>
                      <th className="font-bold text-right px-3 py-2">Days</th>
                      <th className="font-bold text-right px-3 py-2">R/MDD</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.keys(result.monthly_pnl).sort().map((yr, i) => {
                      const yData = result.monthly_pnl[yr] ?? {};
                      const total = yData['Total'] ?? 0;
                      const { mdd, days } = computeYearMDD(result.equity_curve, yr);
                      const rMdd = mdd > 0 ? (total / mdd).toFixed(2) : '—';
                      return (
                        <tr key={yr} className={`border-t border-zinc-800 ${i % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-850/40'}`}>
                          <td className="px-3 py-2 font-bold text-zinc-100">{yr}</td>
                          {MONTHS.map(m => {
                            const v = yData[m];
                            const isPositive = v != null && v > 0;
                            const isNegative = v != null && v < 0;
                            return (
                              <td
                                key={m}
                                className={`px-2 py-2 text-right font-mono ${
                                  isPositive ? 'text-emerald-600 font-medium' : isNegative ? 'text-red-600 font-medium' : 'text-zinc-500'
                                }`}
                              >
                                {v != null && v !== 0 ? (v > 0 ? '+' : '') + Math.round(v).toLocaleString('en-IN') : '—'}
                              </td>
                            );
                          })}
                          <td className={`px-3 py-2 text-right font-mono font-bold border-l border-zinc-800 ${total >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {total !== 0 ? (total > 0 ? '+' : '') + Math.round(total).toLocaleString('en-IN') : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-amber-600 font-medium">
                            {mdd > 0 ? `₹${mdd.toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-zinc-500">
                            {days != null ? days : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-zinc-200">
                            {rMdd}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* VectorBT Stats — only present when apiBase points at the VectorBT CLI.
              Same cycles/legs/trades as the Python-engine numbers above (see
              scripts/analysis/vectorbt_engine/options_engine.py); this panel is
              VectorBT's own Sharpe/Sortino/drawdown computed from those trades,
              so any gap vs. the "Detailed Statistics" box above is a stats-
              methodology difference, not a different backtest. */}
          {result.vbt && !result.vbt.error && (
            <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 shadow-xs mb-6">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wider">
                  VectorBT Stats <span className="text-zinc-500 font-normal normal-case">(same trades, computed by vbt.Portfolio)</span>
                </h3>
                {result.vbt.tearsheet_available && (
                  <a href="/api/backtest-vectorbt/report" target="_blank" rel="noopener noreferrer"
                     className="text-[11px] font-bold text-teal-400 hover:underline">
                    Open OpenStatz Tearsheet →
                  </a>
                )}
              </div>

              {result.vbt.comparison && result.vbt.comparison.length > 0 && (
                <div className="overflow-x-auto mb-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-zinc-800 text-white border-b border-zinc-700">
                        {Object.keys(result.vbt.comparison[0]).map(col => (
                          <th key={col} className="text-left font-bold px-3 py-1.5">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.vbt.comparison.map((row, i) => (
                        <tr key={i} className="border-b border-zinc-800 last:border-0 hover:bg-zinc-800/40">
                          {Object.entries(row).map(([col, val]) => (
                            <td key={col} className="px-3 py-1.5 font-mono text-zinc-200">{String(val)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {result.vbt.stats && (
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-1.5 text-xs">
                  {Object.entries(result.vbt.stats).map(([key, val]) => (
                    <div key={key} className="flex justify-between border-b border-zinc-800 py-1">
                      <span className="text-zinc-500">{key.replace(' [%]', '')}</span>
                      <span className="text-zinc-200 font-mono font-medium">{formatVbtStat(key, val)}</span>
                    </div>
                  ))}
                </div>
              )}

              {result.vbt.monte_carlo_summary && (
                <p className="text-[11px] text-zinc-500 mt-3">{result.vbt.monte_carlo_summary}</p>
              )}
            </div>
          )}
          {result.vbt?.error && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl p-3 mb-6 text-[11px] text-amber-700">
              VectorBT stats could not be computed: {result.vbt.error}
            </div>
          )}

          {/* Equity Curve & Underwater Charts */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 shadow-xs mb-6">
            <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wider mb-4">Cumulative Equity &amp; Drawdown Curve</h3>
            <BacktestCharts equityCurve={result.equity_curve} />
          </div>

          {/* Full Trade Log Table */}
          {/* Full Trade Log Table */}
          <div className="bg-zinc-900 border border-zinc-800 rounded-xl overflow-hidden shadow-xs mb-8">
            <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-850/60 flex items-center justify-between">
              <div>
                <h3 className="text-xs font-bold text-zinc-200 uppercase tracking-wider flex items-center gap-2">
                  Full Execution Trade Log ({result.cycles.filter(c => c.exit_reason !== 'NO_ENTRY').length} cycles)
                </h3>
                <p className="text-[11px] text-zinc-400 mt-0.5">
                  Click any day row to view full timewise trade execution breakdown
                </p>
              </div>
            </div>
            <div className="overflow-x-auto max-h-[600px] overflow-y-auto">
              <table className="text-xs whitespace-nowrap w-full">
                <thead className="sticky top-0 z-10">
                  <tr className="bg-zinc-800 text-white border-b border-zinc-700">
                    <th className="font-bold text-left px-3 py-2">#</th>
                    <th className="font-bold text-left px-3 py-2">Entry Date</th>
                    <th className="font-bold text-right px-2 py-2">Time</th>
                    <th className="font-bold text-left px-3 py-2 border-l border-zinc-800">Exit Date</th>
                    <th className="font-bold text-right px-2 py-2">Time</th>
                    <th className="font-bold text-center px-2 py-2 border-l border-zinc-800">Type</th>
                    <th className="font-bold text-right px-2 py-2">Spot</th>
                    <th className="font-bold text-right px-3 py-2 border-l border-zinc-800">Entry ₹</th>
                    <th className="font-bold text-right px-3 py-2">Exit ₹</th>
                    <th className="font-bold text-right px-3 py-2 border-l border-zinc-800">P/L</th>
                    <th className="font-bold text-center px-2 py-2">Reason</th>
                    <th className="font-bold text-center px-2 py-2 border-l border-zinc-800">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {result.cycles.filter(c => c.exit_reason !== 'NO_ENTRY').map((c, idx) => (
                    <tr
                      key={idx}
                      onClick={() => setSelectedDayCycle(c)}
                      className={`border-t border-zinc-800 cursor-pointer transition-colors hover:bg-teal-500/10 group ${idx % 2 === 0 ? 'bg-zinc-900' : 'bg-zinc-850/40'}`}
                      title="Click to view full day trade execution"
                    >
                      <td className="px-3 py-2 text-zinc-500 font-bold">{idx + 1}</td>
                      <td className="px-3 py-2 text-zinc-200 font-mono font-medium">{fmtDate(c.entry_dt)}</td>
                      <td className="px-2 py-2 text-right text-zinc-400 font-mono">{fmtTime(c.entry_dt)}</td>
                      <td className="px-3 py-2 text-zinc-200 font-mono border-l border-zinc-800">{fmtDate(c.exit_dt)}</td>
                      <td className="px-2 py-2 text-right text-zinc-400 font-mono">{fmtTime(c.exit_dt)}</td>
                      <td className="px-2 py-2 text-center border-l border-zinc-800 font-medium">{cycleTypeLabel(c.legs)}</td>
                      <td className="px-2 py-2 text-right font-mono text-zinc-300">
                        {c.entry_spot != null ? Math.round(c.entry_spot).toLocaleString('en-IN') : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-200 border-l border-zinc-800">
                        {c.net_credit != null ? c.net_credit.toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-zinc-200">
                        {c.exit_combined != null ? Math.abs(c.exit_combined).toFixed(2) : '—'}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono font-bold border-l border-zinc-800 ${c.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                        {fmtPnl(c.pnl)}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${EXIT_REASON_CLS[c.exit_reason] ?? 'bg-zinc-800 text-zinc-400'}`}>
                          {c.exit_reason}
                        </span>
                      </td>
                      <td className="px-2 py-2 text-center border-l border-zinc-800">
                        <button
                          type="button"
                          onClick={(e) => { e.stopPropagation(); setSelectedDayCycle(c); }}
                          className="px-2 py-1 rounded bg-zinc-800 group-hover:bg-teal-600 group-hover:text-white text-zinc-300 text-[10px] font-semibold flex items-center gap-1 mx-auto transition-colors cursor-pointer"
                        >
                          <Eye className="w-3 h-3 text-teal-400 group-hover:text-white" /> View
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

      {/* ── Day Trade Execution Modal ── */}
      {selectedDayCycle && (() => {
        const filtered = result?.cycles.filter(c => c.exit_reason !== 'NO_ENTRY') || [];
        const currIdx = filtered.findIndex(
          item => item === selectedDayCycle || (item.entry_dt === selectedDayCycle.entry_dt && item.expiry_date === selectedDayCycle.expiry_date)
        );
        const orders = getTimewiseOrders(selectedDayCycle, lotSize || 65);
        const totalTurnover = orders.reduce((sum, o) => sum + o.turnover, 0);
        const netPts = (selectedDayCycle.net_credit != null && selectedDayCycle.exit_combined != null)
          ? selectedDayCycle.net_credit - Math.abs(selectedDayCycle.exit_combined)
          : null;

        return (
          <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 backdrop-blur-xs p-3 sm:p-5">
            <div className="bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 max-w-4xl w-full text-zinc-200 max-h-[92vh] flex flex-col overflow-hidden animate-in fade-in-0 zoom-in-95 duration-150">
              
              {/* Header */}
              <div className="flex items-center justify-between border-b border-zinc-800 px-5 py-3.5 bg-zinc-850/80 shrink-0">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg bg-teal-500/10 border border-teal-500/30 flex items-center justify-center text-teal-400 shrink-0">
                    <Clock className="w-4 h-4" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <h2 className="text-sm font-bold text-white tracking-tight">
                        Day Execution Log — {formatDayFull(selectedDayCycle.entry_dt)}
                      </h2>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 border border-zinc-700">
                        Expiry: {selectedDayCycle.expiry_date}
                      </span>
                    </div>
                    <p className="text-[11px] text-zinc-400 mt-0.5">
                      Spot: <span className="font-mono text-zinc-200 font-semibold">{selectedDayCycle.entry_spot != null ? Math.round(selectedDayCycle.entry_spot).toLocaleString('en-IN') : '—'}</span>
                      {' '}• Type: <span className="font-medium text-teal-300">{cycleTypeLabel(selectedDayCycle.legs)}</span>
                      {' '}• Reason: <span className="font-medium text-amber-300">{selectedDayCycle.exit_reason}</span>
                    </p>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <div className="text-right">
                    <span className="text-[10px] text-zinc-500 block uppercase font-bold tracking-wider">Day Net P&amp;L</span>
                    <span className={`text-base font-mono font-bold ${selectedDayCycle.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {fmtPnl(selectedDayCycle.pnl)}
                    </span>
                  </div>
                  <button
                    type="button"
                    onClick={() => setSelectedDayCycle(null)}
                    className="text-zinc-400 hover:text-white p-1 rounded-lg hover:bg-zinc-800 transition-colors cursor-pointer"
                    title="Close (Esc)"
                  >
                    <X className="w-5 h-5" />
                  </button>
                </div>
              </div>

              {/* Top KPI Cards Strip */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2.5 p-4 border-b border-zinc-800 bg-zinc-950/40 text-xs shrink-0">
                <div className="bg-zinc-900 border border-zinc-800/80 rounded-lg p-2.5">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block">Entry Time &amp; Spot</span>
                  <span className="text-xs font-mono font-semibold text-zinc-200 mt-0.5 block">
                    {fmtTime(selectedDayCycle.entry_dt)} @ {selectedDayCycle.entry_spot ? Math.round(selectedDayCycle.entry_spot).toLocaleString('en-IN') : '—'}
                  </span>
                </div>
                <div className="bg-zinc-900 border border-zinc-800/80 rounded-lg p-2.5">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block">Exit Time &amp; Reason</span>
                  <span className="text-xs font-mono font-semibold text-zinc-200 mt-0.5 block truncate" title={selectedDayCycle.exit_reason}>
                    {fmtTime(selectedDayCycle.exit_dt)} ({selectedDayCycle.exit_reason})
                  </span>
                </div>
                <div className="bg-zinc-900 border border-zinc-800/80 rounded-lg p-2.5">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block">Combined Premium</span>
                  <span className="text-xs font-mono font-semibold text-zinc-200 mt-0.5 block">
                    ₹{selectedDayCycle.net_credit != null ? selectedDayCycle.net_credit.toFixed(2) : '—'} &rarr; ₹{selectedDayCycle.exit_combined != null ? Math.abs(selectedDayCycle.exit_combined).toFixed(2) : '—'}
                  </span>
                </div>
                <div className="bg-zinc-900 border border-zinc-800/80 rounded-lg p-2.5">
                  <span className="text-[10px] text-zinc-500 font-bold uppercase tracking-wider block">Orders &amp; Adjustments</span>
                  <span className="text-xs font-mono font-semibold text-teal-400 mt-0.5 block">
                    {orders.length} Executions ({selectedDayCycle.rolls ?? 0} Shifts)
                  </span>
                </div>
              </div>

              {/* Tabs Toggle Strip */}
              <div className="px-5 pt-3 border-b border-zinc-800 flex items-center gap-2 bg-zinc-900 shrink-0">
                <button
                  type="button"
                  onClick={() => setDayModalTab('timeline')}
                  className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
                    dayModalTab === 'timeline'
                      ? 'border-teal-500 text-teal-400'
                      : 'border-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Clock className="w-3.5 h-3.5" /> Timewise Order Ledger ({orders.length})
                </button>
                <button
                  type="button"
                  onClick={() => setDayModalTab('legs')}
                  className={`pb-2.5 text-xs font-semibold flex items-center gap-1.5 border-b-2 transition-colors cursor-pointer ${
                    dayModalTab === 'legs'
                      ? 'border-teal-500 text-teal-400'
                      : 'border-transparent text-zinc-400 hover:text-zinc-200'
                  }`}
                >
                  <Layers className="w-3.5 h-3.5" /> Position Legs ({selectedDayCycle.legs.length})
                </button>
              </div>

              {/* Modal Body / Tables */}
              <div className="overflow-y-auto flex-1 p-5">
                {dayModalTab === 'timeline' ? (
                  <div className="bg-zinc-950/60 border border-zinc-800 rounded-xl overflow-hidden shadow-xs">
                    <table className="text-xs whitespace-nowrap w-full">
                      <thead>
                        <tr className="bg-zinc-800 text-white border-b border-zinc-700">
                          <th className="font-bold text-left px-3 py-2.5">#</th>
                          <th className="font-bold text-left px-3 py-2.5">Time</th>
                          <th className="font-bold text-center px-3 py-2.5 border-l border-zinc-800">Side</th>
                          <th className="font-bold text-center px-3 py-2.5">Action</th>
                          <th className="font-bold text-left px-3 py-2.5 border-l border-zinc-800">Instrument / Contract</th>
                          <th className="font-bold text-right px-2 py-2.5">Lots</th>
                          <th className="font-bold text-right px-3 py-2.5">Qty</th>
                          <th className="font-bold text-right px-3 py-2.5 border-l border-zinc-800">Price ₹</th>
                          <th className="font-bold text-right px-3 py-2.5">Turnover ₹</th>
                          <th className="font-bold text-center px-3 py-2.5 border-l border-zinc-800">Status</th>
                          <th className="font-bold text-left px-3 py-2.5 border-l border-zinc-800">Trigger / Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {orders.map((o, idx) => (
                          <tr
                            key={idx}
                            className={`border-t border-zinc-850 hover:bg-zinc-800/40 transition-colors ${
                              idx % 2 === 0 ? 'bg-zinc-900/60' : 'bg-zinc-950/40'
                            }`}
                          >
                            <td className="px-3 py-2.5 text-zinc-500 font-bold">{o.id}</td>
                            <td className="px-3 py-2.5 font-mono font-bold text-zinc-200">{o.time}</td>
                            <td className="px-3 py-2.5 text-center border-l border-zinc-800/60">
                              <span
                                className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                                  o.side === 'BUY'
                                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                    : 'bg-red-500/20 text-red-400 border border-red-500/40'
                                }`}
                              >
                                {o.side}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-center">
                              <span
                                className={`inline-block px-2 py-0.5 rounded text-[10px] font-semibold ${
                                  o.action === 'ENTRY'
                                    ? 'bg-zinc-800 text-zinc-300 border border-zinc-700'
                                    : o.action === 'ADJUSTMENT'
                                    ? 'bg-purple-500/20 text-purple-300 border border-purple-500/40'
                                    : 'bg-sky-500/20 text-sky-300 border border-sky-500/40'
                                }`}
                              >
                                {o.action}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 font-mono font-bold text-white border-l border-zinc-800/60">
                              {o.instrument}
                            </td>
                            <td className="px-2 py-2.5 text-right font-mono text-zinc-400">{o.lots}</td>
                            <td className="px-3 py-2.5 text-right font-mono text-zinc-300">{o.qty}</td>
                            <td className="px-3 py-2.5 text-right font-mono font-bold text-zinc-100 border-l border-zinc-800/60">
                              ₹{o.price.toFixed(2)}
                            </td>
                            <td className="px-3 py-2.5 text-right font-mono text-zinc-300">
                              ₹{Math.round(o.turnover).toLocaleString('en-IN')}
                            </td>
                            <td className="px-3 py-2.5 text-center border-l border-zinc-800/60">
                              <span className="inline-flex items-center gap-1 text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/30">
                                ● FILLED
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-zinc-300 border-l border-zinc-800/60 text-[11px]">
                              {o.reason}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div className="bg-zinc-950/60 border border-zinc-800 rounded-xl overflow-hidden shadow-xs">
                    <table className="text-xs whitespace-nowrap w-full">
                      <thead>
                        <tr className="bg-zinc-800 text-white border-b border-zinc-700">
                          <th className="font-bold text-left px-3 py-2.5">#</th>
                          <th className="font-bold text-center px-2 py-2.5">Option</th>
                          <th className="font-bold text-right px-3 py-2.5">Strike</th>
                          <th className="font-bold text-center px-3 py-2.5 border-l border-zinc-800">Position</th>
                          <th className="font-bold text-right px-2 py-2.5">Lots</th>
                          <th className="font-bold text-right px-3 py-2.5 border-l border-zinc-800">Entry Time &amp; Price</th>
                          <th className="font-bold text-right px-3 py-2.5">Exit Time &amp; Price</th>
                          <th className="font-bold text-right px-3 py-2.5 border-l border-zinc-800">Points</th>
                          <th className="font-bold text-right px-3 py-2.5">Leg P/L ₹</th>
                          <th className="font-bold text-center px-3 py-2.5 border-l border-zinc-800">Exit Reason</th>
                        </tr>
                      </thead>
                      <tbody>
                        {selectedDayCycle.legs.map((leg, idx) => {
                          const legPts = leg.entry_price != null && leg.exit_price != null
                            ? (leg.position.toLowerCase() === 'sell' ? (leg.entry_price - leg.exit_price) : (leg.exit_price - leg.entry_price))
                            : null;
                          return (
                            <tr
                              key={idx}
                              className={`border-t border-zinc-850 hover:bg-zinc-800/40 transition-colors ${
                                idx % 2 === 0 ? 'bg-zinc-900/60' : 'bg-zinc-950/40'
                              }`}
                            >
                              <td className="px-3 py-2.5 text-zinc-500 font-bold">{idx + 1}</td>
                              <td className="px-2 py-2.5 text-center font-bold text-zinc-200">
                                <span className={leg.option_type === 'CE' ? 'text-teal-400' : 'text-amber-400'}>
                                  {leg.option_type}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono font-bold text-white">{leg.strike}</td>
                              <td className="px-3 py-2.5 text-center border-l border-zinc-800/60">
                                <span
                                  className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${
                                    leg.position.toLowerCase() === 'sell'
                                      ? 'bg-red-500/20 text-red-400 border border-red-500/40'
                                      : 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/40'
                                  }`}
                                >
                                  {leg.position.toUpperCase()}
                                </span>
                              </td>
                              <td className="px-2 py-2.5 text-right font-mono text-zinc-400">{leg.lots}</td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-200 border-l border-zinc-800/60">
                                <span className="text-zinc-500 mr-1.5 text-[11px]">{leg.entry_time || fmtTime(selectedDayCycle.entry_dt)}</span>
                                <span className="font-bold">₹{leg.entry_price != null ? leg.entry_price.toFixed(2) : '—'}</span>
                              </td>
                              <td className="px-3 py-2.5 text-right font-mono text-zinc-200">
                                <span className="text-zinc-500 mr-1.5 text-[11px]">{leg.exit_time || fmtTime(selectedDayCycle.exit_dt)}</span>
                                <span className="font-bold">₹{leg.exit_price != null ? Math.abs(leg.exit_price).toFixed(2) : '—'}</span>
                              </td>
                              <td className={`px-3 py-2.5 text-right font-mono font-bold border-l border-zinc-800/60 ${
                                (legPts ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'
                              }`}>
                                {legPts != null ? `${legPts >= 0 ? '+' : ''}${legPts.toFixed(2)} pts` : '—'}
                              </td>
                              <td className={`px-3 py-2.5 text-right font-mono font-bold ${
                                leg.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'
                              }`}>
                                {fmtPnl(leg.pnl)}
                              </td>
                              <td className="px-3 py-2.5 text-center border-l border-zinc-800/60">
                                <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${EXIT_REASON_CLS[leg.exit_reason] ?? 'bg-zinc-800 text-zinc-400'}`}>
                                  {leg.exit_reason || selectedDayCycle.exit_reason}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {/* Financial Summary Footnote */}
                <div className="mt-4 p-3 rounded-xl bg-zinc-950/60 border border-zinc-800/80 flex items-center justify-between flex-wrap gap-3 text-xs">
                  <div className="flex items-center gap-4 text-zinc-400">
                    <div>
                      <span className="text-zinc-500 block text-[10px] uppercase font-bold">Gross Turnover</span>
                      <span className="font-mono text-zinc-200 font-semibold">₹{Math.round(totalTurnover).toLocaleString('en-IN')}</span>
                    </div>
                    {netPts != null && (
                      <div>
                        <span className="text-zinc-500 block text-[10px] uppercase font-bold">Points Captured</span>
                        <span className={`font-mono font-semibold ${netPts >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {netPts >= 0 ? '+' : ''}{netPts.toFixed(2)} pts
                        </span>
                      </div>
                    )}
                    <div>
                      <span className="text-zinc-500 block text-[10px] uppercase font-bold">Execution Friction</span>
                      <span className="font-mono text-zinc-300 font-semibold">
                        ~₹{((includeCosts ? commissionPerLot : 40) * selectedDayCycle.legs.length).toFixed(0)}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <span className="text-zinc-500 block text-[10px] uppercase font-bold">Session Net Realized</span>
                    <span className={`text-sm font-mono font-bold ${selectedDayCycle.pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                      {fmtPnl(selectedDayCycle.pnl)}
                    </span>
                  </div>
                </div>
              </div>

              {/* Footer with Prev / Next Navigation */}
              <div className="border-t border-zinc-800 px-5 py-3 bg-zinc-850/80 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={currIdx <= 0}
                    onClick={() => currIdx > 0 && setSelectedDayCycle(filtered[currIdx - 1])}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                      currIdx <= 0
                        ? 'border-zinc-800 text-zinc-600 bg-zinc-900 cursor-not-allowed'
                        : 'border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                    }`}
                  >
                    <ChevronLeft className="w-4 h-4" /> Previous Day
                  </button>
                  <span className="text-xs font-mono text-zinc-400 px-2">
                    Day {currIdx + 1} of {filtered.length}
                  </span>
                  <button
                    type="button"
                    disabled={currIdx >= filtered.length - 1}
                    onClick={() => currIdx < filtered.length - 1 && setSelectedDayCycle(filtered[currIdx + 1])}
                    className={`px-3 py-1.5 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
                      currIdx >= filtered.length - 1
                        ? 'border-zinc-800 text-zinc-600 bg-zinc-900 cursor-not-allowed'
                        : 'border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200'
                    }`}
                  >
                    Next Day <ChevronRight className="w-4 h-4" />
                  </button>
                </div>

                <button
                  type="button"
                  onClick={() => setSelectedDayCycle(null)}
                  className="px-4 py-1.5 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 border border-zinc-700 rounded-lg text-xs font-bold transition-colors cursor-pointer"
                >
                  Close (Esc)
                </button>
              </div>

            </div>
          </div>
        );
      })()}

      {/* ── Past Backtests History Modal ── */}
      {historyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 backdrop-blur-xs p-4">
          <div className="bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 max-w-4xl w-full p-5 text-zinc-200 max-h-[88vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3 mb-3">
              <div>
                <h2 className="text-sm font-bold text-white flex items-center gap-2">
                  <History className="w-4 h-4 text-teal-400" /> Past Options Backtests
                </h2>
                <p className="text-[11px] text-zinc-500 mt-0.5">
                  Archived simulations stored under <code className="bg-zinc-800 px-1 py-0.5 rounded text-[10px] font-mono text-zinc-300">debug/backtests/options/</code>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={fetchHistory}
                  title="Refresh backtest list"
                  className="p-1.5 text-zinc-400 hover:text-zinc-200 rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingHistory ? 'animate-spin text-teal-400' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryModalOpen(false)}
                  className="text-zinc-400 hover:text-zinc-200 p-1 rounded hover:bg-zinc-800 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Search Input */}
            <div className="relative mb-3">
              <Search className="w-3.5 h-3.5 text-zinc-500 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                placeholder="Search backtests by strategy name, date, tag (e.g. straddle, iron condor, 2026)..."
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                className="w-full bg-zinc-800 border border-zinc-700 rounded-lg pl-8 pr-8 py-1.5 text-xs text-zinc-100 placeholder:text-zinc-500 focus:outline-hidden focus:border-teal-500 transition-colors"
              />
              {historySearch && (
                <button
                  type="button"
                  onClick={() => setHistorySearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-500 hover:text-zinc-300 text-xs cursor-pointer"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Backtest Cards List */}
            <div className="overflow-y-auto flex-1 pr-1 space-y-3">
              {loadingHistory && historyList.length === 0 ? (
                <div className="py-12 text-center text-xs text-zinc-500">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-teal-400" />
                  Loading archived backtests…
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="py-12 text-center text-xs text-zinc-500 bg-zinc-850/40 rounded-xl border border-dashed border-zinc-800">
                  {historySearch ? 'No backtests match your search filter.' : 'No saved backtests found in debug/backtests/options/.'}
                </div>
              ) : (
                filteredHistory.map(item => {
                  const pnl = item.total_pnl ?? 0;
                  const isProfit = pnl >= 0;
                  const winRate = item.win_rate ?? 0;
                  return (
                    <div
                      key={item.id}
                      className="border border-zinc-800 rounded-xl p-3.5 bg-zinc-850/60 hover:border-teal-500/60 hover:bg-zinc-850 transition-all text-xs"
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div>
                          <div className="font-bold text-white text-sm flex items-center gap-2 flex-wrap">
                            <span>{item.name}</span>
                            {item.strategy_type && (
                              <span className="text-[9px] uppercase px-1.5 py-0.5 bg-zinc-800 text-zinc-400 rounded font-semibold tracking-wider">
                                {item.strategy_type}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-zinc-500 mt-0.5 font-mono">
                            {item.start_date || '—'} &rarr; {item.end_date || '—'} &bull; Run: {item.timestamp ? new Date(item.timestamp).toLocaleString('en-IN') : item.id}
                          </div>
                        </div>

                        {/* P&L Pill */}
                        <div className="text-right shrink-0">
                          <span className={`text-sm font-bold font-mono ${isProfit ? 'text-emerald-600' : 'text-red-600'}`}>
                            {fmtPnl(pnl)}
                          </span>
                          <span className="block text-[10px] text-zinc-500">Total P&amp;L</span>
                        </div>
                      </div>

                      {/* Metrics strip */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-zinc-800/60 border border-zinc-750 rounded-lg p-2 mb-3 font-mono text-[11px]">
                        <div>
                          <span className="text-[9px] text-zinc-500 font-sans block">Win Rate</span>
                          <span className={`font-semibold ${winRate >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {winRate.toFixed(1)}%
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-zinc-500 font-sans block">Max Drawdown</span>
                          <span className="font-semibold text-amber-600">
                            ₹{fmt(item.max_drawdown ?? 0)}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-zinc-500 font-sans block">Total Cycles</span>
                          <span className="font-semibold text-zinc-200">
                            {item.trades ?? '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-zinc-500 font-sans block">Folder</span>
                          <span className="text-[10px] text-zinc-500 truncate block" title={item.id}>
                            {item.id}
                          </span>
                        </div>
                      </div>

                      {/* Tags & Action Buttons */}
                      <div className="flex items-center justify-between flex-wrap gap-2 pt-1 border-t border-zinc-800">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {item.tags?.map(t => (
                            <span key={t} className="text-[10px] bg-zinc-800 text-zinc-400 px-1.5 py-0.5 rounded">
                              #{t}
                            </span>
                          ))}
                        </div>

                        <div className="flex items-center gap-2 ml-auto">
                          {item.has_report && (
                            <button
                              type="button"
                              onClick={() => setViewingReportId(item.id)}
                              className="border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20 px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors bg-emerald-500/10 shadow-xs"
                            >
                              <FileText className="w-3 h-3 text-emerald-400" /> Research Report
                            </button>
                          )}
                          {item.has_tearsheet && (
                            <button
                              type="button"
                              onClick={() => setViewingTearsheetId(item.id)}
                              className="border border-teal-500/40 text-teal-300 bg-teal-500/10 hover:bg-teal-500/20 px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors"
                            >
                              <FileText className="w-3 h-3" /> Tearsheet
                            </button>
                          )}
                          {item.has_trades_csv && (
                            <a
                              href={`/api/backtest/history?id=${encodeURIComponent(item.id)}&file=csv`}
                              download
                              className="border border-zinc-700 text-zinc-300 hover:bg-zinc-800 px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors bg-zinc-800"
                            >
                              <Download className="w-3 h-3" /> CSV
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => handleLoadHistoryItem(item.id)}
                            className="bg-teal-600 hover:bg-teal-500 text-oncolor px-3 py-1 rounded text-[11px] font-bold shadow-xs cursor-pointer transition-colors flex items-center gap-1"
                          >
                            Load Backtest
                          </button>
                        </div>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div className="mt-3 pt-3 border-t border-zinc-800 flex justify-between items-center text-[11px] text-zinc-500">
              <span>{historyList.length} backtest{historyList.length === 1 ? '' : 's'} archived in debug/backtests/options/</span>
              <button
                type="button"
                onClick={() => setHistoryModalOpen(false)}
                className="text-zinc-400 hover:text-white font-semibold px-3 py-1 rounded hover:bg-zinc-800 cursor-pointer"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Tearsheet Preview Modal ── */}
      {viewingTearsheetId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 backdrop-blur-xs p-4">
          <div className="bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 max-w-6xl w-full h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-850/80">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-teal-400" />
                <span className="font-bold text-white text-xs sm:text-sm">
                  Interactive Tearsheet: {viewingTearsheetId}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <a
                  href={`/api/backtest/history?id=${encodeURIComponent(viewingTearsheetId)}&file=tearsheet`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-teal-400 hover:underline font-semibold flex items-center gap-1"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Open in New Tab
                </a>
                <button
                  type="button"
                  onClick={() => setViewingTearsheetId(null)}
                  className="text-zinc-500 hover:text-zinc-300 p-1 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 bg-zinc-950">
              <iframe
                src={`/api/backtest/history?id=${encodeURIComponent(viewingTearsheetId)}&file=tearsheet`}
                className="w-full h-full border-0"
                title="Tearsheet Preview"
              />
            </div>
          </div>
        </div>
      )}

      {/* ── Research Report Preview Modal ── */}
      {viewingReportId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 backdrop-blur-xs p-4">
          <div className="bg-zinc-900 rounded-2xl shadow-2xl border border-zinc-800 max-w-6xl w-full h-[92vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-zinc-800 bg-zinc-850/80">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-600" />
                <span className="font-bold text-white text-xs sm:text-sm">
                  Research &amp; Trade Details Report: {viewingReportId}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <a
                  href={`/api/backtest/history?id=${encodeURIComponent(viewingReportId)}&file=report`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-emerald-700 hover:underline font-semibold flex items-center gap-1"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Open in New Tab
                </a>
                <button
                  type="button"
                  onClick={() => setViewingReportId(null)}
                  className="text-zinc-500 hover:text-zinc-300 p-1 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 bg-zinc-950">
              <iframe
                src={`/api/backtest/history?id=${encodeURIComponent(viewingReportId)}&file=report`}
                className="w-full h-full border-0"
                title="Research Report Preview"
              />
            </div>
          </div>
        </div>
      )}

    </div>
  );
}
