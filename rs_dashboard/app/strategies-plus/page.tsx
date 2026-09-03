'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Layers, RefreshCw, TrendingUp, TrendingDown, AlertTriangle,
  Power, ShieldOff, Activity, Zap, LayoutList, ChevronDown, ChevronRight, Shield,
  Repeat, CheckCircle2, XCircle, Play, Square, ChevronsDownUp, ChevronsUpDown,
  Sprout, Flame, Rocket, Boxes, ListTree, Moon, Clock, Calendar, Sun,
} from 'lucide-react';
import StrategyRowWide from '@/components/StrategyRowWide';
import NavBar from '@/components/NavBar';
import BrokerSelector from '@/components/BrokerSelector';
import { usePortfolio } from '@/lib/usePortfolio';
import { useBrokerSelector } from '@/hooks/useBrokerSelector';
import { useGroupCollapse, groupByUnderlying, signedInr, inr } from '@/lib/useStrategyGroups';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Named typography tokens
const TXT_EYEBROW = 'text-[9px] font-bold uppercase tracking-[0.16em]';
const TXT_LABEL = 'text-[10px] font-semibold uppercase tracking-wider';
const TXT_CAPTION = 'text-[11px] font-semibold';
const TXT_STAT = 'text-sm font-bold font-mono tabular-nums leading-tight';

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
};
const OTHER_LOGIC_GROUP = { title: 'Other', tagline: 'Uncategorised', icon: Boxes, accent: 'zinc' };

/** Time Horizon definitions for grouping */
const TIMEFRAME_GROUPS: Record<string, { title: string; tagline: string; icon: React.ElementType; accent: string; badge: string }> = {
  intraday: {
    title: 'Intraday Strategies',
    tagline: 'F&O & MCX futures with mandatory intraday square-off (15:17 IST / 23:25 MCX)',
    icon: Clock,
    accent: 'amber',
    badge: '⚡ INTRADAY',
  },
  positional: {
    title: 'Positional & Multi-Day',
    tagline: 'Multi-day CNC momentum portfolio, overnight hedged straddles, and weekly delta management',
    icon: Calendar,
    accent: 'violet',
    badge: '🌙 POSITIONAL',
  },
};
const OTHER_TIMEFRAME_GROUP = {
  title: 'Other Strategies',
  tagline: 'Flexible holding horizon',
  icon: Boxes,
  accent: 'zinc',
  badge: 'OTHER',
};

const ACCENT_CLASSES: Record<string, { icon: string; iconBg: string; iconBorder: string; ring: string; badge: string }> = {
  emerald: { icon: 'text-emerald-400', iconBg: 'bg-emerald-500/10', iconBorder: 'border-emerald-500/25', ring: 'hover:border-emerald-700/60', badge: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30' },
  sky:     { icon: 'text-sky-400',     iconBg: 'bg-sky-500/10',     iconBorder: 'border-sky-500/25',     ring: 'hover:border-sky-700/60',     badge: 'bg-sky-500/15 text-sky-300 border-sky-500/30' },
  violet:  { icon: 'text-violet-400',  iconBg: 'bg-violet-500/10',  iconBorder: 'border-violet-500/25',  ring: 'hover:border-violet-700/60',  badge: 'bg-violet-500/15 text-violet-300 border-violet-500/30' },
  amber:   { icon: 'text-amber-400',   iconBg: 'bg-amber-500/10',   iconBorder: 'border-amber-500/25',   ring: 'hover:border-amber-700/60',   badge: 'bg-amber-500/15 text-amber-300 border-amber-500/30' },
  orange:  { icon: 'text-orange-400',  iconBg: 'bg-orange-500/10',  iconBorder: 'border-orange-500/25',  ring: 'hover:border-orange-700/60',  badge: 'bg-orange-500/15 text-orange-300 border-orange-500/30' },
  fuchsia: { icon: 'text-fuchsia-400', iconBg: 'bg-fuchsia-500/10', iconBorder: 'border-fuchsia-500/25', ring: 'hover:border-fuchsia-700/60', badge: 'bg-fuchsia-500/15 text-fuchsia-300 border-fuchsia-500/30' },
  zinc:    { icon: 'text-zinc-400',    iconBg: 'bg-zinc-500/10',    iconBorder: 'border-zinc-500/25',    ring: 'hover:border-zinc-700/60',    badge: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30' },
  cyan:    { icon: 'text-cyan-400',    iconBg: 'bg-cyan-500/10',    iconBorder: 'border-cyan-500/25',    ring: 'hover:border-cyan-700/60',    badge: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' },
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
  const pnlPositive = pnl >= 0;

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

  const activeList = horizonFilteredRows.filter(row => row.state?.status !== 'STOPPED');
  const displayList = viewMode === 'active' ? activeList : horizonFilteredRows;

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

  return (
    <div className="flex flex-col flex-1 w-full bg-zinc-950 min-h-screen text-zinc-300">
      {/* ── Toast stack ── */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2.5 rounded-xl border text-xs font-semibold shadow-2xl backdrop-blur-md animate-in fade-in slide-in-from-right-4 duration-300 ${toastColor[t.type]}`}>
            {t.message}
          </div>
        ))}
      </div>

      {/* ── Sticky Navigation & Control Header ── */}
      <header className="sticky top-0 z-30 w-full border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-5 py-2.5 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3 shrink-0">
          <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-emerald-500/10 border border-emerald-500/25 shrink-0">
            <Layers className="h-4 w-4 text-emerald-400" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="text-[9px] font-bold text-emerald-400 uppercase tracking-[0.18em]">
                Algo Execution · Control Center
              </p>
              <span className="text-[9px] font-mono font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/25 px-1.5 py-0.2 rounded">
                HUB
              </span>
            </div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none mt-0.5">
              Strategies+ Manager
            </h1>
          </div>
        </div>

        <NavBar />

        <div className="flex items-center gap-3 shrink-0">
          <BrokerSelector
            broker={broker}
            setBroker={setBroker}
            authenticatedBrokers={authenticatedBrokers}
          />
          {/* Live NIFTY + India VIX ticker capsules */}
          {([
            { key: 'NIFTY', q: indexTicker?.nifty, decimals: 2 },
            { key: 'VIX', q: indexTicker?.vix, decimals: 2 },
          ] as const).map(({ key, q, decimals }) => {
            if (!q) return null;
            const chg = q.prevClose > 0 ? q.ltp - q.prevClose : 0;
            const chgPct = q.prevClose > 0 ? (chg / q.prevClose) * 100 : 0;
            const isUp = chg >= 0;
            return (
              <div key={key} className="flex items-baseline gap-2 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-1 text-xs">
                <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">{key}</span>
                <span className="font-mono font-bold text-white tabular-nums">
                  {q.ltp.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
                </span>
                {q.prevClose > 0 && (
                  <span className={`flex items-baseline gap-1 text-[11px] font-mono tabular-nums ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                    <span>{isUp ? '▲' : '▼'}</span>
                    <span>{Math.abs(chg).toFixed(2)}</span>
                    <span className="text-zinc-500 font-normal">({isUp ? '+' : ''}{chgPct.toFixed(2)}%)</span>
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
                  className="p-2 border border-zinc-800 rounded-xl bg-zinc-900 text-zinc-400 hover:text-white hover:border-zinc-700 transition-all active:scale-95"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                </button>
              }
            />
            <TooltipContent>Refresh strategy status</TooltipContent>
          </Tooltip>
        </div>
      </header>

      {/* ── Executive Book Strip (Hero P&L & Safety Console) ── */}
      <div className="w-full border-b border-zinc-800 bg-zinc-900/40 px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
        {/* Left: Financial Status Cluster */}
        <div className="flex items-center gap-4 flex-wrap bg-zinc-900/80 border border-zinc-800 rounded-2xl px-4 py-2.5 shadow-sm">
          <div className="flex items-center gap-3">
            <div className={`w-8 h-8 rounded-xl flex items-center justify-center border ${
              pnlPositive ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
            }`}>
              {portfolioLoading && !portfolio ? (
                <RefreshCw className="h-4 w-4 text-zinc-500 animate-spin" />
              ) : pnlPositive ? (
                <TrendingUp className="h-4 w-4 text-emerald-400" />
              ) : (
                <TrendingDown className="h-4 w-4 text-rose-400" />
              )}
            </div>
            <div className="flex flex-col">
              <span className={`${TXT_EYEBROW} text-zinc-400 leading-none`}>Combined P&amp;L</span>
              <span className={`text-lg font-mono font-extrabold tabular-nums tracking-tight ${
                portfolio ? (pnlPositive ? 'text-emerald-400' : 'text-rose-400') : 'text-zinc-500'
              }`}>
                {portfolio
                  ? `${pnlPositive ? '+' : ''}₹${pnl.toLocaleString('en-IN', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
                  : '—'}
              </span>
            </div>
          </div>

          {portfolio?.success && (
            <>
              <Separator orientation="vertical" className="h-8 bg-zinc-800" />
              <div className="flex flex-col">
                <span className={`${TXT_EYEBROW} text-zinc-400 leading-none`}>Realized</span>
                <span className={`text-xs font-mono font-bold tabular-nums ${portfolio.total_realized_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {portfolio.total_realized_pnl >= 0 ? '+' : ''}₹{portfolio.total_realized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <Separator orientation="vertical" className="h-8 bg-zinc-800" />
              <div className="flex flex-col">
                <span className={`${TXT_EYEBROW} text-zinc-400 leading-none`}>Unrealized</span>
                <span className={`text-xs font-mono font-bold tabular-nums ${portfolio.total_unrealized_pnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {portfolio.total_unrealized_pnl >= 0 ? '+' : ''}₹{portfolio.total_unrealized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <Separator orientation="vertical" className="h-8 bg-zinc-800" />
              <div className="flex flex-col">
                <span className={`${TXT_EYEBROW} text-zinc-400 leading-none`}>Margin Avail</span>
                <span className="text-xs font-mono font-bold text-white tabular-nums">
                  ₹{portfolio.available_funds.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <Separator orientation="vertical" className="h-8 bg-zinc-800" />
              <div className="flex flex-col">
                <span className={`${TXT_EYEBROW} text-zinc-400 leading-none`}>Positions</span>
                <span className="text-xs font-mono font-bold text-sky-300 tabular-nums">{portfolio.positions.length}</span>
              </div>
            </>
          )}

          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  onClick={fetchPortfolio}
                  disabled={portfolioLoading}
                  className="p-1 rounded text-zinc-500 hover:text-zinc-200 transition-colors disabled:opacity-40"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${portfolioLoading ? 'animate-spin' : ''}`} />
                </button>
              }
            />
            <TooltipContent>Refresh Broker Balance &amp; P&amp;L</TooltipContent>
          </Tooltip>

          {portfolio && !portfolio.success && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
              <span className="text-[11px] font-mono text-amber-300">
                Token expired — run <code className="bg-amber-500/15 px-1 py-0.2 rounded font-bold">login.py</code>
              </span>
            </div>
          )}
        </div>

        {/* Right: Operational Controls & Safety Dock */}
        <div className="flex items-center gap-2.5 shrink-0 flex-wrap">
          {/* P&L Guard Drawer Toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowPnlGuard(v => !v)}
            className={`gap-1.5 text-xs font-bold rounded-xl transition-all ${
              showPnlGuard
                ? 'bg-amber-500/20 border-amber-500/40 text-amber-300'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Shield className="h-3.5 w-3.5" />
            P&amp;L Guard
            {pnlGuardStatus?.pnlExitStatus === 'ACTIVE' && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
            )}
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showPnlGuard ? 'rotate-180' : ''}`} />
          </Button>

          {/* Trade Replication Drawer Toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCopyTrade(v => !v)}
            className={`gap-1.5 text-xs font-bold rounded-xl transition-all ${
              showCopyTrade
                ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
            }`}
          >
            <Repeat className="h-3.5 w-3.5" />
            Replication
            {copyTradeConfig.armed && (
              <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse shrink-0" title="Armed — live orders active" />
            )}
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showCopyTrade ? 'rotate-180' : ''}`} />
          </Button>

          {/* View Filter (Active vs All) */}
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as 'active' | 'all')}>
            <TabsList className="bg-zinc-900 border border-zinc-800 p-1 rounded-xl h-auto">
              <TabsTrigger value="active" className="gap-1.5 text-xs font-bold font-mono px-3 py-1 rounded-lg">
                <Zap className="h-3 w-3" />
                Active
                {runningCount > 0 && (
                  <Badge variant="secondary" className="h-4 px-1.5 bg-emerald-500/20 text-emerald-300 border-0 text-[10px] font-mono font-bold">
                    {runningCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="all" className="gap-1.5 text-xs font-bold font-mono px-3 py-1 rounded-lg">
                <LayoutList className="h-3 w-3" />
                All
                <Badge variant="secondary" className="h-4 px-1.5 bg-zinc-800 text-zinc-400 border-0 text-[10px] font-mono font-bold">
                  {instanceRows.length}
                </Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Grouping Dimension: Timeframe (Intraday/Positional), Underlying, or Type */}
          <Tabs value={groupMode} onValueChange={(v) => setGroupMode(v as GroupMode)}>
            <TabsList className="bg-zinc-900 border border-zinc-800 p-1 rounded-xl h-auto">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <TabsTrigger value="timeframe" className="gap-1.5 text-xs font-bold font-mono px-2.5 py-1 rounded-lg">
                      <Clock className="h-3 w-3 text-amber-400" />
                      Horizon
                    </TabsTrigger>
                  }
                />
                <TooltipContent>Group by Time Horizon (⚡ Intraday vs 🌙 Positional)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <TabsTrigger value="underlying" className="gap-1.5 text-xs font-bold font-mono px-2.5 py-1 rounded-lg">
                      <ListTree className="h-3 w-3 text-sky-400" />
                      Underlying
                    </TabsTrigger>
                  }
                />
                <TooltipContent>Group by Underlying Exposure (NIFTY, CRUDEOILM, NIFTY 500)</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <TabsTrigger value="type" className="gap-1.5 text-xs font-bold font-mono px-2.5 py-1 rounded-lg">
                      <Boxes className="h-3 w-3 text-violet-400" />
                      Type
                    </TabsTrigger>
                  }
                />
                <TooltipContent>Group by Trading Logic Category</TooltipContent>
              </Tooltip>
            </TabsList>
          </Tabs>

          {/* Expand / Collapse Toggle */}
          <ToggleGroup variant="outline" size="sm" className="bg-zinc-900 border border-zinc-800 rounded-xl p-0.5">
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value="expand"
                    onClick={() => groups.setAll(activeGroupedList.map(g => g.underlying), true)}
                    className="text-zinc-400 hover:text-white data-checked:bg-transparent h-7 w-7 p-0"
                  >
                    <ChevronsUpDown className="h-3.5 w-3.5" />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent>Expand all sections</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value="collapse"
                    onClick={() => groups.setAll(activeGroupedList.map(g => g.underlying), false)}
                    className="text-zinc-400 hover:text-white data-checked:bg-transparent h-7 w-7 p-0"
                  >
                    <ChevronsDownUp className="h-3.5 w-3.5" />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent>Collapse all sections</TooltipContent>
            </Tooltip>
          </ToggleGroup>

          {/* Safety Action Dock */}
          <div className="flex items-center gap-1.5 rounded-xl border border-rose-950/80 bg-rose-950/20 px-2 py-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleStopAll}
              disabled={stoppingAll || runningCount === 0}
              className={`gap-1.5 text-xs font-bold font-mono rounded-xl ${
                confirmStopAll
                  ? 'bg-amber-500/20 border-amber-500 text-amber-300 animate-pulse'
                  : stoppingAll
                  ? 'bg-zinc-900 border-zinc-800 text-zinc-500'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
              }`}
              title="Gracefully stop all running strategies (write shutdown triggers)"
            >
              {stoppingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
              {stoppingAll ? 'Stopping…' : confirmStopAll ? 'Confirm Stop All?' : 'Stop All'}
            </Button>

            <Button
              variant="destructive"
              size="sm"
              onClick={handleExitAll}
              disabled={exitingAll}
              className={`gap-1.5 text-xs font-bold font-mono rounded-xl border ${
                exitingAll
                  ? 'bg-rose-900/40 border-rose-800 text-rose-400'
                  : confirmExitAll
                  ? 'bg-rose-600 border-rose-500 text-white animate-pulse shadow-lg shadow-rose-500/30'
                  : 'bg-rose-950/70 border-rose-900 text-rose-400 hover:bg-rose-900/50 hover:text-rose-200'
              }`}
              title="Emergency flatten: close ALL active positions at broker level"
            >
              {exitingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
              {exitingAll ? 'Exiting…' : confirmExitAll ? 'Confirm EXIT ALL?' : 'EXIT ALL Positions'}
            </Button>
          </div>
        </div>
      </div>

      {/* ── Sub-Filter Ribbon (Horizon Pills: All / Intraday / Positional) ── */}
      <div className="w-full border-b border-zinc-800/80 bg-zinc-950/60 px-5 py-2 flex items-center justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-widest mr-1">Filter Horizon:</span>
          {(
            [
              { key: 'all', label: 'All Horizons', count: instanceRows.length, running: runningCount, icon: Layers },
              { key: 'intraday', label: '⚡ Intraday Only', count: intradayTotal, running: intradayRunning, icon: Clock },
              { key: 'positional', label: '🌙 Positional & Multi-Day', count: positionalTotal, running: positionalRunning, icon: Calendar },
            ] as const
          ).map(({ key, label, count, running, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setHorizonFilter(key)}
              className={`flex items-center gap-2 px-3 py-1 rounded-xl text-xs font-mono font-bold transition-all ${
                horizonFilter === key
                  ? key === 'intraday'
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    : key === 'positional'
                    ? 'bg-violet-500/15 text-violet-300 border border-violet-500/30'
                    : 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30'
                  : 'bg-zinc-900/60 text-zinc-400 border border-zinc-800 hover:text-zinc-200'
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              <span>{label}</span>
              <span className="text-[10px] text-zinc-400 font-normal">({count})</span>
              {running > 0 && (
                <span className="inline-flex items-center gap-1 text-[10px] text-emerald-400 font-bold bg-emerald-500/10 px-1.5 py-0.2 rounded">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                  {running}
                </span>
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 text-xs font-mono text-zinc-400">
          <Activity className={`h-3.5 w-3.5 ${runningCount > 0 ? 'text-emerald-400' : 'text-zinc-600'}`} />
          <span>
            <strong className="text-white">{runningCount}</strong> / {instanceRows.length} active process{runningCount === 1 ? '' : 'es'}
          </span>
        </div>
      </div>

      {/* ── P&L Guard Drawer Panel ── */}
      {showPnlGuard && (
        <div className="w-full border-b border-zinc-800 bg-zinc-900/60 px-5 py-3.5 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center gap-4 flex-wrap rounded-2xl border border-zinc-800 bg-zinc-950/80 px-4 py-3 shadow-inner">
            <div className="flex items-center gap-2 shrink-0">
              {pnlGuardLoading ? (
                <RefreshCw className="h-3.5 w-3.5 text-zinc-500 animate-spin" />
              ) : pnlGuardStatus?.pnlExitStatus === 'ACTIVE' ? (
                <Badge className="gap-1.5 text-xs font-mono font-bold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-xl px-2.5 py-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
                  GUARD ACTIVE
                  {pnlGuardStatus.profit ? ` · Target +₹${pnlGuardStatus.profit.toLocaleString('en-IN')}` : ''}
                  {pnlGuardStatus.loss ? ` · Stop -₹${pnlGuardStatus.loss.toLocaleString('en-IN')}` : ''}
                </Badge>
              ) : pnlGuardStatus ? (
                <Badge variant="outline" className="text-xs font-mono font-bold bg-zinc-800 border-zinc-700 text-zinc-400 rounded-xl px-2.5 py-1">
                  GUARD INACTIVE
                </Badge>
              ) : (
                <span className="text-xs text-zinc-500 font-mono">—</span>
              )}
            </div>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold text-zinc-400 font-mono uppercase">Profit Target</span>
              <div className="flex items-center gap-1">
                <span className="text-xs text-zinc-400 font-mono">₹</span>
                <Input
                  type="number"
                  min="0"
                  value={profitValue}
                  onChange={e => setProfitValue(e.target.value)}
                  placeholder="e.g. 5000"
                  className="bg-zinc-900 border-zinc-700 text-white h-8 w-24 text-xs font-mono tabular-nums rounded-lg"
                />
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold text-zinc-400 font-mono uppercase">Loss Limit</span>
              <div className="flex items-center gap-1">
                <span className="text-xs text-zinc-400 font-mono">₹</span>
                <Input
                  type="number"
                  min="0"
                  value={lossValue}
                  onChange={e => setLossValue(e.target.value)}
                  placeholder="e.g. 3000"
                  className="bg-zinc-900 border-zinc-700 text-white h-8 w-24 text-xs font-mono tabular-nums rounded-lg"
                />
              </div>
            </div>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            <div className="flex items-center gap-2 shrink-0">
              <span className="text-xs font-bold text-zinc-400 font-mono uppercase">Product</span>
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
                  <ToggleGroupItem
                    key={pt}
                    value={pt}
                    className="text-xs font-mono font-bold px-2.5 data-checked:bg-zinc-700 data-checked:text-white data-checked:border-zinc-500 text-zinc-400 border-zinc-800"
                  >
                    {pt}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            <label className="flex items-center gap-2 cursor-pointer shrink-0">
              <Checkbox
                checked={enableKillSwitch}
                onCheckedChange={(v) => setEnableKillSwitch(v === true)}
                className="data-checked:bg-rose-600 data-checked:border-rose-500 border-zinc-600 rounded"
              />
              <span className="text-xs font-semibold text-zinc-300">Kill switch on trigger</span>
            </label>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            <Button
              size="sm"
              onClick={handleSetPnl}
              disabled={settingPnl}
              className="gap-1.5 text-xs font-mono font-bold rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300"
            >
              {settingPnl ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Shield className="h-3 w-3" />}
              {settingPnl ? 'Setting…' : 'Set Guard'}
            </Button>

            <Button
              variant="outline"
              size="sm"
              onClick={handleClearPnl}
              disabled={clearingPnl}
              className={`gap-1.5 text-xs font-mono font-bold rounded-xl ${
                confirmClear
                  ? 'bg-rose-600 border-rose-500 text-white animate-pulse'
                  : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-rose-400'
              }`}
            >
              {clearingPnl ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
              {clearingPnl ? 'Clearing…' : confirmClear ? 'Confirm Clear?' : 'Clear'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Trade Replication Drawer Panel ── */}
      {showCopyTrade && (
        <div className="w-full border-b border-zinc-800 bg-zinc-900/60 px-5 py-3.5 flex flex-col gap-3 animate-in fade-in slide-in-from-top-2 duration-200">
          {copyTradeConfig.armed && copyTradeStatus?.status !== 'RUNNING' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-rose-950/70 border border-rose-800/60">
              <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0" />
              <span className="text-xs text-rose-300 font-medium">
                Armed but replication bridge is STOPPED — child accounts are NOT receiving copy fills. Start bridge or disarm.
              </span>
            </div>
          )}

          <div className="flex items-center gap-4 flex-wrap rounded-2xl border border-zinc-800 bg-zinc-950/80 px-4 py-3 shadow-inner">
            <div className="flex items-center gap-2 shrink-0">
              {copyTradeStatus?.status === 'RUNNING' ? (
                <Badge className="gap-1.5 text-xs font-mono font-bold bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 rounded-xl px-2.5 py-1">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 shrink-0 animate-pulse" />
                  BRIDGE LISTENING
                </Badge>
              ) : copyTradeStatus?.status === 'STARTING' ? (
                <Badge className="gap-1.5 text-xs font-mono font-bold bg-amber-500/15 border border-amber-500/30 text-amber-400 rounded-xl px-2.5 py-1">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  STARTING
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs font-mono font-bold bg-zinc-800 border-zinc-700 text-zinc-400 rounded-xl px-2.5 py-1">
                  BRIDGE STOPPED
                </Badge>
              )}
            </div>

            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleCopyTradeBridge}
              disabled={togglingBridge}
              className="gap-1.5 text-xs font-mono font-bold rounded-xl bg-zinc-900 border-zinc-700 text-zinc-300 hover:text-white"
            >
              {copyTradeBridgeRunning ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {copyTradeBridgeRunning ? 'Stop Bridge' : 'Start Bridge'}
            </Button>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            <span className="text-xs font-bold text-zinc-400 font-mono uppercase">Child Accounts</span>
            {withAllBrokers(copyTradeConfig.children).map(child => {
              const failure = copyTradeStatus?.broker_failures?.[child.broker];
              return (
                <div key={child.broker} className="flex items-center gap-2 shrink-0 bg-zinc-900 border border-zinc-800 rounded-xl px-3 py-1">
                  <span className="text-xs font-bold font-mono text-white">
                    {CHILD_BROKER_LABELS[child.broker]}{failure ? ' (DOWN)' : ''}
                  </span>
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min="1"
                      step="1"
                      value={child.multiplier}
                      onChange={e => {
                        const n = parseInt(e.target.value, 10);
                        if (Number.isInteger(n) && n > 0) updateCopyTradeChild(child.broker, { multiplier: n });
                      }}
                      className="bg-zinc-950 border-zinc-700 text-white h-7 w-12 text-xs font-mono tabular-nums px-1 rounded"
                    />
                    <span className="text-xs text-zinc-400 font-mono">x</span>
                  </div>
                  <div
                    onClick={() => updateCopyTradeChild(child.broker, { enabled: !child.enabled })}
                    className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                      child.enabled ? 'bg-sky-500' : 'bg-zinc-700'
                    }`}
                  >
                    <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${
                      child.enabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`} />
                  </div>
                </div>
              );
            })}

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            {copyTradeConfig.armed ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDisarmReplication}
                className="gap-1.5 text-xs font-mono font-bold rounded-xl bg-rose-950/80 border border-rose-800 text-rose-400 hover:bg-rose-900/60 hover:text-rose-200"
              >
                <ShieldOff className="h-3 w-3" />
                DISARM REPLICATION
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleArmReplication}
                disabled={arming || !copyTradeConfig.children.some(c => c.enabled)}
                className={`gap-1.5 text-xs font-mono font-bold rounded-xl ${
                  confirmArm
                    ? 'bg-rose-600 border border-rose-500 text-white animate-pulse shadow-lg shadow-rose-500/20'
                    : 'bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-300'
                }`}
              >
                {arming ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Repeat className="h-3 w-3" />}
                {arming ? 'Arming…' : confirmArm ? 'Confirm ARM?' : 'ARM Replication'}
              </Button>
            )}
          </div>

          {/* Activity Feed */}
          <div className="border border-zinc-800 rounded-xl bg-zinc-950/80 max-h-36 overflow-y-auto font-mono text-xs">
            {copyTradeLog.length === 0 ? (
              <div className="px-4 py-2.5 text-zinc-500 font-sans text-xs">No replication events recorded.</div>
            ) : (
              <div className="divide-y divide-zinc-800/60">
                {[...copyTradeLog].reverse().slice(0, 20).map((entry, i) => (
                  <div key={`${entry.order_no}-${entry.ts}-${i}`} className="flex items-center gap-2.5 px-4 py-1.5">
                    {entry.result === 'success' || entry.result === 'safety_exit' ? (
                      <CheckCircle2 className="h-3.5 w-3.5 text-emerald-400 shrink-0" />
                    ) : (
                      <XCircle className="h-3.5 w-3.5 text-rose-400 shrink-0" />
                    )}
                    <span className="text-zinc-500 tabular-nums">
                      {new Date(entry.ts).toLocaleTimeString('en-IN')}
                    </span>
                    {entry.broker && (
                      <span className="px-1.5 py-0.2 rounded bg-zinc-800 text-zinc-300 text-[10px] font-bold uppercase">
                        {entry.broker}
                      </span>
                    )}
                    <span className="text-zinc-200 font-semibold truncate">
                      {entry.side} {entry.child_qty ?? entry.parent_qty} {entry.child_symbol ?? entry.parent_symbol}
                    </span>
                    <span className={`ml-auto text-[11px] ${
                      entry.result === 'success' ? 'text-emerald-400 font-bold' : 'text-zinc-400'
                    }`}>
                      {entry.result}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Main Strategy Matrix ── */}
      <main className="flex-1 w-full max-w-[1720px] mx-auto px-5 py-4">
        {loading && strategyList.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 min-h-[300px] gap-3">
            <RefreshCw className="h-8 w-8 text-emerald-400 animate-spin" />
            <span className="text-zinc-400 text-xs font-mono">Syncing algorithmic strategy states…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center p-12 text-center min-h-[300px] bg-zinc-900/40 border border-zinc-800 rounded-2xl">
            <p className="text-sm font-bold text-rose-400 font-mono">Connection Failed</p>
            <p className="text-xs text-zinc-400 mt-1">{error}</p>
          </div>
        ) : viewMode === 'active' && activeList.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 min-h-[320px] gap-3 bg-zinc-900/30 border border-zinc-800 rounded-2xl text-center">
            <div className="h-12 w-12 rounded-2xl bg-zinc-900 border border-zinc-800 flex items-center justify-center text-zinc-500">
              <Activity className="h-6 w-6" />
            </div>
            <p className="text-sm font-bold text-zinc-300">No Active Strategy Processes</p>
            <p className="text-xs text-zinc-400 max-w-sm">
              There are currently no live trading processes running. Switch to <strong className="text-white font-mono">All</strong> view to launch or configure a strategy.
            </p>
            <Button
              variant="outline"
              onClick={() => setViewMode('all')}
              className="mt-2 gap-2 rounded-xl border-zinc-700 bg-zinc-900 text-zinc-300 hover:text-white text-xs font-bold font-mono"
            >
              <LayoutList className="h-3.5 w-3.5" />
              View All Available Strategies
            </Button>
          </div>
        ) : (
          <div className="w-full space-y-4">
            {/* ── Time Horizon Hub Overview (Visible in Horizon group mode) ── */}
            {groupMode === 'timeframe' && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3.5 mb-4">
                {activeGroupedList.map(({ underlying: groupKey, items: rows, runningCount: groupRunning, pnl: groupPnl }) => {
                  const info = TIMEFRAME_GROUPS[groupKey] ?? OTHER_TIMEFRAME_GROUP;
                  const a = ACCENT_CLASSES[info.accent] ?? ACCENT_CLASSES.zinc;
                  const Icon = info.icon;
                  const open = groups.isOpen(groupKey, groupRunning > 0);
                  return (
                    <button
                      key={groupKey}
                      type="button"
                      onClick={() => groups.toggle(groupKey, open)}
                      aria-expanded={open}
                      className={`group relative flex items-start gap-3.5 rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4 text-left transition-all duration-200 overflow-hidden ${a.ring}`}
                    >
                      <div className={`flex items-center justify-center w-10 h-10 rounded-xl ${a.iconBg} border ${a.iconBorder} shrink-0 mt-0.5`}>
                        <Icon className={`h-5 w-5 ${a.icon}`} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center justify-between gap-2 mb-1">
                          <span className={`text-[9px] font-mono font-bold px-2 py-0.5 rounded border ${a.badge}`}>
                            {info.badge}
                          </span>
                          <span className="text-xs font-mono font-bold text-zinc-400">
                            {rows.length} strateg{rows.length === 1 ? 'y' : 'ies'}
                          </span>
                        </div>
                        <h3 className="text-sm font-bold text-white tracking-tight">{info.title}</h3>
                        <p className="text-[11px] text-zinc-400 font-medium leading-snug mt-0.5 line-clamp-2">
                          {info.tagline}
                        </p>
                        <div className="flex items-center gap-3 mt-2 font-mono text-xs">
                          {groupRunning > 0 ? (
                            <span className="flex items-center gap-1.5 text-emerald-400 font-bold">
                              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" />
                              {groupRunning} Live
                            </span>
                          ) : (
                            <span className="text-zinc-500 font-medium">0 running</span>
                          )}
                          {groupRunning > 0 && groupPnl !== 0 && (
                            <span className={`font-bold tabular-nums ${groupPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                              P&amp;L: {signedInr(groupPnl)}
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}

            {/* ── Table Column Header Bar ── */}
            <div className="flex items-center gap-0 px-4 py-2 border border-zinc-800 bg-zinc-800 rounded-xl">
              <div className="w-[90px] shrink-0 text-xs font-bold text-white font-sans">Status</div>
              <div className="w-[250px] shrink-0 text-xs font-bold text-white font-sans">Strategy &amp; Mode</div>
              <div className="w-px mx-2" />
              <div className="flex-1 text-xs font-bold text-white font-sans">Live Position &amp; Parameters</div>
              <div className="shrink-0 w-[90px] text-right text-xs font-bold text-white font-sans">Session P&amp;L</div>
              <div className="w-px mx-3" />
              <div className="shrink-0 w-[170px] text-xs font-bold text-white font-sans text-right pr-2">Execution Actions</div>
            </div>

            {/* ── Strategy Grouped Sections ── */}
            <div className="space-y-4">
              {activeGroupedList.map(({ underlying: groupKey, items: rows, runningCount: groupRunning, pnl: groupPnl }) => {
                const open = groups.isOpen(groupKey, groupRunning > 0);
                const isTimeframe = groupMode === 'timeframe';
                const tfInfo = isTimeframe ? (TIMEFRAME_GROUPS[groupKey] ?? OTHER_TIMEFRAME_GROUP) : null;
                const typeInfo = groupMode === 'type' ? (LOGIC_GROUPS[groupKey] ?? OTHER_LOGIC_GROUP) : null;

                const displayTitle = tfInfo ? tfInfo.title : typeInfo ? typeInfo.title : groupKey;
                const displayTagline = tfInfo ? tfInfo.tagline : typeInfo ? typeInfo.tagline : null;
                const accent = tfInfo?.accent ?? typeInfo?.accent ?? 'sky';
                const a = ACCENT_CLASSES[accent] ?? ACCENT_CLASSES.zinc;

                return (
                  <div key={groupKey} className="rounded-2xl border border-zinc-800 bg-zinc-900/40 overflow-hidden shadow-sm">
                    {/* Section Header Button */}
                    <button
                      type="button"
                      onClick={() => groups.toggle(groupKey, open)}
                      aria-expanded={open}
                      className="w-full flex items-center justify-between gap-3 px-4 py-2.5 bg-zinc-900/90 hover:bg-zinc-800/80 border-b border-zinc-800 transition-colors text-left"
                    >
                      <div className="flex items-center gap-2.5 min-w-0">
                        {open ? (
                          <ChevronDown className="h-4 w-4 text-zinc-400 shrink-0" />
                        ) : (
                          <ChevronRight className="h-4 w-4 text-zinc-400 shrink-0" />
                        )}
                        <span className="text-xs font-bold text-white tracking-wide font-mono uppercase">
                          {displayTitle}
                        </span>
                        {displayTagline && (
                          <span className="text-[11px] text-zinc-400 font-sans hidden md:inline truncate">
                            · {displayTagline}
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-3 shrink-0 font-mono text-xs">
                        <span className="text-zinc-400 font-semibold">
                          {rows.length} strateg{rows.length === 1 ? 'y' : 'ies'}
                        </span>
                        {groupRunning > 0 && (
                          <span className="flex items-center gap-1.5 text-emerald-400 font-bold bg-emerald-500/10 border border-emerald-500/25 px-2 py-0.5 rounded-lg">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 animate-pulse" />
                            {groupRunning} Live
                          </span>
                        )}
                        {groupRunning > 0 && groupPnl !== 0 && (
                          <span className={`font-bold tabular-nums ${groupPnl >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {signedInr(groupPnl)}
                          </span>
                        )}
                      </div>
                    </button>

                    {/* Section Strategy Rows */}
                    {open && (
                      <div className="divide-y divide-zinc-800/50 bg-zinc-950/60">
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
                  </div>
                );
              })}
            </div>

            {/* Hint in "All" view */}
            {viewMode === 'all' && runningCount > 0 && (
              <div className="px-4 py-3 border border-zinc-800/80 rounded-2xl bg-zinc-900/30 flex items-center justify-between gap-3 text-xs font-mono">
                <div className="flex items-center gap-2 text-zinc-400">
                  <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shrink-0" />
                  <span>
                    <strong className="text-white">{runningCount}</strong> strateg{runningCount === 1 ? 'y' : 'ies'} actively executing in the market.
                  </span>
                </div>
                <button
                  onClick={() => setViewMode('active')}
                  className="text-emerald-400 hover:text-emerald-300 font-bold underline underline-offset-4"
                >
                  Switch to Active View →
                </button>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
