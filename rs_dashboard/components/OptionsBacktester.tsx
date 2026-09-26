'use client';

import React, { useState, useEffect, useRef } from 'react';
import dynamic from 'next/dynamic';
import NavBar from './NavBar';
import {
  Copy, Trash2, Settings, Share2, Save, Info, Plus, Calendar,
  Square, RefreshCw, History, ExternalLink, Download, FileText, Search, X
} from 'lucide-react';
import { toast } from 'sonner';

// Lazy-load recharts so initial bundle stays lightweight
const BacktestCharts = dynamic(() => import('@/components/BacktestCharts'), {
  ssr: false,
  loading: () => <div className="h-64 bg-slate-100 border border-slate-200 rounded-lg animate-pulse" />,
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

type StrikeMode = 'offset' | 'atm_percent' | 'closest_premium' | 'straddle_width' | 'closest_delta';

interface LegConfig {
  option_type: 'CE' | 'PE';
  position: 'sell' | 'buy';
  lots: number;
  strike: string;          // offset string, or a %/premium/delta value depending on strike_type
  leg_sl_pct: number;      // 0 = disabled
  leg_target_pct: number;  // 0 = disabled
  leg_trail_sl_pct?: number; // 0 = disabled
  strike_type?: StrikeMode;
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

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

const EXIT_REASON_CLS: Record<string, string> = {
  TARGET:        'bg-emerald-50 text-emerald-700 border border-emerald-300',
  SCALP_FLOOR:   'bg-emerald-50 text-emerald-700 border border-emerald-400',
  LEG_TARGET:    'bg-emerald-50 text-emerald-700 border border-emerald-300',
  EOD:           'bg-sky-50 text-sky-700 border border-sky-300',
  LEG_SL:        'bg-red-50 text-red-700 border border-red-300',
  LEG_TRAIL_SL:  'bg-amber-50 text-amber-700 border border-amber-300',
  TRAIL_SL:      'bg-amber-50 text-amber-700 border border-amber-300',
  ALL_LEGS_DONE: 'bg-red-50 text-red-700 border border-red-300',
  SQUARE_OFF_ALL: 'bg-purple-50 text-purple-700 border border-purple-300',
  OVERALL_SL:    'bg-red-100 text-red-800 border border-red-400',
  INCOMPLETE:    'bg-amber-50 text-amber-700 border border-amber-300',
  ROLL_ATM:      'bg-purple-50 text-purple-700 border border-purple-300',
  NO_ENTRY:      'bg-slate-100 text-slate-500 border border-slate-200',
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
      <span className="text-[11px] text-slate-500 font-medium mb-1">{label}</span>
      <div
        onClick={() => inputRef.current?.showPicker ? inputRef.current.showPicker() : inputRef.current?.focus()}
        className="relative bg-oncolor border border-slate-300 rounded px-3 py-1.5 text-xs text-slate-700 font-medium cursor-pointer flex items-center justify-between hover:border-[#54b4c7] transition-colors shadow-sm"
      >
        <span>{formatted}</span>
        <Calendar className="w-3.5 h-3.5 text-slate-400" />
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
  const [builderLots, setBuilderLots] = useState(1);

  // ── Underlying & execution options
  const [selectedMainIndex, setSelectedMainIndex] = useState('Nifty');
  const [squareOffMode, setSquareOffMode] = useState<'one_leg' | 'all_legs'>('one_leg');

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
  const [profitTargetPct, setProfitTargetPct] = useState(0);

  const [strategySlActive, setStrategySlActive] = useState(false);
  const [overallSlPct, setOverallSlPct] = useState(0);

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

  // Results & execution
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [statusData, setStatusData] = useState<{
    percent?: number;
    current?: number;
    total?: number;
    date?: string;
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
      if (p.profit_target_pct) {
        setProfitTargetPct(Number(p.profit_target_pct));
        setStrategyTargetActive(true);
      }
      if (p.overall_sl_pct) {
        setOverallSlPct(Number(p.overall_sl_pct));
        setStrategySlActive(true);
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

  // Map strike mode to Leg strike_type. "CP based on Straddle Premium (SP)" and
  // "Straddle Width" both resolve to the backend's straddle_width mode — both are
  // "pick the strike whose own premium is closest to X% of the ATM straddle
  // premium," the only difference is which % StockMock's UI defaults the field to.
  // There is no separate SP implementation on the backend, so aliasing here (rather
  // than silently falling through to plain ATM offset) is what actually runs the
  // calculation the user picked instead of a different one with no indication.
  function strikeModeToType(m: StrikeModeLabel): StrikeMode {
    if (m === 'ATM Percent') return 'atm_percent';
    if (m === 'Closest Premium (CP)') return 'closest_premium';
    if (m === 'Straddle Width' || m === 'CP based on Straddle Premium (SP)') return 'straddle_width';
    return 'offset';
  }

  // Placeholder/default strike value per mode, used both by the top toolbar and
  // by a leg row's own strike-mode dropdown so a mode switch always leaves a
  // numerically valid value instead of a stale offset string like "ATM+3".
  function defaultStrikeValueFor(m: StrikeModeLabel): string {
    if (m === 'ATM Point') return 'ATM';
    if (m === 'ATM Percent') return '2';
    if (m === 'Closest Premium (CP)') return '100';
    return '30'; // Straddle Width / CP based on Straddle Premium (SP)
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
    const newLeg: LegConfig = {
      option_type: builderOptionType === 'Call' ? 'CE' : 'PE',
      position: builderActionType.toLowerCase() as 'buy' | 'sell',
      lots: Math.max(1, builderLots),
      strike: builderStrike || 'ATM',
      strike_type: strikeModeToType(selectedStrikeMode),
      leg_sl_pct: 0,
      leg_target_pct: 0,
      leg_trail_sl_pct: 0,
    };
    setLegs(prev => [...prev, newLeg]);
    toast.success(`Added ${builderActionType} ${builderOptionType} (${builderStrike})`);
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
      setProfitTargetPct(50);
      setStrategyTargetActive(true);
      setOverallSlPct(0);
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
      setProfitTargetPct(60);
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
          legs,
          lot_size: lotSize,
          profit_target_pct: strategyTargetActive ? profitTargetPct : 0,
          overall_sl_pct: strategySlActive ? overallSlPct : 0,
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
          if (sData.running) {
            emptyDoneStreak = 0;
            setStatusData({
              percent: sData.percent ?? 0,
              current: sData.current ?? 0,
              total: sData.total ?? 0,
              date: sData.date,
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
      target: strategyTargetActive ? profitTargetPct : 0,
      sl: strategySlActive ? overallSlPct : 0,
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
    <div className="min-h-screen bg-[#edf2f6] text-slate-700 font-sans pb-24 select-none">
      {/* ── Top Header Banner: POSITIONS ── */}
      <div className="w-full bg-[#54b4c7] py-2 px-4 shadow-sm flex items-center justify-center relative">
        <h1 className="text-white text-xs md:text-sm font-bold tracking-widest uppercase">
          {pageTitle ?? 'POSITIONS'}
        </h1>
        {/* Standard global controls (theme toggle, Sync Data, Update, Disconnect) —
            every other page carries these; this StockMock-styled header dropped them
            in the rewrite, which also meant losing the way out of the page (Disconnect)
            and the site-wide data-freshness controls.
            NavBar's plain-text items (Disconnect, the theme toggle) are styled for a
            dark backdrop and are nearly invisible directly on this light teal banner —
            the dark pill below gives them the backdrop they need, same as they'd have
            on every other page. Must be bg-oncolor-dark, not bg-zinc-900: zinc-900 is
            a themed token that inverts to near-white in light mode, which would turn
            this "dark" pill light and make NavBar's light-mode text disappear on it. */}
        <div className="absolute right-3 top-1/2 -translate-y-1/2 bg-oncolor-dark rounded-xl px-1.5 py-1 shadow-sm">
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
        <div className="flex items-center justify-center flex-wrap gap-4 md:gap-7 py-2 text-xs text-slate-600 font-medium">
          {STRIKE_MODES.map(mode => (
            <label key={mode} className="flex items-center gap-1.5 cursor-pointer hover:text-slate-900 transition-colors">
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
                className="w-3.5 h-3.5 accent-[#54b4c7] cursor-pointer"
              />
              <span>{mode}</span>
              {(mode.includes('(CP)') || mode.includes('(SP)')) && (
                <Info className="w-3 h-3 text-slate-400 inline" />
              )}
            </label>
          ))}
        </div>

        {/* Dotted Divider */}
        <div className="w-full border-b border-dashed border-slate-300 my-2.5" />

        {/* ── Position Builder Controls Row ── */}
        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3 items-end pt-1 pb-3">
          {/* 1. Select Index — only Nifty has local option data (see the notice below
               the leg rows); the others are shown per the StockMock layout but disabled
               rather than silently accepted and ignored. */}
          <div>
            <label className="block text-[11px] text-slate-500 font-medium mb-1">Select Index:</label>
            <select
              value={builderIndex}
              onChange={e => setBuilderIndex(e.target.value)}
              className="w-full bg-oncolor border border-slate-300 rounded px-2.5 py-1.5 text-xs text-slate-700 font-medium focus:outline-none focus:border-[#54b4c7] shadow-sm"
            >
              <option value="Nifty">Nifty</option>
              <option value="Banknifty" disabled title="No local Banknifty option data">Banknifty (no data)</option>
              <option value="FinNifty" disabled title="No local FinNifty option data">FinNifty (no data)</option>
              <option value="Sensex" disabled title="No local Sensex option data">Sensex (no data)</option>
            </select>
          </div>

          {/* 2. Select Segment */}
          <div>
            <label className="block text-[11px] text-slate-500 font-medium mb-1">Select Segment:</label>
            <div className="flex rounded overflow-hidden border border-slate-300 shadow-sm">
              <button
                type="button"
                onClick={() => setBuilderSegment('Futures')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderSegment === 'Futures'
                    ? 'bg-[#54b4c7] text-white'
                    : 'bg-oncolor text-slate-600 hover:bg-slate-50'
                }`}
              >
                Futures
              </button>
              <button
                type="button"
                onClick={() => setBuilderSegment('Options')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderSegment === 'Options'
                    ? 'bg-[#54b4c7] text-white'
                    : 'bg-oncolor text-slate-600 hover:bg-slate-50'
                }`}
              >
                Options
              </button>
            </div>
          </div>

          {/* 3. Option Type */}
          <div>
            <label className="block text-[11px] text-slate-500 font-medium mb-1">Option Type:</label>
            <div className="flex rounded overflow-hidden border border-slate-300 shadow-sm">
              <button
                type="button"
                onClick={() => setBuilderOptionType('Call')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderOptionType === 'Call'
                    ? 'bg-[#54b4c7] text-white'
                    : 'bg-oncolor text-slate-600 hover:bg-slate-50'
                }`}
              >
                Call
              </button>
              <button
                type="button"
                onClick={() => setBuilderOptionType('Put')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderOptionType === 'Put'
                    ? 'bg-[#54b4c7] text-white'
                    : 'bg-oncolor text-slate-600 hover:bg-slate-50'
                }`}
              >
                Put
              </button>
            </div>
          </div>

          {/* 4. Action Type */}
          <div>
            <label className="block text-[11px] text-slate-500 font-medium mb-1">Action Type:</label>
            <div className="flex rounded overflow-hidden border border-slate-300 shadow-sm">
              <button
                type="button"
                onClick={() => setBuilderActionType('Buy')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderActionType === 'Buy'
                    ? 'bg-[#54b4c7] text-white'
                    : 'bg-oncolor text-slate-600 hover:bg-slate-50'
                }`}
              >
                Buy
              </button>
              <button
                type="button"
                onClick={() => setBuilderActionType('Sell')}
                className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                  builderActionType === 'Sell'
                    ? 'bg-[#54b4c7] text-white'
                    : 'bg-oncolor text-slate-600 hover:bg-slate-50'
                }`}
              >
                Sell
              </button>
            </div>
          </div>

          {/* 5. Strike Price */}
          <div>
            <label className="block text-[11px] text-slate-500 font-medium mb-1">Strike Price:</label>
            {selectedStrikeMode === 'ATM Point' ? (
              <select
                value={builderStrike}
                onChange={e => setBuilderStrike(e.target.value)}
                className="w-full bg-oncolor border border-slate-300 rounded px-2.5 py-1.5 text-xs text-slate-700 font-medium focus:outline-none focus:border-[#54b4c7] shadow-sm"
              >
                {STRIKE_OPTIONS.map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            ) : (
              <input
                type="number"
                min={0}
                value={builderStrike}
                onChange={e => setBuilderStrike(e.target.value)}
                placeholder={
                  selectedStrikeMode === 'ATM Percent' ? 'e.g. 2 (%)' :
                  selectedStrikeMode === 'Closest Premium (CP)' ? 'e.g. 100 (premium)' :
                  'e.g. 30 (% of straddle)'
                }
                className="w-full bg-oncolor border border-slate-300 rounded px-2.5 py-1.5 text-xs text-slate-700 font-medium focus:outline-none focus:border-[#54b4c7] shadow-sm"
              />
            )}
          </div>

          {/* 6. Total Lot */}
          <div>
            <label className="block text-[11px] text-slate-500 font-medium mb-1">Total Lot</label>
            <input
              type="number"
              min={1}
              value={builderLots}
              onChange={e => setBuilderLots(Math.max(1, Number(e.target.value)))}
              className="w-full bg-oncolor border border-slate-300 rounded px-2.5 py-1.5 text-xs text-slate-700 font-medium text-center focus:outline-none focus:border-[#54b4c7] shadow-sm"
            />
          </div>

          {/* 7. Expiry Type — same single-expiry-cycle limitation as the per-leg
               dropdown below; the engine always trades the nearest weekly cycle. */}
          <div>
            <label className="block text-[11px] text-slate-500 font-medium mb-1">Expiry Type:</label>
            <select
              disabled
              defaultValue="Weekly"
              title="Not implemented yet — the engine always trades the nearest weekly expiry"
              className="w-full bg-slate-100 border border-slate-300 rounded px-2.5 py-1.5 text-xs text-slate-400 font-medium cursor-not-allowed"
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
            className="bg-[#54b4c7] hover:bg-[#469fb1] text-white font-semibold text-xs px-5 py-1.5 rounded shadow-sm transition-colors cursor-pointer flex items-center gap-1.5"
          >
            Add Position
          </button>
        </div>

        {/* ── Settings Bar above Leg Rows ── */}
        <div className="flex items-center justify-between flex-wrap gap-4 pt-3 pb-2 text-xs text-slate-600">
          {/* Left: Spot / Futures toggle & Index */}
          <div className="flex items-center gap-4">
            <div className="flex items-center gap-2" title="Futures-as-ATM needs a futures price series; the option data here only carries spot">
              <span className="flex items-center gap-1.5 text-xs cursor-not-allowed opacity-50">
                <span className="font-semibold text-slate-800">
                  Use Spot as ATM
                </span>
                <div className="w-7 h-4 bg-slate-300 rounded-full relative p-0.5">
                  <div className="w-3 h-3 rounded-full bg-oncolor shadow-sm" />
                </div>
                <span className="text-slate-500">
                  Use Futures as ATM
                </span>
              </span>
            </div>

            <div className="flex items-center gap-1.5">
              <span className="text-slate-500">Index:</span>
              <select
                value={selectedMainIndex}
                onChange={e => setSelectedMainIndex(e.target.value)}
                className="bg-oncolor border border-slate-300 rounded px-2 py-0.5 text-xs text-slate-700 font-medium focus:outline-none"
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
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="squareOffMode"
                  checked={squareOffMode === 'one_leg'}
                  onChange={() => setSquareOffMode('one_leg')}
                  className="w-3.5 h-3.5 accent-[#54b4c7]"
                />
                <span>Square Off One Leg</span>
                <Info className="w-3 h-3 text-slate-400" />
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  name="squareOffMode"
                  checked={squareOffMode === 'all_legs'}
                  onChange={() => setSquareOffMode('all_legs')}
                  className="w-3.5 h-3.5 accent-[#54b4c7]"
                />
                <span>Square Off All Legs</span>
                <Info className="w-3 h-3 text-slate-400" />
              </label>
            </div>

            <div className="flex items-center gap-3">
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50" title="Not implemented yet — needs a re-architected entry trigger">
                <input type="checkbox" disabled className="w-3.5 h-3.5 rounded" />
                <span>Wait &amp; Trade</span>
                <Info className="w-3 h-3 text-slate-400" />
              </label>
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50" title="Not implemented yet — needs a defined profit threshold that moves the SL">
                <input type="checkbox" disabled className="w-3.5 h-3.5 rounded" />
                <span>Move SL to Cost</span>
                <Info className="w-3 h-3 text-slate-400" />
              </label>
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50" title="Not implemented yet — needs multi-entry-per-day simulation">
                <input type="checkbox" disabled className="w-3.5 h-3.5 rounded" />
                <span>Re-Entry / Re-Execute</span>
                <Info className="w-3 h-3 text-slate-400" />
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
                className="bg-[#edf2f6] border border-slate-300/80 rounded px-3 py-2 flex items-center justify-between flex-wrap gap-2.5 shadow-sm"
              >
                {/* Left controls */}
                <div className="flex items-center gap-2.5 flex-wrap">
                  <input
                    type="checkbox"
                    defaultChecked
                    className="w-3.5 h-3.5 accent-[#54b4c7] rounded cursor-pointer"
                  />

                  {/* Leg index badge */}
                  <div className="flex flex-col">
                    <span className="text-[9px] font-bold text-slate-400 leading-none">L{index + 1}</span>
                    <span className="text-[10px] text-slate-500 font-medium">Lots:</span>
                  </div>

                  {/* Lots input */}
                  <input
                    type="number"
                    min={1}
                    value={leg.lots}
                    onChange={e => handleUpdateLeg(index, { lots: Math.max(1, Number(e.target.value)) })}
                    className="w-11 bg-oncolor border border-slate-300 rounded px-1 py-0.5 text-xs text-slate-800 text-center font-semibold focus:outline-none"
                  />

                  {/* Sell / Buy action badge */}
                  <button
                    type="button"
                    onClick={() => handleUpdateLeg(index, { position: isSell ? 'buy' : 'sell' })}
                    className={`text-[11px] font-bold px-2 py-0.5 rounded cursor-pointer transition-colors ${
                      isSell
                        ? 'border border-red-400 text-red-500 bg-oncolor hover:bg-red-50'
                        : 'border border-emerald-500 text-emerald-600 bg-oncolor hover:bg-emerald-50'
                    }`}
                  >
                    {leg.position.toUpperCase()}
                  </button>

                  {/* Strike Mode selector */}
                  <div className="flex flex-col">
                    <select
                      value={
                        strikeMode === 'atm_percent' ? 'ATM Percent' :
                        strikeMode === 'closest_premium' ? 'Closest Premium (CP)' :
                        strikeMode === 'straddle_width' ? 'Straddle Width' : 'ATM Point'
                      }
                      onChange={e => {
                        const m = e.target.value as StrikeModeLabel;
                        handleUpdateLeg(index, {
                          strike_type: strikeModeToType(m),
                          strike: m === 'ATM Point' ? 'ATM' : '2',
                        });
                      }}
                      className="bg-oncolor border border-slate-300 rounded px-2 py-0.5 text-xs text-slate-700 font-medium focus:outline-none"
                    >
                      <option value="ATM Point">ATM Point</option>
                      <option value="ATM Percent">ATM Percent</option>
                      <option value="Straddle Width">Straddle Width</option>
                      <option value="Closest Premium (CP)">Closest Premium (CP)</option>
                    </select>
                  </div>

                  {/* Strike Value selector */}
                  {strikeMode === 'offset' ? (
                    <select
                      value={leg.strike}
                      onChange={e => handleUpdateLeg(index, { strike: e.target.value })}
                      className="bg-oncolor border border-slate-300 rounded px-2 py-0.5 text-xs text-slate-700 font-medium focus:outline-none"
                    >
                      {STRIKE_OPTIONS.map(s => (
                        <option key={s} value={s}>{s}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="number"
                      value={leg.strike}
                      onChange={e => handleUpdateLeg(index, { strike: e.target.value })}
                      placeholder="Value"
                      className="w-16 bg-oncolor border border-slate-300 rounded px-2 py-0.5 text-xs text-slate-700 font-medium focus:outline-none text-center"
                    />
                  )}

                  {/* Call / Put option badge */}
                  <button
                    type="button"
                    onClick={() => handleUpdateLeg(index, { option_type: isCall ? 'PE' : 'CE' })}
                    className="bg-[#54b4c7] hover:bg-[#459eb0] text-white font-bold text-[11px] px-2.5 py-0.5 rounded cursor-pointer transition-colors shadow-sm"
                  >
                    {isCall ? 'CALL' : 'PUT'}
                  </button>
                </div>

                {/* Right controls: + Target Profit, + Stop Loss, + Trail Stop Loss, + Journey, Expiry, Copy, Trash */}
                <div className="flex items-center gap-3.5 flex-wrap">
                  {/* Target Profit Chip */}
                  {leg.leg_target_pct > 0 ? (
                    <div className="flex items-center gap-1 bg-oncolor border border-blue-300 text-[#2596be] px-1.5 py-0.5 rounded text-xs font-semibold shadow-sm">
                      <span className="text-[10px]">Tgt:</span>
                      <input
                        type="number"
                        value={leg.leg_target_pct}
                        onChange={e => handleUpdateLeg(index, { leg_target_pct: Number(e.target.value) })}
                        className="w-10 bg-slate-50 border border-slate-200 rounded px-1 text-center text-xs text-slate-800"
                      />
                      <span>%</span>
                      <button
                        type="button"
                        onClick={() => handleUpdateLeg(index, { leg_target_pct: 0 })}
                        className="text-slate-400 hover:text-red-500 ml-0.5 leading-none"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleUpdateLeg(index, { leg_target_pct: 50 })}
                      className="text-xs text-[#2596be] hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Target Profit
                    </button>
                  )}

                  {/* Stop Loss Chip */}
                  {leg.leg_sl_pct > 0 ? (
                    <div className="flex items-center gap-1 bg-oncolor border border-red-300 text-red-600 px-1.5 py-0.5 rounded text-xs font-semibold shadow-sm">
                      <span className="text-[10px]">SL:</span>
                      <input
                        type="number"
                        value={leg.leg_sl_pct}
                        onChange={e => handleUpdateLeg(index, { leg_sl_pct: Number(e.target.value) })}
                        className="w-10 bg-slate-50 border border-slate-200 rounded px-1 text-center text-xs text-slate-800"
                      />
                      <span>%</span>
                      <button
                        type="button"
                        onClick={() => handleUpdateLeg(index, { leg_sl_pct: 0 })}
                        className="text-slate-400 hover:text-red-500 ml-0.5 leading-none"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleUpdateLeg(index, { leg_sl_pct: 35 })}
                      className="text-xs text-[#2596be] hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Stop Loss
                    </button>
                  )}

                  {/* Trail Stop Loss Chip */}
                  {(leg.leg_trail_sl_pct ?? 0) > 0 ? (
                    <div className="flex items-center gap-1 bg-oncolor border border-amber-300 text-amber-700 px-1.5 py-0.5 rounded text-xs font-semibold shadow-sm">
                      <span className="text-[10px]">Trail:</span>
                      <input
                        type="number"
                        value={leg.leg_trail_sl_pct}
                        onChange={e => handleUpdateLeg(index, { leg_trail_sl_pct: Number(e.target.value) })}
                        className="w-10 bg-slate-50 border border-slate-200 rounded px-1 text-center text-xs text-slate-800"
                      />
                      <span>%</span>
                      <button
                        type="button"
                        onClick={() => handleUpdateLeg(index, { leg_trail_sl_pct: 0 })}
                        className="text-slate-400 hover:text-red-500 ml-0.5 leading-none"
                      >
                        ✕
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleUpdateLeg(index, { leg_trail_sl_pct: 10 })}
                      className="text-xs text-[#2596be] hover:underline font-semibold flex items-center gap-0.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Trail Stop Loss
                    </button>
                  )}

                  {/* Journey Link — not implemented; a real multi-stage SL/target ladder */}
                  <button
                    type="button"
                    disabled
                    title="Not implemented yet — a multi-stage SL/target ladder per leg"
                    className="text-xs text-slate-400 font-semibold flex items-center gap-0.5 cursor-not-allowed opacity-60"
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
                    className="bg-slate-100 border border-slate-300 rounded px-2 py-0.5 text-xs text-slate-400 font-medium cursor-not-allowed"
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
                    className="text-slate-400 hover:text-slate-600 transition-colors p-1"
                  >
                    <Copy className="w-3.5 h-3.5" />
                  </button>

                  {/* Trash Icon */}
                  <button
                    type="button"
                    onClick={() => handleRemoveLeg(index)}
                    title="Remove leg"
                    className="text-slate-400 hover:text-red-500 transition-colors p-1"
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
        <div className="flex justify-end items-center gap-2 py-1 text-xs text-slate-600">
          <label className="flex items-center gap-2 cursor-not-allowed opacity-50" title="Depends on Re-Entry/Re-Execute and Journey, both not implemented yet">
            <div className="w-7 h-4 bg-slate-300 rounded-full relative p-0.5">
              <div className="w-3 h-3 rounded-full bg-oncolor shadow-sm" />
            </div>
            <span>No ReEntry/ReExecute/Journey After</span>
          </label>
        </div>

        {/* ── Timing & Strategy Controls Section ── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 my-4 pt-2">
          {/* Left Column: Range Breakout & Entry Time */}
          <div className="flex flex-col gap-2">
            <label className="flex items-center gap-1.5 text-xs text-slate-600 cursor-not-allowed opacity-50" title="Not implemented yet — needs opening-range computation + breakout-triggered entry">
              <input type="checkbox" disabled className="w-3.5 h-3.5 rounded" />
              <span>Range Breakout</span>
              <Info className="w-3 h-3 text-slate-400" />
            </label>

            <div className="flex items-center gap-2 text-xs text-slate-600 mt-1">
              <span className="w-20 font-medium">Entry Time:</span>
              <div className="flex items-center gap-1">
                <select
                  value={entryH}
                  onChange={e => setEntryH(e.target.value)}
                  className="bg-oncolor border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 font-medium focus:outline-none"
                >
                  {['9', '10', '11', '12', '13', '14', '15'].map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span>:</span>
                <select
                  value={entryM}
                  onChange={e => setEntryM(e.target.value)}
                  className="bg-oncolor border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 font-medium focus:outline-none"
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
                  className="bg-slate-100 border border-slate-300 rounded px-2 py-1 text-xs text-slate-400 font-medium cursor-not-allowed"
                >
                  {['00', '15', '30', '45'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Strategy Target Profit Link */}
            {strategyTargetActive ? (
              <div className="flex items-center gap-2 mt-2 bg-oncolor border border-blue-200 rounded px-2.5 py-1 text-xs text-slate-700 w-fit shadow-sm">
                <span className="font-semibold text-[#2596be]">Strategy Target:</span>
                <input
                  type="number"
                  min={1}
                  value={profitTargetPct}
                  onChange={e => setProfitTargetPct(Number(e.target.value))}
                  className="w-14 bg-slate-50 border border-slate-300 rounded px-1.5 py-0.5 text-center text-xs text-slate-800 font-semibold"
                />
                <span>%</span>
                <button
                  type="button"
                  onClick={() => { setStrategyTargetActive(false); setProfitTargetPct(0); }}
                  className="text-slate-400 hover:text-red-500 ml-1"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setStrategyTargetActive(true); setProfitTargetPct(50); }}
                className="text-xs text-[#2596be] hover:underline font-semibold flex items-center gap-0.5 mt-2 cursor-pointer w-fit"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Strategy Target Profit
              </button>
            )}
          </div>

          {/* Right Column: Same Day / Next Day & Exit Time */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-4 text-xs text-slate-600" title="Use the INTRADAY / POSITIONAL toggle at the bottom of the page for this instead">
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50">
                <input type="radio" name="exitDay" checked disabled className="w-3.5 h-3.5" />
                <span>Same Day</span>
              </label>
              <label className="flex items-center gap-1 cursor-not-allowed opacity-50">
                <input type="radio" name="exitDay" disabled className="w-3.5 h-3.5" />
                <span>Next Day (BTST/STBT)</span>
              </label>
            </div>

            <div className="flex items-center gap-2 text-xs text-slate-600 mt-1">
              <span className="w-20 font-medium">Exit Time:</span>
              <div className="flex items-center gap-1">
                <select
                  value={exitH}
                  onChange={e => setExitH(e.target.value)}
                  className="bg-oncolor border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 font-medium focus:outline-none"
                >
                  {['9', '10', '11', '12', '13', '14', '15'].map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span>:</span>
                <select
                  value={exitM}
                  onChange={e => setExitM(e.target.value)}
                  className="bg-oncolor border border-slate-300 rounded px-2 py-1 text-xs text-slate-700 font-medium focus:outline-none"
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
                  className="bg-slate-100 border border-slate-300 rounded px-2 py-1 text-xs text-slate-400 font-medium cursor-not-allowed"
                >
                  {['00', '15', '30', '45'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Strategy Stop Loss Link */}
            {strategySlActive ? (
              <div className="flex items-center gap-2 mt-2 bg-oncolor border border-red-200 rounded px-2.5 py-1 text-xs text-slate-700 w-fit shadow-sm">
                <span className="font-semibold text-red-600">Strategy Stop Loss:</span>
                <input
                  type="number"
                  min={1}
                  value={overallSlPct}
                  onChange={e => setOverallSlPct(Number(e.target.value))}
                  className="w-14 bg-slate-50 border border-slate-300 rounded px-1.5 py-0.5 text-center text-xs text-slate-800 font-semibold"
                />
                <span>%</span>
                <button
                  type="button"
                  onClick={() => { setStrategySlActive(false); setOverallSlPct(0); }}
                  className="text-slate-400 hover:text-red-500 ml-1"
                >
                  ✕
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => { setStrategySlActive(true); setOverallSlPct(35); }}
                className="text-xs text-[#2596be] hover:underline font-semibold flex items-center gap-0.5 mt-2 cursor-pointer w-fit"
              >
                <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Strategy Stop Loss
              </button>
            )}
          </div>
        </div>

        {/* Protect The Profits link centered */}
        <div className="flex justify-center my-3">
          {protectProfitsActive ? (
            <div className="flex items-center gap-2 bg-oncolor border border-amber-300 rounded px-3 py-1.5 text-xs text-slate-700 shadow-sm">
              <span className="font-semibold text-amber-700">Protect Profits (Trail SL %):</span>
              <input
                type="number"
                min={1}
                value={trailSlPct}
                onChange={e => setTrailSlPct(Number(e.target.value))}
                className="w-14 bg-slate-50 border border-slate-300 rounded px-1.5 py-0.5 text-center text-xs text-slate-800 font-semibold"
              />
              <span>%</span>
              <button
                type="button"
                onClick={() => { setProtectProfitsActive(false); setTrailSlPct(0); }}
                className="text-slate-400 hover:text-red-500 ml-1"
              >
                ✕
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => { setProtectProfitsActive(true); setTrailSlPct(15); }}
              className="text-xs text-[#2596be] hover:underline font-semibold flex items-center gap-1 cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5 stroke-[2.5]" /> Protect The Profits <Info className="w-3 h-3 text-slate-400" />
            </button>
          )}
        </div>

        {/* ── Data Notice & Change Settings ── */}
        <div className="text-center text-[11px] text-slate-500 leading-relaxed max-w-4xl mx-auto my-3">
          <p>
            Only <strong className="text-slate-700 font-semibold">Nifty</strong> option data is backed by this backtester today — Banknifty/FinNifty/Sensex selections above run against no real data and won&apos;t produce trades. Nifty data is available from <strong className="text-slate-700 font-semibold">Thu Dec 31 2020</strong>.
          </p>
          <p>
            Nifty lot size is fetched live per period from the master contract, not hardcoded (see the Lot Size field under Change Settings).
          </p>

          <div className="flex justify-center items-center gap-3 mt-2.5">
            <button
              type="button"
              onClick={() => setSettingsModalOpen(true)}
              className="border border-[#54b4c7] text-[#54b4c7] hover:bg-[#54b4c7]/10 px-3 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm bg-oncolor"
            >
              <Settings className="w-3.5 h-3.5" /> Change Settings
            </button>
            <button
              type="button"
              onClick={() => { setHistoryModalOpen(true); fetchHistory(); }}
              className="border border-[#54b4c7] bg-[#54b4c7] hover:bg-[#469fb1] text-white px-3.5 py-1 rounded text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shadow-sm"
            >
              <History className="w-3.5 h-3.5" /> Past Backtests
              {historyList.length > 0 && (
                <span className="ml-1 px-1.5 py-0.2 bg-white/25 rounded-full text-[10px] font-bold">
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
      <div className="fixed bottom-0 left-0 right-0 z-40 bg-[#edf2f6]/95 border-t border-slate-300/80 px-4 py-2.5 backdrop-blur-md shadow-lg flex items-center justify-between">
        {/* Left: INTRADAY / POSITIONAL */}
        <div className="flex rounded overflow-hidden border border-slate-300 shadow-sm">
          <button
            type="button"
            onClick={() => setExecutionType('INTRADAY')}
            className={`px-3 py-1.5 text-xs font-bold transition-colors ${
              executionType === 'INTRADAY'
                ? 'bg-[#54b4c7] text-white'
                : 'bg-oncolor text-slate-600 hover:bg-slate-50'
            }`}
          >
            INTRADAY
          </button>
          <button
            type="button"
            onClick={() => setExecutionType('POSITIONAL')}
            className={`px-3 py-1.5 text-xs font-bold transition-colors ${
              executionType === 'POSITIONAL'
                ? 'bg-[#54b4c7] text-white'
                : 'bg-oncolor text-slate-600 hover:bg-slate-50'
            }`}
          >
            POSITIONAL
          </button>
        </div>

        {/* Center: Past Runs, Save Strategy & Share Strategy */}
        <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
          <button
            type="button"
            onClick={() => { setHistoryModalOpen(true); fetchHistory(); }}
            className="border border-slate-300 bg-oncolor hover:bg-slate-50 text-slate-700 font-semibold text-xs px-3 py-1.5 rounded shadow-sm flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <History className="w-3.5 h-3.5 text-[#54b4c7]" /> Past Runs ({historyList.length})
          </button>
          <button
            type="button"
            onClick={handleSaveStrategy}
            className="bg-[#54b4c7] hover:bg-[#469fb1] text-white font-semibold text-xs px-4 py-1.5 rounded shadow-sm flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Save className="w-3.5 h-3.5" /> Save Strategy
          </button>
          <button
            type="button"
            onClick={handleShareStrategy}
            className="bg-[#54b4c7] hover:bg-[#469fb1] text-white font-semibold text-xs px-4 py-1.5 rounded shadow-sm flex items-center gap-1.5 transition-colors cursor-pointer"
          >
            <Share2 className="w-3.5 h-3.5" /> Share Strategy
          </button>
        </div>

        {/* Right: START BACKTEST */}
        <div>
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
              className="bg-[#8ec341] hover:bg-[#7eb034] text-white font-bold text-xs uppercase px-7 py-2 rounded shadow-md tracking-wider cursor-pointer transition-all hover:scale-[1.02] active:scale-[0.98]"
            >
              START BACKTEST
            </button>
          )}
        </div>
      </div>

      {/* ── Settings Modal ── */}
      {settingsModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 backdrop-blur-xs p-4">
          <div className="bg-oncolor rounded-xl shadow-2xl border border-slate-200 max-w-lg w-full p-5 text-slate-700 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-4">
              <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                <Settings className="w-4 h-4 text-[#54b4c7]" /> Strategy &amp; Simulation Settings
              </h2>
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="text-slate-400 hover:text-slate-600 p-1"
              >
                ✕
              </button>
            </div>

            <div className="flex flex-col gap-4 text-xs">
              {/* Preset Strategies Quick Loader */}
              <div>
                <label className="block font-semibold text-slate-600 mb-1">Quick Strategy Presets</label>
                <select
                  onChange={e => {
                    applyPreset(e.target.value);
                    setSettingsModalOpen(false);
                  }}
                  defaultValue=""
                  className="w-full bg-slate-50 border border-slate-300 rounded p-2 text-xs"
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
                <label className="block font-semibold text-slate-600 mb-1">Lot Size</label>
                <input
                  type="number"
                  min={1}
                  value={lotSize}
                  onChange={e => setLotSize(Number(e.target.value))}
                  className="w-full border border-slate-300 rounded p-1.5 text-xs"
                />
              </div>

              {/* Costs & Slippage */}
              <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
                <label className="flex items-center gap-2 cursor-pointer mb-2 font-semibold">
                  <input
                    type="checkbox"
                    checked={includeCosts}
                    onChange={e => setIncludeCosts(e.target.checked)}
                    className="accent-[#54b4c7] rounded"
                  />
                  <span>Include Costs &amp; Slippage</span>
                </label>
                {includeCosts && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <span className="block text-[11px] text-slate-500 mb-1">Commission / Lot (₹)</span>
                      <input
                        type="number"
                        min={0}
                        value={commissionPerLot}
                        onChange={e => setCommissionPerLot(Number(e.target.value))}
                        className="w-full bg-oncolor border border-slate-300 rounded p-1.5 text-xs"
                      />
                    </div>
                    <div>
                      <span className="block text-[11px] text-slate-500 mb-1">Slippage %</span>
                      <input
                        type="number"
                        min={0}
                        step={0.05}
                        value={slippagePct}
                        onChange={e => setSlippagePct(Number(e.target.value))}
                        className="w-full bg-oncolor border border-slate-300 rounded p-1.5 text-xs"
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Rolling straddle mode */}
              <div className="border border-slate-200 rounded-lg p-3 bg-slate-50/50">
                <span className="block font-semibold mb-2">Dynamic Roll Adjustment</span>
                <div className="flex gap-4 mb-2">
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="adjMode"
                      checked={adjustmentMode === 'none'}
                      onChange={() => setAdjustmentMode('none')}
                      className="accent-[#54b4c7]"
                    />
                    <span>Static Hold</span>
                  </label>
                  <label className="flex items-center gap-1.5 cursor-pointer">
                    <input
                      type="radio"
                      name="adjMode"
                      checked={adjustmentMode === 'rolling_straddle'}
                      onChange={() => setAdjustmentMode('rolling_straddle')}
                      className="accent-[#54b4c7]"
                    />
                    <span>ATM Roll (Rolling Straddle)</span>
                  </label>
                </div>
                {adjustmentMode === 'rolling_straddle' && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div>
                      <span className="block text-[11px] text-slate-500 mb-1">Roll Buffer</span>
                      <input
                        type="number"
                        value={rollBuffer}
                        onChange={e => setRollBuffer(Number(e.target.value))}
                        className="w-full bg-oncolor border border-slate-300 rounded p-1.5 text-xs"
                      />
                    </div>
                    <div>
                      <span className="block text-[11px] text-slate-500 mb-1">Max Rolls / Day</span>
                      <input
                        type="number"
                        value={maxRolls}
                        onChange={e => setMaxRolls(Number(e.target.value))}
                        className="w-full bg-oncolor border border-slate-300 rounded p-1.5 text-xs"
                      />
                    </div>
                  </div>
                )}
              </div>
            </div>

            <div className="mt-5 pt-3 border-t border-slate-200 flex justify-end">
              <button
                type="button"
                onClick={() => setSettingsModalOpen(false)}
                className="bg-[#54b4c7] hover:bg-[#459eb0] text-white px-4 py-1.5 rounded text-xs font-semibold"
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
          <div className="bg-oncolor rounded-2xl shadow-2xl border border-slate-200 p-6 max-w-md w-full text-center">
            <div className="w-12 h-12 rounded-full bg-[#54b4c7]/15 flex items-center justify-center mx-auto mb-4 animate-spin text-[#54b4c7]">
              <RefreshCw className="w-6 h-6" />
            </div>
            <h3 className="text-sm font-bold text-slate-800 mb-1">Simulating Historical Option Trades</h3>
            <p className="text-xs text-slate-500 mb-4">
              Analyzing 1-min OHLC, underlying spot &amp; strikes across historical cycles…
            </p>

            {/* Progress bar */}
            <div className="w-full bg-slate-100 rounded-full h-3.5 overflow-hidden p-0.5 border border-slate-200 mb-2">
              <div
                className="bg-[#54b4c7] h-full rounded-full transition-all duration-300"
                style={{ width: `${Math.max(3, statusData?.percent ?? 0)}%` }}
              />
            </div>

            <div className="flex justify-between text-xs font-medium text-slate-500 mb-4">
              <span>{statusData?.percent?.toFixed(1) ?? '0.0'}% completed</span>
              <span>{statusData?.current ?? 0} / {statusData?.total || '—'} days</span>
            </div>

            {statusData?.date && (
              <div className="bg-slate-50 border border-slate-200 rounded px-3 py-1.5 text-xs text-slate-600 mb-4 flex justify-between font-mono">
                <span>Processing Date:</span>
                <span className="font-bold text-slate-800">{statusData.date}</span>
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
        <div ref={resultsRef} className="w-full max-w-[1550px] mx-auto px-4 mt-8 pt-6 border-t border-slate-300">
          {/* Loaded from History Banner */}
          {loadedFromHistory && (
            <div className="mb-4 bg-teal-50 border border-teal-200 text-teal-900 rounded-xl p-3.5 flex items-center justify-between shadow-xs flex-wrap gap-2">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-lg bg-[#54b4c7]/20 flex items-center justify-center text-[#54b4c7]">
                  <History className="w-4 h-4" />
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-800 flex items-center gap-2">
                    <span>Viewing Archived Backtest:</span>
                    <span className="text-[#2596be]">{loadedFromHistory.name}</span>
                  </div>
                  <div className="text-[11px] text-slate-500 font-mono">
                    ID: {loadedFromHistory.id} &bull; Period: {loadedFromHistory.start_date || '—'} &rarr; {loadedFromHistory.end_date || '—'} &bull; {loadedFromHistory.trades} cycles
                  </div>
                </div>
              </div>
              <div className="flex items-center gap-2">
                {loadedFromHistory.has_report && (
                  <button
                    type="button"
                    onClick={() => setViewingReportId(loadedFromHistory.id)}
                    className="border border-emerald-500 text-emerald-700 bg-white hover:bg-emerald-50 px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-xs"
                  >
                    <FileText className="w-3.5 h-3.5 text-emerald-600" /> Research Report
                  </button>
                )}
                {loadedFromHistory.has_tearsheet && (
                  <button
                    type="button"
                    onClick={() => setViewingTearsheetId(loadedFromHistory.id)}
                    className="border border-[#54b4c7] text-[#54b4c7] bg-white hover:bg-teal-50 px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-xs"
                  >
                    <FileText className="w-3.5 h-3.5" /> Tearsheet
                  </button>
                )}
                {loadedFromHistory.has_trades_csv && (
                  <a
                    href={`/api/backtest/history?id=${encodeURIComponent(loadedFromHistory.id)}&file=csv`}
                    download
                    className="border border-slate-300 text-slate-700 bg-white hover:bg-slate-50 px-2.5 py-1 rounded text-xs font-semibold flex items-center gap-1 transition-colors cursor-pointer shadow-xs"
                  >
                    <Download className="w-3.5 h-3.5" /> CSV
                  </a>
                )}
                <button
                  type="button"
                  onClick={() => setLoadedFromHistory(null)}
                  className="text-slate-400 hover:text-slate-600 px-1 text-xs"
                  title="Dismiss banner"
                >
                  ✕
                </button>
              </div>
            </div>
          )}
          <div className="flex items-center justify-between mb-4 flex-wrap gap-2">
            <div>
              <span className="text-[10px] font-bold text-[#54b4c7] uppercase tracking-wider block">Simulation Complete</span>
              <h2 className="text-lg font-bold text-slate-800">Backtest Performance Report</h2>
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
              <div className="text-xs font-mono text-slate-500 bg-oncolor border border-slate-300 rounded px-3 py-1">
                {s.traded_cycles} Trades ({startDate} &rarr; {endDate})
              </div>
            </div>
          </div>

          {/* Headline KPIs */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mb-6">
            <div className="bg-oncolor border border-slate-200 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Overall Profit</span>
              <span className={`text-xl font-bold font-mono ${s.total_pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {fmtPnl(s.total_pnl)}
              </span>
            </div>

            <div className="bg-oncolor border border-slate-200 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Win Rate</span>
              <span className={`text-xl font-bold font-mono ${s.win_rate >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                {s.win_rate.toFixed(1)}%
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">{s.wins}W / {s.losses}L</span>
            </div>

            <div className="bg-oncolor border border-slate-200 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Max Drawdown</span>
              <span className="text-xl font-bold font-mono text-amber-600">
                ₹{fmt(s.max_drawdown)}
              </span>
              {s.max_drawdown_days != null && (
                <span className="text-[10px] text-slate-500 block mt-0.5">{s.max_drawdown_days} days</span>
              )}
            </div>

            <div className="bg-oncolor border border-slate-200 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Traded Cycles</span>
              <span className="text-xl font-bold font-mono text-slate-800">
                {s.traded_cycles}
              </span>
              <span className="text-[10px] text-slate-500 block mt-0.5">of {s.total_cycles} evaluated</span>
            </div>

            <div className="bg-oncolor border border-slate-200 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Return / Max DD</span>
              <span className="text-xl font-bold font-mono text-slate-800">
                {s.return_maxdd_ratio != null ? s.return_maxdd_ratio.toFixed(2) : '—'}
              </span>
            </div>

            <div className="bg-oncolor border border-slate-200 rounded-xl p-3 shadow-xs">
              <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Reward : Risk</span>
              <span className="text-xl font-bold font-mono text-slate-800">
                {s.reward_risk_ratio != null ? s.reward_risk_ratio.toFixed(2) : '—'}
              </span>
            </div>
          </div>

          {/* Detailed Statistics Matrix */}
          <div className="bg-oncolor border border-slate-200 rounded-xl p-4 shadow-xs mb-6">
            <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-3">Detailed Statistics</h3>
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 text-xs">
              <div>
                <span className="text-slate-400 block mb-0.5">Avg Profit / Trade</span>
                <span className={`font-mono font-bold ${s.avg_pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {fmtPnl(s.avg_pnl)}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Avg Winning Trade</span>
                <span className="font-mono font-bold text-emerald-600">{fmtPnl(s.avg_win)}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Avg Losing Trade</span>
                <span className="font-mono font-bold text-red-600">-₹{fmt(s.avg_loss)}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Max Single Profit</span>
                <span className="font-mono font-bold text-emerald-600">{fmtPnl(s.max_win)}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Max Single Loss</span>
                <span className="font-mono font-bold text-red-600">{fmtPnl(s.max_loss)}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Commission Paid</span>
                <span className="font-mono font-bold text-slate-700">₹{fmt(s.commission_paid)}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Max Win Streak</span>
                <span className="font-mono font-bold text-emerald-600">{s.max_win_streak}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Max Loss Streak</span>
                <span className="font-mono font-bold text-red-600">{s.max_loss_streak}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Max Trades in DD</span>
                <span className="font-mono font-bold text-amber-600">{s.max_trades_in_drawdown}</span>
              </div>
              <div>
                <span className="text-slate-400 block mb-0.5">Expectancy Ratio</span>
                <span className="font-mono font-bold text-slate-700">{s.expectancy_ratio != null ? s.expectancy_ratio.toFixed(2) : '—'}</span>
              </div>
            </div>
          </div>

          {/* Year-wise Returns Matrix */}
          {Object.keys(result.monthly_pnl).length > 0 && (
            <div className="bg-oncolor border border-slate-200 rounded-xl overflow-hidden shadow-xs mb-6">
              <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
                <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">Year-wise &amp; Month-wise Returns</h3>
              </div>
              <div className="overflow-x-auto">
                <table className="text-xs whitespace-nowrap w-full">
                  <thead>
                    <tr className="bg-slate-100 text-slate-600 border-b border-slate-200">
                      <th className="font-bold text-left px-3 py-2">Year</th>
                      {MONTHS.map(m => (
                        <th key={m} className="font-bold text-right px-2 py-2">{m}</th>
                      ))}
                      <th className="font-bold text-right px-3 py-2 border-l border-slate-200">Total</th>
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
                        <tr key={yr} className={`border-t border-slate-200 ${i % 2 === 0 ? 'bg-oncolor' : 'bg-slate-50/50'}`}>
                          <td className="px-3 py-2 font-bold text-slate-800">{yr}</td>
                          {MONTHS.map(m => {
                            const v = yData[m];
                            const isPositive = v != null && v > 0;
                            const isNegative = v != null && v < 0;
                            return (
                              <td
                                key={m}
                                className={`px-2 py-2 text-right font-mono ${
                                  isPositive ? 'text-emerald-600 font-medium' : isNegative ? 'text-red-600 font-medium' : 'text-slate-400'
                                }`}
                              >
                                {v != null && v !== 0 ? (v > 0 ? '+' : '') + Math.round(v).toLocaleString('en-IN') : '—'}
                              </td>
                            );
                          })}
                          <td className={`px-3 py-2 text-right font-mono font-bold border-l border-slate-200 ${total >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {total !== 0 ? (total > 0 ? '+' : '') + Math.round(total).toLocaleString('en-IN') : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-amber-600 font-medium">
                            {mdd > 0 ? `₹${mdd.toLocaleString('en-IN')}` : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-500">
                            {days != null ? days : '—'}
                          </td>
                          <td className="px-3 py-2 text-right font-mono text-slate-700">
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
            <div className="bg-oncolor border border-slate-200 rounded-xl p-4 shadow-xs mb-6">
              <div className="flex items-center justify-between flex-wrap gap-2 mb-3">
                <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                  VectorBT Stats <span className="text-slate-400 font-normal normal-case">(same trades, computed by vbt.Portfolio)</span>
                </h3>
                {result.vbt.tearsheet_available && (
                  <a href="/api/backtest-vectorbt/report" target="_blank" rel="noopener noreferrer"
                     className="text-[11px] font-bold text-[#54b4c7] hover:underline">
                    Open OpenStatz Tearsheet →
                  </a>
                )}
              </div>

              {result.vbt.comparison && result.vbt.comparison.length > 0 && (
                <div className="overflow-x-auto mb-4">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="bg-slate-100 text-slate-600 border-b border-slate-200">
                        {Object.keys(result.vbt.comparison[0]).map(col => (
                          <th key={col} className="text-left font-bold px-3 py-1.5">{col}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {result.vbt.comparison.map((row, i) => (
                        <tr key={i} className="border-b border-slate-100 last:border-0">
                          {Object.entries(row).map(([col, val]) => (
                            <td key={col} className="px-3 py-1.5 font-mono text-slate-700">{String(val)}</td>
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
                    <div key={key} className="flex justify-between border-b border-slate-100 py-1">
                      <span className="text-slate-400">{key.replace(' [%]', '')}</span>
                      <span className="text-slate-700 font-mono font-medium">{formatVbtStat(key, val)}</span>
                    </div>
                  ))}
                </div>
              )}

              {result.vbt.monte_carlo_summary && (
                <p className="text-[11px] text-slate-500 mt-3">{result.vbt.monte_carlo_summary}</p>
              )}
            </div>
          )}
          {result.vbt?.error && (
            <div className="bg-amber-50 border border-amber-300 rounded-xl p-3 mb-6 text-[11px] text-amber-700">
              VectorBT stats could not be computed: {result.vbt.error}
            </div>
          )}

          {/* Equity Curve & Underwater Charts */}
          <div className="bg-oncolor border border-slate-200 rounded-xl p-4 shadow-xs mb-6">
            <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-4">Cumulative Equity &amp; Drawdown Curve</h3>
            <BacktestCharts equityCurve={result.equity_curve} />
          </div>

          {/* Full Trade Log Table */}
          <div className="bg-oncolor border border-slate-200 rounded-xl overflow-hidden shadow-xs mb-8">
            <div className="px-4 py-3 border-b border-slate-200 bg-slate-50 flex items-center justify-between">
              <h3 className="text-xs font-bold text-slate-700 uppercase tracking-wider">
                Full Execution Trade Log ({result.cycles.filter(c => c.exit_reason !== 'NO_ENTRY').length} cycles)
              </h3>
            </div>
            <div className="overflow-x-auto">
              <table className="text-xs whitespace-nowrap w-full">
                <thead>
                  <tr className="bg-slate-100 text-slate-600 border-b border-slate-200">
                    <th className="font-bold text-left px-3 py-2">#</th>
                    <th className="font-bold text-left px-3 py-2">Entry Date</th>
                    <th className="font-bold text-right px-2 py-2">Time</th>
                    <th className="font-bold text-left px-3 py-2 border-l border-slate-200">Exit Date</th>
                    <th className="font-bold text-right px-2 py-2">Time</th>
                    <th className="font-bold text-center px-2 py-2 border-l border-slate-200">Type</th>
                    <th className="font-bold text-right px-2 py-2">Spot</th>
                    <th className="font-bold text-right px-3 py-2 border-l border-slate-200">Entry ₹</th>
                    <th className="font-bold text-right px-3 py-2">Exit ₹</th>
                    <th className="font-bold text-right px-3 py-2 border-l border-slate-200">P/L</th>
                    <th className="font-bold text-center px-2 py-2">Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {result.cycles.filter(c => c.exit_reason !== 'NO_ENTRY').slice(0, 100).map((c, idx) => (
                    <tr key={idx} className={`border-t border-slate-200 ${idx % 2 === 0 ? 'bg-oncolor' : 'bg-slate-50/50'}`}>
                      <td className="px-3 py-2 text-slate-500 font-bold">{idx + 1}</td>
                      <td className="px-3 py-2 text-slate-700 font-mono">{fmtDate(c.entry_dt)}</td>
                      <td className="px-2 py-2 text-right text-slate-500 font-mono">{fmtTime(c.entry_dt)}</td>
                      <td className="px-3 py-2 text-slate-700 font-mono border-l border-slate-200">{fmtDate(c.exit_dt)}</td>
                      <td className="px-2 py-2 text-right text-slate-500 font-mono">{fmtTime(c.exit_dt)}</td>
                      <td className="px-2 py-2 text-center border-l border-slate-200 font-medium">{cycleTypeLabel(c.legs)}</td>
                      <td className="px-2 py-2 text-right font-mono text-slate-600">
                        {c.entry_spot != null ? Math.round(c.entry_spot).toLocaleString('en-IN') : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700 border-l border-slate-200">
                        {c.net_credit != null ? c.net_credit.toFixed(2) : '—'}
                      </td>
                      <td className="px-3 py-2 text-right font-mono text-slate-700">
                        {c.exit_combined != null ? Math.abs(c.exit_combined).toFixed(2) : '—'}
                      </td>
                      <td className={`px-3 py-2 text-right font-mono font-bold border-l border-slate-200 ${c.pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {fmtPnl(c.pnl)}
                      </td>
                      <td className="px-2 py-2 text-center">
                        <span className={`inline-block px-2 py-0.5 rounded text-[10px] font-bold ${EXIT_REASON_CLS[c.exit_reason] ?? 'bg-slate-100 text-slate-600'}`}>
                          {c.exit_reason}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

        </div>
      )}

      {/* ── Past Backtests History Modal ── */}
      {historyModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/70 backdrop-blur-xs p-4">
          <div className="bg-oncolor rounded-2xl shadow-2xl border border-slate-200 max-w-4xl w-full p-5 text-slate-700 max-h-[88vh] flex flex-col">
            {/* Header */}
            <div className="flex items-center justify-between border-b border-slate-200 pb-3 mb-3">
              <div>
                <h2 className="text-sm font-bold text-slate-800 flex items-center gap-2">
                  <History className="w-4 h-4 text-[#54b4c7]" /> Past Options Backtests
                </h2>
                <p className="text-[11px] text-slate-400 mt-0.5">
                  Archived simulations stored under <code className="bg-slate-100 px-1 py-0.5 rounded text-[10px] font-mono text-slate-600">debug/backtests/options/</code>
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={fetchHistory}
                  title="Refresh backtest list"
                  className="p-1.5 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <RefreshCw className={`w-3.5 h-3.5 ${loadingHistory ? 'animate-spin text-[#54b4c7]' : ''}`} />
                </button>
                <button
                  type="button"
                  onClick={() => setHistoryModalOpen(false)}
                  className="text-slate-400 hover:text-slate-600 p-1 rounded hover:bg-slate-100 transition-colors cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Search Input */}
            <div className="relative mb-3">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="text"
                placeholder="Search backtests by strategy name, date, tag (e.g. straddle, iron condor, 2026)..."
                value={historySearch}
                onChange={e => setHistorySearch(e.target.value)}
                className="w-full bg-slate-50 border border-slate-200 rounded-lg pl-8 pr-8 py-1.5 text-xs text-slate-700 focus:outline-none focus:border-[#54b4c7] focus:bg-white transition-colors"
              />
              {historySearch && (
                <button
                  type="button"
                  onClick={() => setHistorySearch('')}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600 text-xs cursor-pointer"
                >
                  ✕
                </button>
              )}
            </div>

            {/* Backtest Cards List */}
            <div className="overflow-y-auto flex-1 pr-1 space-y-3">
              {loadingHistory && historyList.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400">
                  <RefreshCw className="w-6 h-6 animate-spin mx-auto mb-2 text-[#54b4c7]" />
                  Loading archived backtests…
                </div>
              ) : filteredHistory.length === 0 ? (
                <div className="py-12 text-center text-xs text-slate-400 bg-slate-50 rounded-xl border border-dashed border-slate-200">
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
                      className="border border-slate-200 rounded-xl p-3.5 bg-oncolor hover:border-[#54b4c7]/60 hover:shadow-xs transition-all text-xs"
                    >
                      <div className="flex items-start justify-between gap-3 mb-2">
                        <div>
                          <div className="font-bold text-slate-800 text-sm flex items-center gap-2 flex-wrap">
                            <span>{item.name}</span>
                            {item.strategy_type && (
                              <span className="text-[9px] uppercase px-1.5 py-0.5 bg-slate-100 text-slate-600 rounded font-semibold tracking-wider">
                                {item.strategy_type}
                              </span>
                            )}
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5 font-mono">
                            {item.start_date || '—'} &rarr; {item.end_date || '—'} &bull; Run: {item.timestamp ? new Date(item.timestamp).toLocaleString('en-IN') : item.id}
                          </div>
                        </div>

                        {/* P&L Pill */}
                        <div className="text-right shrink-0">
                          <span className={`text-sm font-bold font-mono ${isProfit ? 'text-emerald-600' : 'text-red-600'}`}>
                            {fmtPnl(pnl)}
                          </span>
                          <span className="block text-[10px] text-slate-400">Total P&amp;L</span>
                        </div>
                      </div>

                      {/* Metrics strip */}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 bg-slate-50/70 border border-slate-100 rounded-lg p-2 mb-3 font-mono text-[11px]">
                        <div>
                          <span className="text-[9px] text-slate-400 font-sans block">Win Rate</span>
                          <span className={`font-semibold ${winRate >= 50 ? 'text-emerald-600' : 'text-red-600'}`}>
                            {winRate.toFixed(1)}%
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-slate-400 font-sans block">Max Drawdown</span>
                          <span className="font-semibold text-amber-600">
                            ₹{fmt(item.max_drawdown ?? 0)}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-slate-400 font-sans block">Total Cycles</span>
                          <span className="font-semibold text-slate-700">
                            {item.trades ?? '—'}
                          </span>
                        </div>
                        <div>
                          <span className="text-[9px] text-slate-400 font-sans block">Folder</span>
                          <span className="text-[10px] text-slate-500 truncate block" title={item.id}>
                            {item.id}
                          </span>
                        </div>
                      </div>

                      {/* Tags & Action Buttons */}
                      <div className="flex items-center justify-between flex-wrap gap-2 pt-1 border-t border-slate-100">
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {item.tags?.map(t => (
                            <span key={t} className="text-[10px] bg-slate-100 text-slate-500 px-1.5 py-0.5 rounded">
                              #{t}
                            </span>
                          ))}
                        </div>

                        <div className="flex items-center gap-2 ml-auto">
                          {item.has_report && (
                            <button
                              type="button"
                              onClick={() => setViewingReportId(item.id)}
                              className="border border-emerald-500 text-emerald-700 hover:bg-emerald-50 px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors bg-white shadow-xs"
                            >
                              <FileText className="w-3 h-3 text-emerald-600" /> Research Report
                            </button>
                          )}
                          {item.has_tearsheet && (
                            <button
                              type="button"
                              onClick={() => setViewingTearsheetId(item.id)}
                              className="border border-[#54b4c7] text-[#54b4c7] hover:bg-[#54b4c7]/10 px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors bg-white"
                            >
                              <FileText className="w-3 h-3" /> Tearsheet
                            </button>
                          )}
                          {item.has_trades_csv && (
                            <a
                              href={`/api/backtest/history?id=${encodeURIComponent(item.id)}&file=csv`}
                              download
                              className="border border-slate-200 text-slate-600 hover:bg-slate-100 px-2.5 py-1 rounded text-[11px] font-semibold flex items-center gap-1 cursor-pointer transition-colors bg-white"
                            >
                              <Download className="w-3 h-3" /> CSV
                            </a>
                          )}
                          <button
                            type="button"
                            onClick={() => handleLoadHistoryItem(item.id)}
                            className="bg-[#54b4c7] hover:bg-[#469fb1] text-white px-3 py-1 rounded text-[11px] font-bold shadow-xs cursor-pointer transition-colors flex items-center gap-1"
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
            <div className="mt-3 pt-3 border-t border-slate-200 flex justify-between items-center text-[11px] text-slate-400">
              <span>{historyList.length} backtest{historyList.length === 1 ? '' : 's'} archived in debug/backtests/options/</span>
              <button
                type="button"
                onClick={() => setHistoryModalOpen(false)}
                className="text-slate-600 hover:text-slate-800 font-semibold px-3 py-1 rounded hover:bg-slate-100 cursor-pointer"
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
          <div className="bg-oncolor rounded-2xl shadow-2xl border border-slate-200 max-w-6xl w-full h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-[#54b4c7]" />
                <span className="font-bold text-slate-800 text-xs sm:text-sm">
                  Interactive Tearsheet: {viewingTearsheetId}
                </span>
              </div>
              <div className="flex items-center gap-3 text-xs">
                <a
                  href={`/api/backtest/history?id=${encodeURIComponent(viewingTearsheetId)}&file=tearsheet`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[#2596be] hover:underline font-semibold flex items-center gap-1"
                >
                  <ExternalLink className="w-3.5 h-3.5" /> Open in New Tab
                </a>
                <button
                  type="button"
                  onClick={() => setViewingTearsheetId(null)}
                  className="text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 bg-white">
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
          <div className="bg-oncolor rounded-2xl shadow-2xl border border-slate-200 max-w-6xl w-full h-[92vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-200 bg-slate-50">
              <div className="flex items-center gap-2">
                <FileText className="w-4 h-4 text-emerald-600" />
                <span className="font-bold text-slate-800 text-xs sm:text-sm">
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
                  className="text-slate-400 hover:text-slate-600 p-1 cursor-pointer"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="flex-1 bg-[#0b0f19]">
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
