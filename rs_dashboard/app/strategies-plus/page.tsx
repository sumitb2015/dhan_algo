'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Layers, RefreshCw, AlertTriangle, Power, ShieldOff, LayoutList, ChevronDown, ChevronRight,
  Shield, Repeat, CheckCircle2, XCircle, Play, Square, ChevronsDownUp, ChevronsUpDown,
  Sprout, Flame, Rocket, Boxes, Moon, Clock, Calendar, Mountain, Activity, TrendingUp,
  Search, X,
} from 'lucide-react';
import DeskFigure, { deskTone } from '@/components/DeskFigure';
import StrategyRowWide from '@/components/StrategyRowWide';
import NavBar from '@/components/NavBar';
import BrokerSelector from '@/components/BrokerSelector';
import { usePortfolio } from '@/lib/usePortfolio';
import { useBrokerSelector } from '@/hooks/useBrokerSelector';
import { useGroupCollapse, groupByUnderlying, signedInr, inr } from '@/lib/useStrategyGroups';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

type GroupMode = 'timeframe' | 'underlying' | 'type';
type HorizonFilter = 'all' | 'intraday' | 'positional';

/** Client-side mirror of lib/strategyRegistry.ts's LOGIC_GROUPS */
const LOGIC_GROUPS: Record<string, { title: string; tagline: string; icon: React.ElementType; accent: string }> = {
  harvest: { title: 'Premium Harvest', tagline: 'Sell & hold — theta does the work', icon: Sprout, accent: 'emerald' },
  rotation: { title: 'Roll & Rotate', tagline: 'Exit a decaying leg into a fresh strike', icon: Repeat, accent: 'sky' },
  volatility: { title: 'Volatility Adaptive', tagline: 'Entry and hedge gated by the vol regime', icon: Activity, accent: 'violet' },
  directional: { title: 'Directional Options', tagline: 'Trend + OI-confirmed spreads and sells', icon: TrendingUp, accent: 'amber' },
  futures_trend: { title: 'Futures Trend', tagline: 'Ride MCX momentum in one direction', icon: Flame, accent: 'orange' },
  momentum: { title: 'Equity Momentum', tagline: 'Relative-strength stock rotation', icon: Rocket, accent: 'fuchsia' },
  overnight_hedge: { title: 'Overnight Hedge', tagline: 'Hedged straddle held past the close', icon: Moon, accent: 'cyan' },
  calendar_hedge: { title: 'Calendar & Butterfly', tagline: 'Defined-risk butterfly + calendar combo, held to monthly expiry', icon: Mountain, accent: 'rose' },
};
const OTHER_LOGIC_GROUP = { title: 'Other', tagline: 'Uncategorised', icon: Boxes, accent: 'zinc' };

/** Time Horizon definitions for grouping */
const TIMEFRAME_GROUPS: Record<string, { title: string; tagline: string; icon: React.ElementType; accent: string; badge: string }> = {
  intraday: {
    title: 'Intraday Strategies',
    tagline: 'F&O & MCX futures with mandatory intraday square-off (15:17 IST / 23:25 MCX)',
    icon: Clock,
    accent: 'amber',
    badge: 'Intraday',
  },
  positional: {
    title: 'Positional & Multi-Day',
    tagline: 'Multi-day CNC momentum portfolio, overnight hedged straddles, and weekly delta management',
    icon: Calendar,
    accent: 'violet',
    badge: 'Positional',
  },
};
const OTHER_TIMEFRAME_GROUP = {
  title: 'Other Strategies',
  tagline: 'Flexible holding horizon',
  icon: Boxes,
  accent: 'zinc',
  badge: 'OTHER',
};

interface IndexQuote { ltp: number; prevClose: number }
interface IndexTicker { nifty: IndexQuote | null; vix: IndexQuote | null }

type ToastType = 'success' | 'error' | 'info';
interface Toast { id: number; type: ToastType; message: string }

interface PnlGuardStatus {
  pnlExitStatus: 'ACTIVE' | 'INACTIVE' | string;
  profit?: number;
  loss?: number;
  productType?: string[];
  enableKillSwitch?: boolean;
}

const CHILD_BROKERS = ['zerodha', 'kotak'] as const;
type ChildBroker = typeof CHILD_BROKERS[number];
const CHILD_BROKER_LABELS: Record<ChildBroker, string> = { zerodha: 'Zerodha', kotak: 'Kotak' };

interface CopyTradeChild {
  broker: ChildBroker;
  multiplier: number;
  enabled: boolean;
}
interface CopyTradeConfig {
  armed: boolean;
  children: CopyTradeChild[];
}
interface CopyTradeStatus {
  status: 'RUNNING' | 'STARTING' | 'STOPPED' | 'ERROR' | string;
  pid?: number;
  detail?: string;
  started_at?: string;
  last_update?: string;
  broker_failures?: Record<string, string>;
}
interface CopyTradeLogEntry {
  ts: string;
  order_no: string;
  parent_symbol?: string;
  child_symbol?: string;
  zerodha_symbol?: string;
  side?: string;
  parent_qty?: number;
  broker?: string;
  multiplier?: number;
  child_qty?: number;
  armed?: boolean;
  result: 'success' | 'error' | 'skipped' | 'logged_only' | 'safety_exit' | 'safety_exit_error' | string;
  error?: string;
  child_order_id?: string;
}

const DEFAULT_COPY_TRADE_CHILDREN: CopyTradeChild[] =
  CHILD_BROKERS.map(broker => ({ broker, multiplier: 1, enabled: false }));

function withAllBrokers(children: CopyTradeChild[]): CopyTradeChild[] {
  return CHILD_BROKERS.map(broker =>
    children.find(c => c.broker === broker) ?? { broker, multiplier: 1, enabled: false });
}

let toastCounter = 0;

export default function StrategiesPlusPage() {
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  const [strategies, setStrategies] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { portfolio, loading: portfolioLoading, refresh: fetchPortfolio } = usePortfolio();
  const [indexTicker, setIndexTicker] = useState<IndexTicker | null>(null);

  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);

  const [confirmExitAll, setConfirmExitAll] = useState(false);
  const [exitingAll, setExitingAll] = useState(false);

  const [viewMode, setViewMode] = useState<'active' | 'all'>('active');
  const [groupMode, setGroupMode] = useState<GroupMode>('timeframe');
  const [horizonFilter, setHorizonFilter] = useState<HorizonFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');

  const groups = useGroupCollapse();

  const [pendingInstances, setPendingInstances] = useState<Record<string, string[]>>({});

  useEffect(() => {
    setPendingInstances(prev => {
      let changed = false;
      const next: Record<string, string[]> = {};
      for (const [key, ids] of Object.entries(prev)) {
        const known = new Set(Object.keys(strategies[key]?.instances || {}));
        const remaining = ids.filter(id => !known.has(id));
        if (remaining.length !== ids.length) changed = true;
        if (remaining.length) next[key] = remaining;
      }
      return changed ? next : prev;
    });
  }, [strategies]);

  const strategiesRef = useRef(strategies);
  strategiesRef.current = strategies;

  const addInstance = useCallback((key: string) => {
    setPendingInstances(prev => {
      const existingIds = new Set([
        ...Object.keys(strategiesRef.current[key]?.instances || {}),
        ...(prev[key] || []),
      ]);
      let n = 2;
      while (existingIds.has(String(n))) n++;
      return { ...prev, [key]: [...(prev[key] || []), String(n)] };
    });
    setViewMode('all');
  }, []);

  const [toasts, setToasts] = useState<Toast[]>([]);

  const [showPnlGuard, setShowPnlGuard] = useState(false);
  const [pnlGuardStatus, setPnlGuardStatus] = useState<PnlGuardStatus | null>(null);
  const [pnlGuardLoading, setPnlGuardLoading] = useState(false);
  const [profitValue, setProfitValue] = useState('');
  const [lossValue, setLossValue] = useState('');
  const [productTypes, setProductTypes] = useState<string[]>(['INTRADAY']);
  const [enableKillSwitch, setEnableKillSwitch] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [settingPnl, setSettingPnl] = useState(false);
  const [clearingPnl, setClearingPnl] = useState(false);

  const [showCopyTrade, setShowCopyTrade] = useState(false);
  const [copyTradeConfig, setCopyTradeConfig] = useState<CopyTradeConfig>({ armed: false, children: DEFAULT_COPY_TRADE_CHILDREN });
  const [copyTradeStatus, setCopyTradeStatus] = useState<CopyTradeStatus | null>(null);
  const [copyTradeLog, setCopyTradeLog] = useState<CopyTradeLogEntry[]>([]);
  const [confirmArm, setConfirmArm] = useState(false);
  const [arming, setArming] = useState(false);
  const [togglingBridge, setTogglingBridge] = useState(false);

  const addToast = (type: ToastType, message: string) => {
    const id = ++toastCounter;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), 5000);
  };

  const fetchStrategies = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const res = await fetch('/api/strategies');
      const data = await res.json();
      if (data.success) { setStrategies(data.strategies); setError(null); }
      else setError(data.error || 'Failed to retrieve strategies state');
    } catch {
      setError('Network error. Failed to communicate with local API.');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  const removeInstance = useCallback(async (key: string, instanceId: string) => {
    setPendingInstances(prev => {
      const remaining = (prev[key] || []).filter(id => id !== instanceId);
      const next = { ...prev };
      if (remaining.length) next[key] = remaining; else delete next[key];
      return next;
    });
    try {
      const res = await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'remove_instance', strategy: key, instanceId }),
      });
      const data = await res.json();
      if (!data.success && data.error) addToast('error', data.error);
    } catch {
      addToast('error', 'Network error removing instance.');
    } finally {
      fetchStrategies(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchStrategies]);

  useEffect(() => {
    fetchStrategies(true);
    const iv = setInterval(() => fetchStrategies(false), 2000);
    return () => clearInterval(iv);
  }, [fetchStrategies]);

  const fetchIndexTicker = useCallback(async () => {
    try {
      const res = await fetch('/api/index-ticker');
      const data = await res.json();
      if (data.success) setIndexTicker({ nifty: data.nifty ?? null, vix: data.vix ?? null });
    } catch { /* keep last known values */ }
  }, []);

  useEffect(() => {
    fetchIndexTicker();
    const iv = setInterval(fetchIndexTicker, 5000);
    return () => clearInterval(iv);
  }, [fetchIndexTicker]);

  useEffect(() => {
    if (showPnlGuard) fetchPnlGuardStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPnlGuard]);

  const runningCount = Object.values(strategies).reduce((n: number, s: any) =>
    n + Object.values(s.instances || {}).filter((st: any) => st?.status !== 'STOPPED').length, 0);
  const pnl = portfolio?.total_pnl ?? 0;

  /* ── Stop All (graceful shutdown) ── */
  const handleStopAll = async () => {
    if (!confirmStopAll) {
      setConfirmStopAll(true);
      setTimeout(() => setConfirmStopAll(false), 3000);
      return;
    }
    setStoppingAll(true);
    setConfirmStopAll(false);
    try {
      await fetch('/api/strategies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop_all' }),
      });
      addToast('info', 'Shutdown triggers written for all running strategies.');
    } catch {
      addToast('error', 'Failed to send stop_all command.');
    } finally {
      setStoppingAll(false);
      setTimeout(() => fetchStrategies(false), 500);
    }
  };

  /* ── Exit ALL Positions (broker-level nuclear) ── */
  const handleExitAll = async () => {
    if (!confirmExitAll) {
      setConfirmExitAll(true);
      setTimeout(() => setConfirmExitAll(false), 3000);
      return;
    }
    setExitingAll(true);
    setConfirmExitAll(false);
    try {
      const res = await fetch('/api/exit-all', { method: 'POST' });
      const data = await res.json();
      if (data.broker_exit) {
        const killed = data.killed?.length ?? 0;
        const fallback = data.trigger_fallback?.length ?? 0;
        const detail = killed > 0 ? ` ${killed} strategy process${killed === 1 ? '' : 'es'} terminated.` : '';
        const fb = fallback > 0 ? ` ${fallback} sent graceful shutdown.` : '';
        addToast('success', `All positions liquidated at broker.${detail}${fb}`);
      } else {
        addToast('error', data.error || 'Broker exit failed — check Dhan account manually.');
      }
    } catch {
      addToast('error', 'Network error calling exit-all API.');
    } finally {
      setExitingAll(false);
      setTimeout(() => fetchStrategies(false), 1000);
      setTimeout(fetchPortfolio, 2000);
    }
  };

  /* ── P&L Guard ── */
  const fetchPnlGuardStatus = async () => {
    setPnlGuardLoading(true);
    try {
      const res = await fetch('/api/pnl-exit');
      const data = await res.json();
      if (data.success) {
        setPnlGuardStatus(data.data ?? null);
      } else {
        setPnlGuardStatus(null);
        addToast('error', 'Could not fetch P&L Guard status — check token.');
      }
    } catch {
      setPnlGuardStatus(null);
      addToast('error', 'Network error fetching P&L Guard status.');
    } finally {
      setPnlGuardLoading(false);
    }
  };

  const handleSetPnl = async () => {
    const p = parseFloat(profitValue) || 0;
    const l = parseFloat(lossValue) || 0;
    if (p <= 0 && l <= 0) {
      addToast('error', 'Set at least one threshold (profit or loss) greater than 0.');
      return;
    }
    if (productTypes.length === 0) {
      addToast('error', 'Select at least one product type.');
      return;
    }
    setSettingPnl(true);
    try {
      const res = await fetch('/api/pnl-exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          profitValue: p,
          lossValue: l,
          productTypes,
          enableKillSwitch,
        }),
      });
      const data = await res.json();
      if (data.success) {
        addToast('success', 'P&L Guard configured successfully.');
        await fetchPnlGuardStatus();
      } else {
        addToast('error', data.error || 'Failed to configure P&L Guard.');
      }
    } catch {
      addToast('error', 'Network error setting P&L Guard.');
    } finally {
      setSettingPnl(false);
    }
  };

  const handleClearPnl = async () => {
    if (!confirmClear) {
      setConfirmClear(true);
      setTimeout(() => setConfirmClear(false), 3000);
      return;
    }
    setClearingPnl(true);
    setConfirmClear(false);
    try {
      const res = await fetch('/api/pnl-exit', { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        addToast('success', 'P&L Guard cleared.');
        await fetchPnlGuardStatus();
      } else {
        addToast('error', data.error || 'Failed to clear P&L Guard.');
      }
    } catch {
      addToast('error', 'Network error clearing P&L Guard.');
    } finally {
      setClearingPnl(false);
    }
  };

  /* ── Trade Replication ── */
  const fetchCopyTradeConfig = useCallback(async () => {
    try {
      const res = await fetch('/api/copy-trade/config');
      const data = await res.json();
      if (data.success && data.config) {
        setCopyTradeConfig({
          armed: !!data.config.armed,
          children: withAllBrokers(data.config.children ?? []),
        });
      }
    } catch { /* keep last known config */ }
  }, []);

  const fetchCopyTradeStatus = useCallback(async () => {
    try {
      const res = await fetch('/api/copy-trade?checkPid=1');
      const data = await res.json();
      if (data.success) {
        setCopyTradeStatus(data.status ?? null);
        setCopyTradeLog(Array.isArray(data.entries) ? data.entries : []);
      }
    } catch { /* keep last known status */ }
  }, []);

  useEffect(() => {
    if (!showCopyTrade) return;
    fetchCopyTradeConfig();
    fetchCopyTradeStatus();
    const iv = setInterval(fetchCopyTradeStatus, 2000);
    return () => clearInterval(iv);
  }, [showCopyTrade, fetchCopyTradeConfig, fetchCopyTradeStatus]);

  const copyTradeBridgeRunning = copyTradeStatus?.status === 'RUNNING' || copyTradeStatus?.status === 'STARTING';

  const handleToggleCopyTradeBridge = async () => {
    setTogglingBridge(true);
    try {
      await fetch('/api/copy-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: copyTradeBridgeRunning ? 'stop' : 'start' }),
      });
      addToast('info', copyTradeBridgeRunning ? 'Replication bridge stopping…' : 'Replication bridge starting…');
    } catch {
      addToast('error', 'Failed to toggle the replication bridge.');
    } finally {
      setTogglingBridge(false);
      setTimeout(fetchCopyTradeStatus, 500);
    }
  };

  const updateCopyTradeChild = async (broker: ChildBroker, patch: Partial<CopyTradeChild>) => {
    const nextChildren = withAllBrokers(copyTradeConfig.children)
      .map(c => (c.broker === broker ? { ...c, ...patch } : c));
    setCopyTradeConfig(prev => ({ ...prev, children: nextChildren }));
    try {
      const res = await fetch('/api/copy-trade/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ children: nextChildren }),
      });
      const data = await res.json();
      if (!data.success) addToast('error', data.error || 'Failed to save child account settings.');
    } catch {
      addToast('error', 'Network error saving child account settings.');
    }
  };

  const handleArmReplication = async () => {
    if (!confirmArm) {
      setConfirmArm(true);
      setTimeout(() => setConfirmArm(false), 3000);
      return;
    }
    setArming(true);
    setConfirmArm(false);
    try {
      const res = await fetch('/api/copy-trade/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: true }),
      });
      const data = await res.json();
      if (data.success) {
        setCopyTradeConfig(prev => ({ ...prev, armed: true }));
        addToast('success', 'Trade replication ARMED — child orders will now be placed live.');
      } else {
        addToast('error', data.error || 'Failed to arm replication.');
      }
    } catch {
      addToast('error', 'Network error arming replication.');
    } finally {
      setArming(false);
    }
  };

  const handleDisarmReplication = async () => {
    try {
      const res = await fetch('/api/copy-trade/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ armed: false }),
      });
      const data = await res.json();
      if (data.success) {
        setCopyTradeConfig(prev => ({ ...prev, armed: false }));
        addToast('info', 'Trade replication disarmed.');
      } else {
        addToast('error', data.error || 'Failed to disarm replication.');
      }
    } catch {
      addToast('error', 'Network error disarming replication.');
    }
  };

  const toastColor: Record<ToastType, string> = {
    success: 'bg-emerald-950/90 border-emerald-500/40 text-emerald-300',
    error:   'bg-red-950/90 border-red-500/40 text-red-300',
    info:    'bg-zinc-900/90 border-zinc-700/60 text-zinc-300',
  };

  const strategyList = Object.entries(strategies);

  type InstanceRow = { key: string; instanceId: string; meta: any; state: any };
  const byInstanceId = (a: InstanceRow, b: InstanceRow) =>
    a.instanceId === '' ? -1
    : b.instanceId === '' ? 1
    : a.instanceId.localeCompare(b.instanceId, undefined, { numeric: true });

  const instanceRows: InstanceRow[] = strategyList.flatMap(([key, item]: [string, any]) => {
    const known = item.instances || {};
    const rows: InstanceRow[] = Object.entries(known).map(([instanceId, state]) => ({
      key, instanceId, meta: item.meta, state,
    }));
    const knownIds = new Set(Object.keys(known));
    const pendingRows: InstanceRow[] = (pendingInstances[key] || [])
      .filter(id => !knownIds.has(id))
      .map(instanceId => ({
        key, instanceId, meta: item.meta,
        state: { strategy: `${key}_${instanceId}`, status: 'STOPPED', total_pnl: 0, realized_pnl: 0, spot: 0, adjustments: 0 },
      }));
    return [...rows, ...pendingRows].sort(byInstanceId);
  });

  // Filter by Horizon
  const horizonFilteredRows = useMemo(() => {
    if (horizonFilter === 'all') return instanceRows;
    return instanceRows.filter(r => (r.meta?.timeframe || 'intraday') === horizonFilter);
  }, [instanceRows, horizonFilter]);

  // Filter by Search Query (name, underlying, logicGroup, description)
  const filteredRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return horizonFilteredRows;
    return horizonFilteredRows.filter(r => {
      const name = (r.meta?.name || r.key).toLowerCase();
      const underlying = (r.meta?.underlying || '').toLowerCase();
      const logic = (r.meta?.logicGroup || '').toLowerCase();
      const desc = (r.meta?.description || '').toLowerCase();
      return name.includes(q) || underlying.includes(q) || logic.includes(q) || desc.includes(q);
    });
  }, [horizonFilteredRows, searchQuery]);

  const activeList = filteredRows.filter(row => row.state?.status !== 'STOPPED');
  const displayList = (viewMode === 'active' && !searchQuery.trim()) ? activeList : filteredRows;

  // Group by Timeframe (Intraday vs Positional)
  const groupedByTimeframeList = groupByUnderlying<InstanceRow>(
    displayList,
    row => row.meta?.timeframe || 'intraday',
    row => (row.state?.status !== 'STOPPED' ? [row.state] : []),
  );

  // Group by Underlying
  const groupedByUnderlyingList = groupByUnderlying<InstanceRow>(
    displayList,
    row => row.meta?.underlying,
    row => (row.state?.status !== 'STOPPED' ? [row.state] : []),
  );

  // Group by Strategy Logic Type
  const groupedByLogicList = groupByUnderlying<InstanceRow>(
    displayList,
    row => row.meta?.logicGroup,
    row => (row.state?.status !== 'STOPPED' ? [row.state] : []),
  );

  const activeGroupedList =
    groupMode === 'timeframe'
      ? groupedByTimeframeList
      : groupMode === 'type'
      ? groupedByLogicList
      : groupedByUnderlyingList;

  // Pin auto-opened groups
  useEffect(() => {
    groups.ensureOpen(activeGroupedList.filter(g => g.runningCount > 0).map(g => g.underlying));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupedList.map(g => `${g.underlying}:${g.runningCount > 0}`).join(','), groups]);

  // Horizon Counts
  const intradayTotal = instanceRows.filter(r => (r.meta?.timeframe || 'intraday') === 'intraday').length;
  const positionalTotal = instanceRows.filter(r => r.meta?.timeframe === 'positional').length;
  const intradayRunning = instanceRows.filter(r => (r.meta?.timeframe || 'intraday') === 'intraday' && r.state?.status !== 'STOPPED').length;
  const positionalRunning = instanceRows.filter(r => r.meta?.timeframe === 'positional' && r.state?.status !== 'STOPPED').length;

  const stopLabel = stoppingAll ? 'Stopping…' : confirmStopAll ? `Click again to stop ${runningCount}` : 'Stop all';
  const exitLabel = exitingAll ? 'Exiting…' : confirmExitAll ? 'Click again to flatten' : 'Exit all positions';
  const ok = portfolio?.success;
  const field = 'bg-zinc-900 border-zinc-700 text-white h-8 text-xs tabular-nums rounded-lg';
  const drawerBtn = (active: boolean, accent: 'amber' | 'sky') =>
    `gap-1.5 text-xs font-semibold rounded-lg h-8 ${
      active
        ? accent === 'amber' ? 'bg-amber-500/15 border-amber-500/40 text-amber-400' : 'bg-sky-500/15 border-sky-500/40 text-sky-400'
        : 'border-zinc-800 text-zinc-400 hover:text-zinc-200'
    }`;

  return (
    <div className="flex flex-col flex-1 w-full bg-zinc-950 min-h-screen text-zinc-300">
      {/* ── Toast stack ── */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none" role="status" aria-live="polite">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2.5 rounded-lg border text-xs font-semibold shadow-2xl backdrop-blur-md ${toastColor[t.type]}`}>
            {t.message}
          </div>
        ))}
      </div>

      {/* ── Header ── */}
      <header className="sticky top-0 z-30 flex items-center justify-between gap-3 flex-wrap px-6 py-3 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg shrink-0 bg-emerald-500/10 border border-emerald-500/25">
            <Layers className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold text-white tracking-tight leading-none">Algo Desk Plus</h1>
            <p className="text-[11px] text-zinc-500 font-medium mt-1">Run several copies of a strategy, guard the day&apos;s P&amp;L, mirror fills to other brokers</p>
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <BrokerSelector broker={broker} setBroker={setBroker} authenticatedBrokers={authenticatedBrokers} />
          {([
            { key: 'NIFTY', q: indexTicker?.nifty },
            { key: 'VIX', q: indexTicker?.vix },
          ] as const).map(({ key, q }) => {
            if (!q) return null;
            const chg = q.prevClose > 0 ? q.ltp - q.prevClose : 0;
            const chgPct = q.prevClose > 0 ? (chg / q.prevClose) * 100 : 0;
            const isUp = chg >= 0;
            return (
              <div key={key} className="flex items-baseline gap-2 px-1 text-xs tabular-nums">
                <span className="font-semibold text-zinc-400">{key}</span>
                <span className="font-bold text-white">
                  {q.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                {q.prevClose > 0 && (
                  <span className={isUp ? 'text-emerald-400' : 'text-red-400'}>
                    {isUp ? '+' : '-'}{Math.abs(chgPct).toFixed(2)}%
                  </span>
                )}
              </div>
            );
          })}

          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  onClick={() => fetchStrategies(true)}
                  aria-label="Refresh strategies"
                  className="p-1.5 border border-zinc-800 rounded-lg text-zinc-500 hover:text-white hover:border-zinc-700 focus-visible:outline-2 focus-visible:outline-emerald-400"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              }
            />
            <TooltipContent>Refresh strategies</TooltipContent>
          </Tooltip>

          <span className="w-px h-5 bg-zinc-800 shrink-0" />
          <NavBar />
        </div>
      </header>

      {/* ── Command strip: figures left, safety controls right ── */}
      <section aria-label="Account totals and safety controls" className="border-b border-zinc-800 bg-zinc-900">
        <div className="flex items-stretch flex-wrap px-6">
          <DeskFigure label="Day P&L" big tone={ok ? deskTone(pnl) : 'neutral'}
            value={ok ? signedInr(pnl) : portfolioLoading ? 'Loading' : '—'} />
          <DeskFigure label="Realized" tone={ok ? deskTone(portfolio.total_realized_pnl) : 'neutral'}
            value={ok ? signedInr(portfolio.total_realized_pnl) : '—'} />
          <DeskFigure label="Unrealized" tone={ok ? deskTone(portfolio.total_unrealized_pnl) : 'neutral'}
            value={ok ? signedInr(portfolio.total_unrealized_pnl) : '—'} />
          <DeskFigure label="Margin free" value={ok ? inr(portfolio.available_funds) : '—'} />
          <DeskFigure label="Open positions" value={ok ? String(portfolio.positions.length) : '—'} />
          <DeskFigure label="Strategies live" value={`${runningCount} of ${instanceRows.length}`} />

          <div className="ml-auto flex items-center gap-2 py-3 flex-wrap">
            <Button variant="outline" size="sm" onClick={() => setShowPnlGuard(v => !v)}
              aria-expanded={showPnlGuard} className={drawerBtn(showPnlGuard, 'amber')}>
              <Shield className="h-3.5 w-3.5" />
              P&amp;L guard
              {pnlGuardStatus?.pnlExitStatus === 'ACTIVE' && (
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" title="Guard active" />
              )}
              <ChevronDown className={`h-3 w-3 ${showPnlGuard ? 'rotate-180' : ''}`} />
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowCopyTrade(v => !v)}
              aria-expanded={showCopyTrade} className={drawerBtn(showCopyTrade, 'sky')}>
              <Repeat className="h-3.5 w-3.5" />
              Replication
              {copyTradeConfig.armed && (
                <span className="h-1.5 w-1.5 rounded-full bg-red-400 shrink-0" title="Armed: live orders are being copied" />
              )}
              <ChevronDown className={`h-3 w-3 ${showCopyTrade ? 'rotate-180' : ''}`} />
            </Button>

            <span className="w-px h-5 bg-zinc-800 shrink-0 mx-1" />

            <Button variant="outline" size="sm" onClick={handleStopAll} disabled={stoppingAll || runningCount === 0}
              title="Stop every running strategy gracefully (writes shutdown triggers; positions stay open)"
              className={`gap-1.5 text-xs font-semibold rounded-lg h-8 ${
                confirmStopAll ? 'bg-amber-500/20 border-amber-500 text-amber-400' : 'border-zinc-700 text-zinc-300 hover:text-white'
              }`}>
              {stoppingAll ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" />}
              {stopLabel}
            </Button>
            <Button variant="destructive" size="sm" onClick={handleExitAll} disabled={exitingAll}
              title="Emergency: close every open position at the broker"
              className={`gap-1.5 text-xs font-bold rounded-lg h-8 border ${
                confirmExitAll
                  ? 'bg-red-600 border-red-500 text-oncolor'
                  : 'bg-red-500/10 border-red-500/30 text-red-400 hover:bg-red-500/20'
              }`}>
              {exitingAll ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
              {exitLabel}
            </Button>
          </div>
        </div>
        {portfolio && !portfolio.success && (
          <div className="flex items-center gap-2 px-6 py-1.5 border-t border-amber-500/20 bg-amber-500/10 text-xs text-amber-400">
            <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
            Dhan session expired, so broker figures are hidden. Run <code className="font-mono">login.py</code> to sign in again.
            <button onClick={fetchPortfolio} className="ml-auto underline hover:text-amber-300">Retry</button>
          </div>
        )}
      </section>

      {/* ── Toolbar: search, horizon, view, grouping ── */}
      <div className="sticky top-[57px] z-20 flex items-center justify-between gap-3 flex-wrap px-6 py-2 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex items-center w-60">
            <Search className="absolute left-2.5 h-3.5 w-3.5 text-zinc-500 pointer-events-none" />
            <Input
              type="text"
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              placeholder="Search strategies"
              aria-label="Search strategies"
              className="h-8 pl-8 pr-7 bg-zinc-900 border-zinc-800 text-white text-xs placeholder:text-zinc-500 rounded-lg"
            />
            {searchQuery && (
              <button type="button" onClick={() => setSearchQuery('')} aria-label="Clear search"
                className="absolute right-2 text-zinc-500 hover:text-zinc-200">
                <X className="h-3 w-3" />
              </button>
            )}
          </div>

          <div role="tablist" aria-label="Time horizon" className="flex items-center rounded-lg border border-zinc-800 p-0.5 gap-0.5">
            {([
              { key: 'all', label: 'All', count: instanceRows.length, running: runningCount },
              { key: 'intraday', label: 'Intraday', count: intradayTotal, running: intradayRunning },
              { key: 'positional', label: 'Positional', count: positionalTotal, running: positionalRunning },
            ] as const).map(({ key, label, count, running }) => (
              <button
                key={key}
                role="tab"
                aria-selected={horizonFilter === key}
                onClick={() => setHorizonFilter(key)}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold transition-colors ${
                  horizonFilter === key ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                }`}
              >
                {label}
                <span className="tabular-nums text-zinc-500">{count}</span>
                {running > 0 && (
                  <span className="flex items-center gap-1 tabular-nums text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />{running}
                  </span>
                )}
              </button>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as 'active' | 'all')}>
            <TabsList className="bg-transparent border border-zinc-800 p-0.5 rounded-lg h-8">
              <TabsTrigger value="active" className="gap-1.5 text-xs font-semibold px-2.5 rounded-md h-7">
                Running
                {runningCount > 0 && <span className="tabular-nums text-emerald-400">{runningCount}</span>}
              </TabsTrigger>
              <TabsTrigger value="all" className="gap-1.5 text-xs font-semibold px-2.5 rounded-md h-7">
                Everything
                <span className="tabular-nums text-zinc-500">{instanceRows.length}</span>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          <Tabs value={groupMode} onValueChange={(v) => setGroupMode(v as GroupMode)}>
            <TabsList aria-label="Group by" className="bg-transparent border border-zinc-800 p-0.5 rounded-lg h-8">
              <TabsTrigger value="timeframe" title="Group by time horizon" className="text-xs font-semibold px-2.5 rounded-md h-7">Horizon</TabsTrigger>
              <TabsTrigger value="underlying" title="Group by underlying (NIFTY, CRUDEOILM, NIFTY 500)" className="text-xs font-semibold px-2.5 rounded-md h-7">Underlying</TabsTrigger>
              <TabsTrigger value="type" title="Group by trading logic" className="text-xs font-semibold px-2.5 rounded-md h-7">Logic</TabsTrigger>
            </TabsList>
          </Tabs>

          <button onClick={() => groups.setAll(activeGroupedList.map(g => g.underlying), true)} title="Expand every section"
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800">
            <ChevronsUpDown className="h-3.5 w-3.5" />Expand all
          </button>
          <button onClick={() => groups.setAll(activeGroupedList.map(g => g.underlying), false)} title="Collapse every section"
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-xs font-semibold text-zinc-400 hover:text-white hover:bg-zinc-800">
            <ChevronsDownUp className="h-3.5 w-3.5" />Collapse all
          </button>
        </div>
      </div>

      {/* ── P&L guard drawer ── */}
      {showPnlGuard && (
        <div className="border-b border-zinc-800 bg-zinc-900 px-6 py-3">
          <div className="flex items-center gap-x-5 gap-y-3 flex-wrap">
            <div className="shrink-0 text-xs font-semibold">
              {pnlGuardLoading ? (
                <RefreshCw className="h-3.5 w-3.5 text-zinc-500 animate-spin" />
              ) : pnlGuardStatus?.pnlExitStatus === 'ACTIVE' ? (
                <span className="flex items-center gap-1.5 text-emerald-400">
                  <span className="h-2 w-2 rounded-full bg-emerald-400" />
                  Guard active
                  {pnlGuardStatus.profit ? `, target +₹${pnlGuardStatus.profit.toLocaleString('en-IN')}` : ''}
                  {pnlGuardStatus.loss ? `, stop -₹${pnlGuardStatus.loss.toLocaleString('en-IN')}` : ''}
                </span>
              ) : pnlGuardStatus ? (
                <span className="text-zinc-400">Guard off</span>
              ) : (
                <span className="text-zinc-500">—</span>
              )}
            </div>

            <label className="flex items-center gap-2 text-xs text-zinc-400">
              Profit target ₹
              <Input type="number" min="0" value={profitValue} onChange={e => setProfitValue(e.target.value)}
                placeholder="5000" className={`${field} w-24`} />
            </label>
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              Loss limit ₹
              <Input type="number" min="0" value={lossValue} onChange={e => setLossValue(e.target.value)}
                placeholder="3000" className={`${field} w-24`} />
            </label>

            <div className="flex items-center gap-2 text-xs text-zinc-400">
              Product
              <ToggleGroup
                variant="outline"
                size="sm"
                spacing={0}
                value={productTypes}
                onValueChange={(next: string[]) => {
                  if (next.length === 0) return;
                  setProductTypes(next);
                }}
              >
                {(['INTRADAY', 'DELIVERY'] as const).map(pt => (
                  <ToggleGroupItem key={pt} value={pt}
                    className="text-xs font-semibold px-2.5 data-checked:bg-zinc-700 data-checked:text-white data-checked:border-zinc-500 text-zinc-400 border-zinc-800">
                    {pt === 'INTRADAY' ? 'Intraday' : 'Delivery'}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <label className="flex items-center gap-2 cursor-pointer text-xs text-zinc-300">
              <Checkbox checked={enableKillSwitch} onCheckedChange={(v) => setEnableKillSwitch(v === true)}
                className="data-checked:bg-red-600 data-checked:border-red-500 border-zinc-600 rounded" />
              Kill switch on trigger
            </label>

            <div className="flex items-center gap-2 ml-auto">
              <Button size="sm" onClick={handleSetPnl} disabled={settingPnl}
                className="gap-1.5 text-xs font-semibold rounded-lg bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400">
                {settingPnl ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Shield className="h-3 w-3" />}
                {settingPnl ? 'Setting…' : 'Set guard'}
              </Button>
              <Button variant="outline" size="sm" onClick={handleClearPnl} disabled={clearingPnl}
                className={`gap-1.5 text-xs font-semibold rounded-lg ${
                  confirmClear ? 'bg-red-600 border-red-500 text-oncolor' : 'border-zinc-700 text-zinc-400 hover:text-red-400'
                }`}>
                {clearingPnl ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
                {clearingPnl ? 'Clearing…' : confirmClear ? 'Click again to clear' : 'Clear guard'}
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* ── Replication drawer ── */}
      {showCopyTrade && (
        <div className="border-b border-zinc-800 bg-zinc-900 px-6 py-3 flex flex-col gap-3">
          {copyTradeConfig.armed && copyTradeStatus?.status !== 'RUNNING' && (
            <div role="alert" className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/30">
              <AlertTriangle className="h-4 w-4 text-red-400 shrink-0" />
              <span className="text-xs text-red-400 font-medium">
                Replication is armed but the bridge is stopped, so child accounts are not receiving fills. Start the bridge or disarm.
              </span>
            </div>
          )}

          <div className="flex items-center gap-x-5 gap-y-3 flex-wrap">
            <span className={`flex items-center gap-1.5 text-xs font-semibold ${
              copyTradeStatus?.status === 'RUNNING' ? 'text-emerald-400'
                : copyTradeStatus?.status === 'STARTING' ? 'text-amber-400' : 'text-zinc-400'
            }`}>
              {copyTradeStatus?.status === 'STARTING'
                ? <RefreshCw className="h-3 w-3 animate-spin" />
                : <span className={`h-2 w-2 rounded-full ${copyTradeStatus?.status === 'RUNNING' ? 'bg-emerald-400' : 'bg-zinc-600'}`} />}
              {copyTradeStatus?.status === 'RUNNING' ? 'Bridge listening'
                : copyTradeStatus?.status === 'STARTING' ? 'Bridge starting' : 'Bridge stopped'}
            </span>

            <Button variant="outline" size="sm" onClick={handleToggleCopyTradeBridge} disabled={togglingBridge}
              className="gap-1.5 text-xs font-semibold rounded-lg border-zinc-700 text-zinc-300 hover:text-white">
              {copyTradeBridgeRunning ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {copyTradeBridgeRunning ? 'Stop bridge' : 'Start bridge'}
            </Button>

            <span className="w-px h-5 bg-zinc-800 shrink-0" />

            {withAllBrokers(copyTradeConfig.children).map(child => {
              const failure = copyTradeStatus?.broker_failures?.[child.broker];
              return (
                <div key={child.broker} className="flex items-center gap-2 shrink-0 text-xs">
                  <span className={`font-semibold ${failure ? 'text-red-400' : 'text-white'}`}>
                    {CHILD_BROKER_LABELS[child.broker]}{failure ? ' (down)' : ''}
                  </span>
                  <Input
                    type="number"
                    min="1"
                    step="1"
                    value={child.multiplier}
                    aria-label={`${CHILD_BROKER_LABELS[child.broker]} lot multiplier`}
                    onChange={e => {
                      const n = parseInt(e.target.value, 10);
                      if (Number.isInteger(n) && n > 0) updateCopyTradeChild(child.broker, { multiplier: n });
                    }}
                    className="bg-zinc-950 border-zinc-700 text-white h-7 w-12 text-xs tabular-nums px-1 rounded"
                  />
                  <span className="text-zinc-500">×</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={child.enabled}
                    aria-label={`Copy fills to ${CHILD_BROKER_LABELS[child.broker]}`}
                    onClick={() => updateCopyTradeChild(child.broker, { enabled: !child.enabled })}
                    className={`relative w-8 h-4 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-sky-400 ${
                      child.enabled ? 'bg-sky-500' : 'bg-zinc-700'
                    }`}
                  >
                    <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-oncolor shadow transition-transform ${
                      child.enabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`} />
                  </button>
                </div>
              );
            })}

            <div className="ml-auto">
              {copyTradeConfig.armed ? (
                <Button variant="destructive" size="sm" onClick={handleDisarmReplication}
                  className="gap-1.5 text-xs font-semibold rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 hover:bg-red-500/20">
                  <ShieldOff className="h-3 w-3" />
                  Disarm replication
                </Button>
              ) : (
                <Button size="sm" onClick={handleArmReplication}
                  disabled={arming || !copyTradeConfig.children.some(c => c.enabled)}
                  className={`gap-1.5 text-xs font-semibold rounded-lg ${
                    confirmArm
                      ? 'bg-red-600 border border-red-500 text-oncolor'
                      : 'bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-400'
                  }`}>
                  {arming ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Repeat className="h-3 w-3" />}
                  {arming ? 'Arming…' : confirmArm ? 'Click again to arm' : 'Arm replication'}
                </Button>
              )}
            </div>
          </div>

          <div className="border border-zinc-800 rounded-lg bg-zinc-950 max-h-36 overflow-y-auto text-xs">
            {copyTradeLog.length === 0 ? (
              <div className="px-4 py-2.5 text-zinc-500">No copied orders yet. Fills appear here once replication is armed.</div>
            ) : (
              <div className="divide-y divide-zinc-800">
                {[...copyTradeLog].reverse().slice(0, 20).map((entry, i) => (
                  <div key={`${entry.order_no}-${entry.ts}-${i}`} className="flex items-center gap-2.5 px-4 py-1.5">
                    {entry.result === 'success' || entry.result === 'safety_exit' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-red-400 shrink-0" />
                    )}
                    <span className="text-zinc-500 tabular-nums">{new Date(entry.ts).toLocaleTimeString('en-IN')}</span>
                    {entry.broker && <span className="text-zinc-400 font-semibold">{entry.broker}</span>}
                    <span className="text-zinc-200 font-semibold truncate">
                      {entry.side} {entry.child_qty ?? entry.parent_qty} {entry.child_symbol ?? entry.parent_symbol}
                    </span>
                    <span className={`ml-auto ${entry.result === 'success' ? 'text-emerald-400 font-semibold' : 'text-zinc-400'}`}>
                      {entry.result.replace(/_/g, ' ')}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Strategy ledger ── */}
      <main className="flex-1 w-full max-w-[1720px] mx-auto px-6 py-5">
        {loading && strategyList.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 min-h-[300px] gap-3">
            <RefreshCw className="h-5 w-5 text-emerald-400 animate-spin" />
            <span className="text-zinc-500 text-xs">Loading strategies…</span>
          </div>
        ) : error ? (
          <div role="alert" className="flex flex-col items-center justify-center p-12 text-center min-h-[300px] rounded-xl border border-red-500/20 bg-red-500/10">
            <p className="text-sm font-semibold text-red-400">Can&apos;t reach the strategy API</p>
            <p className="text-xs text-zinc-400 mt-1">{error}</p>
            <Button variant="outline" size="sm" onClick={() => fetchStrategies(true)}
              className="mt-3 rounded-lg border-zinc-700 text-xs font-semibold text-zinc-300">Try again</Button>
          </div>
        ) : searchQuery && displayList.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-14 text-center min-h-[260px] gap-2">
            <p className="text-sm font-semibold text-zinc-300">No strategies match &quot;{searchQuery}&quot;</p>
            <p className="text-xs text-zinc-500">Try a strategy name, an underlying, or a logic type.</p>
            <Button variant="outline" size="sm" onClick={() => setSearchQuery('')}
              className="mt-2 gap-1.5 rounded-lg border-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold">
              <X className="h-3.5 w-3.5" />Clear search
            </Button>
          </div>
        ) : viewMode === 'active' && activeList.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 min-h-[320px] gap-2 text-center">
            <p className="text-sm font-semibold text-zinc-300">Nothing is running</p>
            <p className="text-xs text-zinc-500 max-w-sm">Show everything to launch or configure a strategy.</p>
            <Button variant="outline" onClick={() => setViewMode('all')}
              className="mt-2 gap-2 rounded-lg border-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold">
              <LayoutList className="h-3.5 w-3.5" />
              Show everything
            </Button>
          </div>
        ) : (
          <div className="w-full flex flex-col gap-5">
            {/* Column heads, once for the whole ledger */}
            <div className="flex items-center px-4 py-2 rounded-lg bg-zinc-800">
              <div className="w-[95px] shrink-0 text-xs font-bold text-white">Status</div>
              <div className="w-[280px] shrink-0 text-xs font-bold text-white">Strategy and mode</div>
              <div className="w-px mx-2" />
              <div className="flex-1 text-xs font-bold text-white">Live position and parameters</div>
              <div className="shrink-0 w-[100px] text-right text-xs font-bold text-white">Session P&amp;L</div>
              <div className="w-px mx-3" />
              <div className="shrink-0 w-[190px] text-xs font-bold text-white text-right pr-2">Actions</div>
            </div>

            {activeGroupedList.map(({ underlying: groupKey, items: rows, runningCount: groupRunning, pnl: groupPnl }) => {
              const open = searchQuery.trim() ? true : groups.isOpen(groupKey, groupRunning > 0);
              const tfInfo = groupMode === 'timeframe' ? (TIMEFRAME_GROUPS[groupKey] ?? OTHER_TIMEFRAME_GROUP) : null;
              const typeInfo = groupMode === 'type' ? (LOGIC_GROUPS[groupKey] ?? OTHER_LOGIC_GROUP) : null;
              const displayTitle = tfInfo ? tfInfo.title : typeInfo ? typeInfo.title : groupKey;
              const displayTagline = tfInfo ? tfInfo.tagline : typeInfo ? typeInfo.tagline : null;

              return (
                <section key={groupKey} aria-label={displayTitle}>
                  <button
                    type="button"
                    onClick={() => groups.toggle(groupKey, open)}
                    aria-expanded={open}
                    className="w-full flex items-center gap-3 pb-2 border-b border-zinc-800 text-left focus-visible:outline-2 focus-visible:outline-emerald-400"
                  >
                    {open ? <ChevronDown className="h-4 w-4 text-zinc-500 shrink-0" /> : <ChevronRight className="h-4 w-4 text-zinc-500 shrink-0" />}
                    <span className="text-sm font-bold text-white tracking-tight">{displayTitle}</span>
                    <span className="text-xs text-zinc-500 tabular-nums">
                      {rows.length} strateg{rows.length === 1 ? 'y' : 'ies'}
                    </span>
                    {groupRunning > 0 && (
                      <span className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse motion-reduce:animate-none" />
                        {groupRunning} running
                      </span>
                    )}
                    {groupRunning > 0 && groupPnl !== 0 && (
                      <span className={`text-xs font-bold tabular-nums ${groupPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                        {signedInr(groupPnl)}
                      </span>
                    )}
                    {displayTagline && (
                      <span className="ml-auto text-xs text-zinc-500 hidden lg:inline truncate max-w-[50%]">{displayTagline}</span>
                    )}
                  </button>

                  {open && (
                    <div className="mt-2 rounded-lg border border-zinc-800 divide-y divide-zinc-800 overflow-hidden">
                      {rows.map(({ key, instanceId, meta, state }) => (
                        <StrategyRowWide
                          key={`${key}:${instanceId}`}
                          meta={meta}
                          state={state}
                          onRefresh={fetchStrategies}
                          instanceId={instanceId || undefined}
                          onAddInstance={instanceId === '' ? addInstance : undefined}
                          onRemoveInstance={instanceId === '' ? undefined : removeInstance}
                          selectedBroker={broker}
                        />
                      ))}
                    </div>
                  )}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </div>
  );
}
