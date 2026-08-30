'use client';

import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Layers, RefreshCw, TrendingUp, TrendingDown, AlertTriangle,
  Power, ShieldOff, Activity, Zap, LayoutList, ChevronDown, ChevronRight, Shield,
  Repeat, CheckCircle2, XCircle, Play, Square, ChevronsDownUp, ChevronsUpDown,
  Sprout, Flame, Rocket, Boxes, ListTree,
} from 'lucide-react';
import StrategyRowWide from '@/components/StrategyRowWide';
import NavBar from '@/components/NavBar';
import BrokerSelector from '@/components/BrokerSelector';
import { usePortfolio } from '@/lib/usePortfolio';
import { useBrokerSelector } from '@/hooks/useBrokerSelector';
import { useGroupCollapse, groupByUnderlying } from '@/lib/useStrategyGroups';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

// Named type scale — keeps the file's micro font sizes consistent instead of
// scattering ad hoc text-[Npx] values (see dhan-terminal-polish skill).
const TXT_EYEBROW = 'text-[9px] font-bold uppercase tracking-[0.14em]';
const TXT_LABEL = 'text-[10px] font-semibold uppercase tracking-wide';
const TXT_CAPTION = 'text-[11px] font-semibold';
const TXT_STAT = 'text-sm font-bold font-mono tabular-nums leading-tight';

type GroupMode = 'underlying' | 'type';

/** Client-side mirror of lib/strategyRegistry.ts's LOGIC_GROUPS — kept separate because
 * that module is server-only (imports `fs`/`path`), so it can't be imported into this
 * 'use client' page. Only the display metadata lives here; `meta.logicGroup` (the key)
 * comes from the strategy itself via /api/strategies. Keys must stay in sync. */
const LOGIC_GROUPS: Record<string, { title: string; tagline: string; icon: React.ElementType; accent: string }> = {
  harvest: { title: 'Premium Harvest', tagline: 'Sell & hold — theta does the work', icon: Sprout, accent: 'emerald' },
  rotation: { title: 'Roll & Rotate', tagline: 'Exit a decaying leg into a fresh strike', icon: Repeat, accent: 'sky' },
  volatility: { title: 'Volatility Adaptive', tagline: 'Entry and hedge gated by the vol regime', icon: Activity, accent: 'violet' },
  directional: { title: 'Directional Options', tagline: 'Trend + OI-confirmed spreads and sells', icon: TrendingUp, accent: 'amber' },
  futures_trend: { title: 'Futures Trend', tagline: 'Ride MCX momentum in one direction', icon: Flame, accent: 'orange' },
  momentum: { title: 'Equity Momentum', tagline: 'Relative-strength stock rotation', icon: Rocket, accent: 'fuchsia' },
};
const OTHER_LOGIC_GROUP = { title: 'Other', tagline: 'Uncategorised', icon: Boxes, accent: 'zinc' };

const ACCENT_CLASSES: Record<string, { icon: string; iconBg: string; iconBorder: string; ring: string }> = {
  emerald: { icon: 'text-emerald-400', iconBg: 'bg-emerald-500/10', iconBorder: 'border-emerald-500/25', ring: 'hover:border-emerald-700/60' },
  sky: { icon: 'text-sky-400', iconBg: 'bg-sky-500/10', iconBorder: 'border-sky-500/25', ring: 'hover:border-sky-700/60' },
  violet: { icon: 'text-violet-400', iconBg: 'bg-violet-500/10', iconBorder: 'border-violet-500/25', ring: 'hover:border-violet-700/60' },
  amber: { icon: 'text-amber-400', iconBg: 'bg-amber-500/10', iconBorder: 'border-amber-500/25', ring: 'hover:border-amber-700/60' },
  orange: { icon: 'text-orange-400', iconBg: 'bg-orange-500/10', iconBorder: 'border-orange-500/25', ring: 'hover:border-orange-700/60' },
  fuchsia: { icon: 'text-fuchsia-400', iconBg: 'bg-fuchsia-500/10', iconBorder: 'border-fuchsia-500/25', ring: 'hover:border-fuchsia-700/60' },
  zinc: { icon: 'text-zinc-400', iconBg: 'bg-zinc-500/10', iconBorder: 'border-zinc-500/25', ring: 'hover:border-zinc-700/60' },
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

// Keep in sync with CHILD_BROKERS in components/CopyTrade.tsx and
// BROKER_CLASSES in scripts/tools/child_brokers.py.
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
  /** Per-broker init failures from the bridge — a child listed here receives
   *  no fills, however healthy the rest of the panel looks. */
  broker_failures?: Record<string, string>;
}
interface CopyTradeLogEntry {
  ts: string;
  order_no: string;
  parent_symbol?: string;
  child_symbol?: string;
  /** Legacy alias for child_symbol, still written by the bridge. */
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

/** The stored children, back-filled so every known broker has a row to render. */
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
  // 'underlying' groups by instrument exposure (NIFTY/CRUDEOILM/...); 'type' groups by
  // trading logic (Premium Harvest, Futures Trend, ...) — see LOGIC_GROUPS below.
  const [groupMode, setGroupMode] = useState<GroupMode>('underlying');

  // Groups default to open only when something inside is running, so the page opens on
  // live strategies and folds everything else away behind its index header.
  const groups = useGroupCollapse();

  // Client-side-only until the user actually launches them: instance ids the user has
  // asked to add via "+ Add run" but that have no debug/<key>_<id>_state.json yet.
  const [pendingInstances, setPendingInstances] = useState<Record<string, string[]>>({});

  // Once a pending instance shows up in a poll (it has a real state file), drop it from
  // the pending list — the real data takes over rendering that row from here on.
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

  // The 2s poll replaces `strategies` with a fresh object every tick. Reading it through a
  // ref keeps addInstance referentially stable, so the memoized rows (which compare props by
  // content) don't all re-render on every poll just because this callback was rebuilt.
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
    // The new blank config row is only visible in "all" view since it starts STOPPED.
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

  // Stable reference so memoized StrategyRowWide rows don't re-render on every poll
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
    // Drop the client-side pending entry first so a never-launched row disappears
    // immediately (it has no server-side files to delete).
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
    // addToast only touches state setters, so it is safe to omit from deps; keeping the
    // dep list stable is what preserves row memoization across the 2s poll.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchStrategies]);

  useEffect(() => {
    fetchStrategies(true);
    const iv = setInterval(() => fetchStrategies(false), 2000);
    return () => clearInterval(iv);
  }, []);

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

  /* ── Trade Replication (Dhan → Zerodha copy trading) ── */
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
    // Always POST the FULL children list: the route replaces the array wholesale,
    // so sending only the edited child would silently disable the others.
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

  /* ── Toast colors ── */
  const toastColor: Record<ToastType, string> = {
    success: 'bg-emerald-950/90 border-emerald-500/40 text-emerald-300',
    error:   'bg-red-950/90 border-red-500/40 text-red-300',
    info:    'bg-zinc-900/90 border-zinc-700/60 text-zinc-300',
  };

  const strategyList = Object.entries(strategies);

  type InstanceRow = { key: string; instanceId: string; meta: any; state: any };
  // Primary row first, then duplicates in natural order. Object key order can't be relied
  // on here: JS lists integer-like keys ("2", "10") before string keys, so the raw order
  // would put duplicate rows ABOVE the original they were cloned from.
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
  const activeList = instanceRows.filter(row => row.state?.status !== 'STOPPED');
  const displayList = viewMode === 'active' ? activeList : instanceRows;

  // Group rows by underlying. Order follows displayList, which follows the registry's key
  // order — so group order is controlled by where a strategy sits in STRATEGIES_METADATA.
  // Each row is already one instance, so a running row contributes exactly its own state.
  const groupedList = groupByUnderlying<InstanceRow>(
    displayList,
    row => row.meta?.underlying,
    row => (row.state?.status !== 'STOPPED' ? [row.state] : []),
  );

  // Same grouping helper, keyed by trading-logic type instead of instrument — the
  // "By Strategy Type" view. `groupByUnderlying` buckets a missing key under 'OTHER',
  // which OTHER_LOGIC_GROUP below renders a label for.
  const groupedByLogicList = groupByUnderlying<InstanceRow>(
    displayList,
    row => row.meta?.logicGroup,
    row => (row.state?.status !== 'STOPPED' ? [row.state] : []),
  );

  const activeGroupedList = groupMode === 'type' ? groupedByLogicList : groupedList;

  // Pin auto-opened groups so a group does not fold up the moment its last run stops.
  // Runs for both grouping dimensions — their keys never collide ('NIFTY' vs 'harvest').
  useEffect(() => {
    groups.ensureOpen(activeGroupedList.filter(g => g.runningCount > 0).map(g => g.underlying));
    // activeGroupedList is rebuilt every poll; ensureOpen no-ops once the groups are decided.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeGroupedList.map(g => `${g.underlying}:${g.runningCount > 0}`).join(','), groups]);

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-300">

      {/* ── Toast stack ── */}
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`px-4 py-2.5 rounded-lg border text-sm font-medium shadow-xl backdrop-blur-sm animate-in fade-in slide-in-from-right-4 duration-300 ${toastColor[t.type]}`}>
            {t.message}
          </div>
        ))}
      </div>

      {/* ── Identity header ── */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/90 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-md shadow-emerald-500/10 shrink-0">
            <Layers className="h-4 w-4 text-oncolor" />
          </div>
          <div>
            <p className={`${TXT_EYEBROW} text-emerald-500 leading-none mb-0.5`}>Options · Control Center</p>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">Strategies+</h1>
          </div>
        </div>

        <NavBar />

        <div className="flex items-center gap-3 ml-auto shrink-0">
          <BrokerSelector
            broker={broker}
            setBroker={setBroker}
            authenticatedBrokers={authenticatedBrokers}
          />
          {/* Live NIFTY + India VIX ticker */}
          {([
            { key: 'NIFTY', q: indexTicker?.nifty, decimals: 2 },
            { key: 'VIX', q: indexTicker?.vix, decimals: 2 },
          ] as const).map(({ key, q, decimals }) => {
            if (!q) return null;
            const chg = q.prevClose > 0 ? q.ltp - q.prevClose : 0;
            const chgPct = q.prevClose > 0 ? (chg / q.prevClose) * 100 : 0;
            const isUp = chg >= 0;
            return (
              <div key={key} className="flex items-baseline gap-2 bg-zinc-900/60 border border-zinc-800 rounded-lg px-3 py-1">
                <span className={`${TXT_LABEL} text-zinc-500`}>{key}</span>
                <span className={`${TXT_STAT} text-white`}>
                  {q.ltp.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}
                </span>
                {q.prevClose > 0 && (
                  <span className={`flex items-baseline gap-1 ${TXT_CAPTION} font-mono tabular-nums ${isUp ? 'text-emerald-400' : 'text-rose-400'}`}>
                    <span>{isUp ? '▲' : '▼'}</span>
                    <span>{Math.abs(chg).toFixed(2)}</span>
                    <span className="text-zinc-500">({isUp ? '+' : ''}{chgPct.toFixed(2)}%)</span>
                  </span>
                )}
              </div>
            );
          })}
        </div>

        <Tooltip>
          <TooltipTrigger
            render={
              <button onClick={() => fetchStrategies(true)}
                className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-500 hover:text-white hover:border-zinc-700 transition-all active:scale-95">
                <RefreshCw className="h-3.5 w-3.5" />
              </button>
            }
          />
          <TooltipContent>Refresh strategy list</TooltipContent>
        </Tooltip>
      </header>

      {/* ── Book strip: P&L / margin summary card ── */}
      <div className="w-full border-b border-zinc-900 bg-zinc-950/60 px-4 py-2.5 flex items-center justify-between gap-4 flex-wrap">

        <div className="flex items-center gap-4 flex-wrap rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-2">
          <div className="flex items-center gap-2">
            {portfolioLoading && !portfolio ? (
              <RefreshCw className="h-4 w-4 text-zinc-600 animate-spin" />
            ) : pnlPositive ? (
              <TrendingUp className="h-4 w-4 text-emerald-400" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-400" />
            )}
            <div className="flex flex-col">
              <span className={`${TXT_EYEBROW} text-zinc-500 leading-none`}>Total P&amp;L</span>
              <span className={`text-lg font-bold font-mono tabular-nums leading-tight ${
                portfolio ? (pnlPositive ? 'text-emerald-400' : 'text-red-400') : 'text-zinc-700'
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
                <span className={`${TXT_EYEBROW} text-zinc-500 leading-none`}>Realized</span>
                <span className={`${TXT_STAT} ${portfolio.total_realized_pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {portfolio.total_realized_pnl >= 0 ? '+' : ''}₹{portfolio.total_realized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <Separator orientation="vertical" className="h-8 bg-zinc-800" />
              <div className="flex flex-col">
                <span className={`${TXT_EYEBROW} text-zinc-500 leading-none`}>Unrealized</span>
                <span className={`${TXT_STAT} ${portfolio.total_unrealized_pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {portfolio.total_unrealized_pnl >= 0 ? '+' : ''}₹{portfolio.total_unrealized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <Separator orientation="vertical" className="h-8 bg-zinc-800" />
              <div className="flex flex-col">
                <span className={`${TXT_EYEBROW} text-zinc-500 leading-none`}>Margin Avail</span>
                <span className={`${TXT_STAT} text-white`}>
                  ₹{portfolio.available_funds.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <Separator orientation="vertical" className="h-8 bg-zinc-800" />
              <div className="flex flex-col">
                <span className={`${TXT_EYEBROW} text-zinc-500 leading-none`}>Positions</span>
                <span className={`${TXT_STAT} text-white`}>{portfolio.positions.length}</span>
              </div>
            </>
          )}

          <Tooltip>
            <TooltipTrigger
              render={
                <button onClick={fetchPortfolio} disabled={portfolioLoading}
                  className="p-1 rounded text-zinc-600 hover:text-zinc-300 transition-colors disabled:opacity-40">
                  <RefreshCw className={`h-3 w-3 ${portfolioLoading ? 'animate-spin' : ''}`} />
                </button>
              }
            />
            <TooltipContent>Refresh P&amp;L</TooltipContent>
          </Tooltip>

          {portfolio && !portfolio.success && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
              <span className={`${TXT_CAPTION} text-amber-400`}>
                Token expired — run <code className="font-mono bg-amber-500/10 px-0.5 rounded">login.py</code>
              </span>
            </div>
          )}
        </div>

        {/* Right: filters + safety controls */}
        <div className="flex items-center gap-2 shrink-0 flex-wrap">

          {/* P&L Guard toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowPnlGuard(v => !v)}
            className={`gap-1.5 ${TXT_CAPTION} rounded-lg ${
              showPnlGuard
                ? 'bg-amber-900/30 border-amber-600/50 text-amber-300 hover:bg-amber-900/40 hover:text-amber-200'
                : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            }`}
          >
            <Shield className="h-3 w-3" />
            P&amp;L Guard
            {pnlGuardStatus?.pnlExitStatus === 'ACTIVE' && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
            )}
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showPnlGuard ? 'rotate-180' : ''}`} />
          </Button>

          {/* Trade Replication toggle */}
          <Button
            variant="outline"
            size="sm"
            onClick={() => setShowCopyTrade(v => !v)}
            className={`gap-1.5 ${TXT_CAPTION} rounded-lg ${
              showCopyTrade
                ? 'bg-sky-900/30 border-sky-600/50 text-sky-300 hover:bg-sky-900/40 hover:text-sky-200'
                : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            }`}
          >
            <Repeat className="h-3 w-3" />
            Replication
            {copyTradeConfig.armed && (
              <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse shrink-0" title="Armed — live" />
            )}
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showCopyTrade ? 'rotate-180' : ''}`} />
          </Button>

          {/* View mode */}
          <Tabs value={viewMode} onValueChange={(v) => setViewMode(v as 'active' | 'all')}>
            <TabsList className="bg-zinc-900 border border-zinc-800">
              <TabsTrigger value="active" className="gap-1.5">
                <Zap className="h-3 w-3" />
                Active
                {runningCount > 0 && (
                  <Badge variant="secondary" className="h-4 px-1.5 bg-emerald-500/20 text-emerald-300 border-0">
                    {runningCount}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="all" className="gap-1.5">
                <LayoutList className="h-3 w-3" />
                All
                <Badge variant="secondary" className="h-4 px-1.5 bg-zinc-800 text-zinc-400 border-0">
                  {instanceRows.length}
                </Badge>
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {/* Grouping dimension: by instrument exposure, or by trading-logic type */}
          <Tabs value={groupMode} onValueChange={(v) => setGroupMode(v as GroupMode)}>
            <TabsList className="bg-zinc-900 border border-zinc-800">
              <Tooltip>
                <TooltipTrigger render={<TabsTrigger value="underlying" className="gap-1.5"><ListTree className="h-3 w-3" />Underlying</TabsTrigger>} />
                <TooltipContent>Group by instrument exposure</TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger render={<TabsTrigger value="type" className="gap-1.5"><Boxes className="h-3 w-3" />Strategy Type</TabsTrigger>} />
                <TooltipContent>Group by trading logic</TooltipContent>
              </Tooltip>
            </TabsList>
          </Tabs>

          {/* Expand / collapse every group in the active dimension */}
          <ToggleGroup variant="outline" size="sm" className="bg-zinc-900/60 border border-zinc-800 rounded-lg">
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value="expand"
                    onClick={() => groups.setAll(activeGroupedList.map(g => g.underlying), true)}
                    className="text-zinc-500 data-checked:bg-transparent"
                  >
                    <ChevronsUpDown className="h-3 w-3" />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent>Expand every group</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ToggleGroupItem
                    value="collapse"
                    onClick={() => groups.setAll(activeGroupedList.map(g => g.underlying), false)}
                    className="text-zinc-500 data-checked:bg-transparent"
                  >
                    <ChevronsDownUp className="h-3 w-3" />
                  </ToggleGroupItem>
                }
              />
              <TooltipContent>Collapse every group</TooltipContent>
            </Tooltip>
          </ToggleGroup>

          <div className="flex items-center gap-1.5 px-2">
            <Activity className={`h-3.5 w-3.5 ${runningCount > 0 ? 'text-emerald-500' : 'text-zinc-700'}`} />
            <span className={`${TXT_CAPTION} text-zinc-300`}>
              {runningCount} / {instanceRows.length} running
            </span>
          </div>

          {/* Danger dock — safety-critical actions get a hairline boundary of their own */}
          <div className="flex items-center gap-1.5 rounded-xl border border-red-950/60 bg-red-950/10 px-1.5 py-1">
            <Button
              variant="outline"
              size="sm"
              onClick={handleStopAll}
              disabled={stoppingAll || runningCount === 0}
              className={`gap-1.5 ${TXT_CAPTION} rounded-lg ${
                confirmStopAll
                  ? 'bg-orange-600/20 border-orange-500 text-orange-300 animate-pulse'
                  : stoppingAll
                  ? 'bg-zinc-900 border-zinc-700 text-zinc-500'
                  : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
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
              className={`gap-1.5 ${TXT_CAPTION} rounded-lg border ${
                exitingAll
                  ? 'bg-red-900/40 border-red-800 text-red-400'
                  : confirmExitAll
                  ? 'bg-red-600 border-red-500 text-oncolor animate-pulse shadow-lg shadow-red-500/20'
                  : 'bg-red-950/60 border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300'
              }`}
              title="Immediately liquidate ALL positions at broker level (DELETE /positions)"
            >
              {exitingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <ShieldOff className="h-3 w-3" />}
              {exitingAll ? 'Exiting…' : confirmExitAll ? 'Confirm EXIT ALL?' : 'EXIT ALL Positions'}
            </Button>
          </div>
        </div>
      </div>

      {/* ── P&L Guard Panel ── */}
      {showPnlGuard && (
        <div className="w-full border-b border-zinc-900 bg-zinc-950/60 px-4 py-3">
          <div className="flex items-center gap-4 flex-wrap rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-2.5">

            {/* Status chip */}
            <div className="flex items-center gap-2 shrink-0">
              {pnlGuardLoading ? (
                <RefreshCw className="h-3.5 w-3.5 text-zinc-600 animate-spin" />
              ) : pnlGuardStatus?.pnlExitStatus === 'ACTIVE' ? (
                <Badge className={`gap-1.5 ${TXT_CAPTION} bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-full`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                  ACTIVE
                  {pnlGuardStatus.profit ? ` ₹${pnlGuardStatus.profit.toLocaleString('en-IN')} profit` : ''}
                  {pnlGuardStatus.profit && pnlGuardStatus.loss ? ' /' : ''}
                  {pnlGuardStatus.loss ? ` ₹${pnlGuardStatus.loss.toLocaleString('en-IN')} loss` : ''}
                </Badge>
              ) : pnlGuardStatus ? (
                <Badge variant="outline" className={`${TXT_CAPTION} bg-zinc-800 border-zinc-700 text-zinc-500 rounded-full`}>
                  INACTIVE
                </Badge>
              ) : (
                <span className={`${TXT_CAPTION} text-zinc-600`}>—</span>
              )}
            </div>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            {/* Profit target */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`${TXT_LABEL} text-zinc-500`}>Profit</span>
              <div className="flex items-center gap-1">
                <span className={`${TXT_CAPTION} text-zinc-500`}>₹</span>
                <Input
                  type="number"
                  min="0"
                  value={profitValue}
                  onChange={e => setProfitValue(e.target.value)}
                  placeholder="e.g. 5000"
                  className="bg-zinc-900 border-zinc-700 text-white h-7 w-24 text-[11px] font-mono tabular-nums"
                />
              </div>
            </div>

            {/* Loss limit */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`${TXT_LABEL} text-zinc-500`}>Loss</span>
              <div className="flex items-center gap-1">
                <span className={`${TXT_CAPTION} text-zinc-500`}>₹</span>
                <Input
                  type="number"
                  min="0"
                  value={lossValue}
                  onChange={e => setLossValue(e.target.value)}
                  placeholder="e.g. 3000"
                  className="bg-zinc-900 border-zinc-700 text-white h-7 w-24 text-[11px] font-mono tabular-nums"
                />
              </div>
            </div>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            {/* Product type pills */}
            <div className="flex items-center gap-1.5 shrink-0">
              <span className={`${TXT_LABEL} text-zinc-500`}>Type</span>
              <ToggleGroup variant="outline" size="sm" spacing={0} value={productTypes}
                onValueChange={(next: string[]) => {
                  if (next.length === 0) return;
                  setProductTypes(next);
                }}>
                {(['INTRADAY', 'DELIVERY'] as const).map(pt => (
                  <ToggleGroupItem key={pt} value={pt} className={`${TXT_LABEL} px-2.5 data-checked:bg-zinc-700 data-checked:text-white data-checked:border-zinc-500 text-zinc-600 border-zinc-800`}>
                    {pt}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </div>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            {/* Kill switch toggle */}
            <label className="flex items-center gap-2 cursor-pointer shrink-0">
              <Checkbox
                checked={enableKillSwitch}
                onCheckedChange={(v) => setEnableKillSwitch(v === true)}
                className="data-checked:bg-red-600 data-checked:border-red-500 border-zinc-600"
              />
              <span className={`${TXT_LABEL} text-zinc-500`}>Kill switch on trigger</span>
            </label>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            {/* Set button */}
            <Button
              size="sm"
              onClick={handleSetPnl}
              disabled={settingPnl}
              className={`gap-1.5 ${TXT_CAPTION} rounded-lg bg-emerald-900/40 border border-emerald-700/60 text-emerald-300 hover:bg-emerald-800/40 hover:border-emerald-600`}
            >
              {settingPnl ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Shield className="h-3 w-3" />}
              {settingPnl ? 'Setting…' : 'Set Guard'}
            </Button>

            {/* Clear button */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleClearPnl}
              disabled={clearingPnl}
              className={`gap-1.5 ${TXT_CAPTION} rounded-lg ${
                confirmClear
                  ? 'bg-red-600 border-red-500 text-oncolor animate-pulse'
                  : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-500 hover:border-red-800 hover:text-red-400'
              }`}
            >
              {clearingPnl ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
              {clearingPnl ? 'Clearing…' : confirmClear ? 'Confirm Clear?' : 'Clear'}
            </Button>
          </div>
        </div>
      )}

      {/* ── Trade Replication Panel ── */}
      {showCopyTrade && (
        <div className="w-full border-b border-zinc-900 bg-zinc-950/60 px-4 py-3 flex flex-col gap-3">

          {copyTradeConfig.armed && copyTradeStatus?.status !== 'RUNNING' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/60 border border-red-800/60">
              <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
              <span className={`${TXT_CAPTION} text-red-300`}>
                Armed but the bridge is not running — the child account is NOT protected right now. Start the bridge or disarm.
              </span>
            </div>
          )}

          <div className="flex items-center gap-4 flex-wrap rounded-xl border border-zinc-800/60 bg-zinc-950/40 px-4 py-2.5">
            {/* Bridge status chip */}
            <div className="flex items-center gap-2 shrink-0">
              {copyTradeStatus?.status === 'RUNNING' ? (
                <Badge className={`gap-1.5 ${TXT_CAPTION} bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 rounded-full`}>
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                  LISTENING
                </Badge>
              ) : copyTradeStatus?.status === 'STARTING' ? (
                <Badge className={`gap-1.5 ${TXT_CAPTION} bg-amber-500/10 border border-amber-500/30 text-amber-400 rounded-full`}>
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  STARTING
                </Badge>
              ) : copyTradeStatus?.status === 'STALE' ? (
                <Badge className={`gap-1.5 ${TXT_CAPTION} bg-red-500/10 border border-red-500/30 text-red-400 rounded-full animate-pulse`}
                  title="Bridge process exists but its heartbeat stopped — it is NOT replicating. Restart it.">
                  <AlertTriangle className="h-3 w-3" />
                  STALE
                </Badge>
              ) : copyTradeStatus?.status === 'ERROR' ? (
                <Badge className={`gap-1.5 ${TXT_CAPTION} bg-red-500/10 border border-red-500/30 text-red-400 rounded-full`} title={copyTradeStatus.detail}>
                  <AlertTriangle className="h-3 w-3" />
                  ERROR
                </Badge>
              ) : (
                <Badge variant="outline" className={`${TXT_CAPTION} bg-zinc-800 border-zinc-700 text-zinc-500 rounded-full`}>
                  STOPPED
                </Badge>
              )}
            </div>

            {/* Bridge start/stop */}
            <Button
              variant="outline"
              size="sm"
              onClick={handleToggleCopyTradeBridge}
              disabled={togglingBridge}
              className={`gap-1.5 ${TXT_CAPTION} rounded-lg bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200`}
            >
              {copyTradeBridgeRunning ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {copyTradeBridgeRunning ? 'Stop Bridge' : 'Start Bridge'}
            </Button>

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            {/* One row per child account */}
            <span className={`${TXT_LABEL} text-zinc-500 shrink-0`}>Children</span>
            {withAllBrokers(copyTradeConfig.children).map(child => {
              const failure = copyTradeStatus?.broker_failures?.[child.broker];
              return (
                <div key={child.broker} className="flex items-center gap-1.5 shrink-0">
                  <Badge
                    variant="outline"
                    className={`${TXT_CAPTION} rounded-md ${
                      failure
                        ? 'bg-red-950/60 border-red-800 text-red-300'
                        : 'bg-zinc-900 border-zinc-700 text-white'
                    }`}
                    title={failure ? `Bridge could not start this child: ${failure}` : undefined}
                  >
                    {CHILD_BROKER_LABELS[child.broker]}{failure ? ' — DOWN' : ''}
                  </Badge>

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
                      title={`${CHILD_BROKER_LABELS[child.broker]} quantity multiplier`}
                      className="bg-zinc-900 border-zinc-700 text-white h-7 w-12 text-[11px] font-mono tabular-nums px-1.5"
                    />
                    <span className={`${TXT_CAPTION} text-zinc-500`}>x</span>
                  </div>

                  <div
                    onClick={() => updateCopyTradeChild(child.broker, { enabled: !child.enabled })}
                    title={child.enabled ? 'Enabled — receives replicated fills' : 'Disabled'}
                    className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                      child.enabled ? 'bg-sky-600' : 'bg-zinc-700'
                    }`}
                  >
                    <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-oncolor shadow transition-transform ${
                      child.enabled ? 'translate-x-4' : 'translate-x-0.5'
                    }`} />
                  </div>
                </div>
              );
            })}

            <Separator orientation="vertical" className="h-6 bg-zinc-800 shrink-0" />

            {/* Arm / Disarm */}
            {copyTradeConfig.armed ? (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleDisarmReplication}
                className={`gap-1.5 ${TXT_CAPTION} rounded-lg bg-red-950/60 border border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300`}
              >
                <ShieldOff className="h-3 w-3" />
                STOP Replication (Armed)
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={handleArmReplication}
                disabled={arming || !copyTradeConfig.children.some(c => c.enabled)}
                title={!copyTradeConfig.children.some(c => c.enabled) ? 'Enable at least one child account first' : undefined}
                className={`gap-1.5 ${TXT_CAPTION} rounded-lg ${
                  confirmArm
                    ? 'bg-red-600 border border-red-500 text-oncolor animate-pulse shadow-lg shadow-red-500/20'
                    : 'bg-emerald-900/40 border border-emerald-700/60 text-emerald-300 hover:bg-emerald-800/40 hover:border-emerald-600'
                }`}
              >
                {arming ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Repeat className="h-3 w-3" />}
                {arming ? 'Arming…' : confirmArm ? 'Confirm ARM?' : 'ARM Replication'}
              </Button>
            )}
          </div>

          {/* Activity feed */}
          <div className="border border-zinc-800 rounded-lg bg-zinc-950/60 max-h-40 overflow-y-auto">
            {copyTradeLog.length === 0 ? (
              <div className={`px-3 py-2 ${TXT_CAPTION} text-zinc-600`}>No replication activity yet.</div>
            ) : (
              <div className="divide-y divide-zinc-800/50">
                {[...copyTradeLog].reverse().slice(0, 30).map((entry, i) => (
                  <div key={`${entry.order_no}-${entry.ts}-${i}`} className={`flex items-center gap-2 px-3 py-1.5 ${TXT_CAPTION} font-normal`}>
                    {entry.result === 'success' || entry.result === 'safety_exit' ? (
                      <CheckCircle2 className={`h-3 w-3 shrink-0 ${entry.result === 'safety_exit' ? 'text-amber-400' : 'text-emerald-400'}`} />
                    ) : entry.result === 'error' || entry.result === 'safety_exit_error' ? (
                      <XCircle className="h-3 w-3 text-red-400 shrink-0" />
                    ) : (
                      <span className="h-3 w-3 rounded-full border border-zinc-600 shrink-0" />
                    )}
                    <span className="text-zinc-600 shrink-0 font-mono tabular-nums">
                      {new Date(entry.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    {(entry.result === 'safety_exit' || entry.result === 'safety_exit_error') && (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[10px] font-bold shrink-0">
                        <Shield className="h-2.5 w-2.5" /> SAFETY-NET
                      </span>
                    )}
                    {/* With more than one child, which broker a line refers to
                        is no longer implicit — show it. */}
                    {entry.broker && (
                      <span className="shrink-0 px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-400 text-[10px] font-bold uppercase">
                        {entry.broker}
                      </span>
                    )}
                    <span className="text-zinc-300 font-medium truncate">
                      {entry.side} {entry.child_qty ?? entry.parent_qty} {entry.child_symbol ?? entry.zerodha_symbol ?? entry.parent_symbol}
                    </span>
                    <span className={`shrink-0 ${
                      entry.result === 'success' || entry.result === 'safety_exit' ? 'text-emerald-500'
                        : entry.result === 'error' || entry.result === 'safety_exit_error' ? 'text-red-500'
                        : 'text-zinc-500'
                    }`}>
                      {entry.result === 'logged_only' ? 'logged (not armed)'
                        : entry.result === 'skipped' ? entry.error
                        : entry.result === 'safety_exit' ? 'parent flat — force-closed'
                        : entry.result}
                    </span>
                    {entry.child_order_id && (
                      <span className="text-zinc-600 truncate">→ {entry.child_order_id}</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── Main Table ── */}
      <main className="flex-1 w-full">
        {loading && strategyList.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 min-h-[260px]">
            <RefreshCw className="h-6 w-6 text-emerald-500 animate-spin" />
            <span className="text-zinc-600 text-xs mt-3">Connecting to strategy API…</span>
          </div>
        ) : error ? (
          <div className="flex flex-col items-center justify-center p-12 text-center min-h-[260px]">
            <p className="text-sm font-semibold text-red-400">Connection Failed</p>
            <p className="text-xs text-zinc-600 mt-1">{error}</p>
          </div>
        ) : viewMode === 'active' && activeList.length === 0 ? (
          <div className="flex flex-col items-center justify-center p-16 min-h-[260px] gap-3">
            <div className="h-12 w-12 rounded-full bg-zinc-900 border border-zinc-800 flex items-center justify-center">
              <Activity className="h-5 w-5 text-zinc-700" />
            </div>
            <p className="text-sm font-semibold text-zinc-500">No strategies running</p>
            <p className="text-xs text-zinc-700">Switch to <strong className="text-zinc-500">All</strong> to configure and launch a strategy</p>
            <Button
              variant="outline"
              onClick={() => setViewMode('all')}
              className="mt-1 gap-1.5 rounded-lg border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-white hover:border-zinc-600 text-xs font-semibold"
            >
              <LayoutList className="h-3.5 w-3.5" />
              Show All Strategies
            </Button>
          </div>
        ) : (
          <div className="w-full">
            {/* ── Strategy-type hub: one card per trading logic, mirrors the group headers below ── */}
            {groupMode === 'type' && (
              <div className="px-4 py-4 border-b border-zinc-900">
                <div className="flex items-baseline justify-between mb-3">
                  <div>
                    <h2 className="text-base font-bold text-white tracking-tight">
                      {activeGroupedList.length} Strategy Types
                    </h2>
                    <p className={`${TXT_CAPTION} font-normal text-zinc-500 mt-0.5`}>
                      {instanceRows.length} strateg{instanceRows.length === 1 ? 'y' : 'ies'} across {activeGroupedList.length} logic group{activeGroupedList.length === 1 ? '' : 's'}
                    </p>
                  </div>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
                  {activeGroupedList.map(({ underlying: groupKey, items: rows, runningCount: groupRunning }) => {
                    const info = LOGIC_GROUPS[groupKey] ?? OTHER_LOGIC_GROUP;
                    const a = ACCENT_CLASSES[info.accent] ?? ACCENT_CLASSES.zinc;
                    const Icon = info.icon;
                    const open = groups.isOpen(groupKey, groupRunning > 0);
                    return (
                      <button
                        key={groupKey}
                        type="button"
                        onClick={() => groups.toggle(groupKey, open)}
                        aria-expanded={open}
                        className={`group flex flex-col items-start text-left gap-2 rounded-2xl border border-zinc-800 bg-zinc-900/50 p-4 transition-colors ${a.ring}`}
                      >
                        <div className={`flex items-center justify-center w-9 h-9 rounded-lg ${a.iconBg} border ${a.iconBorder} shrink-0`}>
                          <Icon className={`h-4 w-4 ${a.icon}`} />
                        </div>
                        <h3 className="text-sm font-bold text-white tracking-tight">{info.title}</h3>
                        <p className={`${TXT_CAPTION} font-normal text-zinc-500 leading-snug -mt-1`}>{info.tagline}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`${TXT_LABEL} text-zinc-600 normal-case`}>
                            {rows.length} strateg{rows.length === 1 ? 'y' : 'ies'}
                          </span>
                          {groupRunning > 0 && (
                            <span className={`flex items-center gap-1 ${TXT_LABEL} normal-case text-emerald-400`}>
                              <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                              {groupRunning} running
                            </span>
                          )}
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Table header */}
            <div className="flex items-center gap-0 px-4 py-1.5 border-b border-zinc-800 bg-zinc-900/60 sticky top-0 z-10">
              <div className="w-[90px] shrink-0 text-xs font-bold text-white">Status</div>
              <div className="w-[240px] shrink-0 text-xs font-bold text-white">Strategy</div>
              <div className="w-px mx-2" />
              <div className="flex-1 text-xs font-bold text-white">Live Data</div>
              <div className="shrink-0 w-[80px] text-right text-xs font-bold text-white">P&amp;L</div>
              <div className="w-px mx-3" />
              <div className="shrink-0 w-[160px] text-xs font-bold text-white">Actions</div>
            </div>

            {/* Strategy rows, grouped by the active dimension (underlying or logic type) */}
            {activeGroupedList.map(({ underlying: groupKey, items: rows, runningCount: groupRunning }) => {
              const open = groups.isOpen(groupKey, groupRunning > 0);
              const typeInfo = groupMode === 'type' ? (LOGIC_GROUPS[groupKey] ?? OTHER_LOGIC_GROUP) : null;
              return (
                <div key={groupKey}>
                  <button
                    type="button"
                    onClick={() => groups.toggle(groupKey, open)}
                    aria-expanded={open}
                    className="w-full flex items-center gap-2 px-4 py-1.5 bg-zinc-900 border-y border-zinc-800 text-left hover:bg-zinc-800/70 transition-colors"
                  >
                    {open
                      ? <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" />
                      : <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />}
                    <span className="text-xs font-bold text-white tracking-wide">{typeInfo ? typeInfo.title : groupKey}</span>
                    {typeInfo && (
                      <span className={`${TXT_CAPTION} font-normal text-zinc-500 hidden sm:inline`}>{typeInfo.tagline}</span>
                    )}
                    <span className={`${TXT_LABEL} text-zinc-500 normal-case`}>
                      {rows.length} strateg{rows.length === 1 ? 'y' : 'ies'}
                    </span>
                    {groupRunning > 0 && (
                      <span className={`flex items-center gap-1 ${TXT_LABEL} normal-case text-emerald-400`}>
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse" />
                        {groupRunning} running
                      </span>
                    )}
                  </button>
                  {open && (
                    <div className="divide-y divide-zinc-800/30">
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

            {/* "All" mode: hint to switch to active when strategies are running */}
            {viewMode === 'all' && runningCount > 0 && (
              <div className="px-4 py-2.5 border-t border-zinc-800/40 bg-zinc-950/40 flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse shrink-0" />
                <span className="text-[10px] text-zinc-500">
                  {runningCount} strateg{runningCount === 1 ? 'y' : 'ies'} running —{' '}
                  <button onClick={() => setViewMode('active')} className="text-emerald-400 hover:text-emerald-300 font-semibold underline underline-offset-2">
                    switch to Active view
                  </button>
                </span>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
