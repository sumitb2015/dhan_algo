'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  Layers, RefreshCw, TrendingUp, TrendingDown, AlertTriangle,
  Power, ShieldOff, Activity, Zap, LayoutList, ChevronDown, Shield,
  Repeat, CheckCircle2, XCircle, Play, Square
} from 'lucide-react';
import StrategyRowWide from '@/components/StrategyRowWide';
import NavBar from '@/components/NavBar';

interface PortfolioData {
  success: boolean;
  available_funds: number;
  total_realized_pnl: number;
  total_unrealized_pnl: number;
  total_pnl: number;
  positions: any[];
  error?: string;
}

type ToastType = 'success' | 'error' | 'info';
interface Toast { id: number; type: ToastType; message: string }

interface PnlGuardStatus {
  pnlExitStatus: 'ACTIVE' | 'INACTIVE' | string;
  profit?: number;
  loss?: number;
  productType?: string[];
  enableKillSwitch?: boolean;
}

interface CopyTradeChild {
  broker: 'zerodha';
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
}
interface CopyTradeLogEntry {
  ts: string;
  order_no: string;
  parent_symbol?: string;
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

const DEFAULT_COPY_TRADE_CHILD: CopyTradeChild = { broker: 'zerodha', multiplier: 1, enabled: false };

let toastCounter = 0;

export default function StrategiesPlusPage() {
  const [strategies, setStrategies] = useState<Record<string, any>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [portfolio, setPortfolio] = useState<PortfolioData | null>(null);
  const [portfolioLoading, setPortfolioLoading] = useState(false);

  const [confirmStopAll, setConfirmStopAll] = useState(false);
  const [stoppingAll, setStoppingAll] = useState(false);

  const [confirmExitAll, setConfirmExitAll] = useState(false);
  const [exitingAll, setExitingAll] = useState(false);

  const [viewMode, setViewMode] = useState<'active' | 'all'>('active');

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
  const [copyTradeConfig, setCopyTradeConfig] = useState<CopyTradeConfig>({ armed: false, children: [DEFAULT_COPY_TRADE_CHILD] });
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

  const fetchPortfolio = useCallback(async () => {
    setPortfolioLoading(true);
    try {
      const res = await fetch('/api/portfolio');
      const data = await res.json();
      setPortfolio(data);
    } catch {
      setPortfolio(null);
    } finally {
      setPortfolioLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStrategies(true);
    const iv = setInterval(() => fetchStrategies(false), 2000);
    return () => clearInterval(iv);
  }, []);

  useEffect(() => {
    fetchPortfolio();
    const iv = setInterval(fetchPortfolio, 20000);
    return () => clearInterval(iv);
  }, [fetchPortfolio]);

  useEffect(() => {
    if (showPnlGuard) fetchPnlGuardStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPnlGuard]);

  const runningCount = Object.values(strategies).filter((s: any) => s.state?.status !== 'STOPPED').length;
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
          children: data.config.children?.length ? data.config.children : [DEFAULT_COPY_TRADE_CHILD],
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

  const updateCopyTradeChild = async (patch: Partial<CopyTradeChild>) => {
    const nextChild = { ...copyTradeConfig.children[0], ...patch };
    setCopyTradeConfig(prev => ({ ...prev, children: [nextChild] }));
    try {
      const res = await fetch('/api/copy-trade/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ children: [nextChild] }),
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
  const activeList = strategyList.filter(([, item]) => item.state?.status !== 'STOPPED');
  const displayList = viewMode === 'active' ? activeList : strategyList;

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

      {/* ── Header ── */}
      <header className="w-full border-b border-zinc-900 bg-zinc-950/80 backdrop-blur-md px-4 py-2.5 flex items-center gap-4 z-20 flex-wrap">
        <div className="flex items-center gap-2.5 shrink-0">
          <div className="h-8 w-8 rounded-lg bg-gradient-to-tr from-emerald-600 to-teal-400 flex items-center justify-center shadow-md shadow-emerald-500/10 shrink-0">
            <Layers className="h-4 w-4 text-white" />
          </div>
          <div>
            <h1 className="text-sm font-bold tracking-tight text-white leading-none">
              Dhan Algo — Strategies+
            </h1>
            <p className="text-[10px] text-zinc-500 mt-0.5">Wide-format Automated Options Control Center</p>
          </div>
        </div>

        <NavBar />

        <button onClick={() => fetchStrategies(true)}
          className="p-1.5 border border-zinc-800 rounded-lg bg-zinc-900/40 text-zinc-500 hover:text-white hover:border-zinc-700 transition-all active:scale-95 ml-auto"
          title="Refresh">
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </header>

      {/* ── Stats + Control bar ── */}
      <div className="w-full border-b border-zinc-900 bg-zinc-950/60 px-4 py-2.5 flex items-center justify-between gap-4 flex-wrap">

        {/* Left: P&L metrics */}
        <div className="flex items-center gap-4 flex-wrap">
          <div className="flex items-center gap-2">
            {portfolioLoading && !portfolio ? (
              <RefreshCw className="h-3.5 w-3.5 text-zinc-600 animate-spin" />
            ) : pnlPositive ? (
              <TrendingUp className="h-5 w-5 text-emerald-400" />
            ) : (
              <TrendingDown className="h-5 w-5 text-red-400" />
            )}
            <div className="flex flex-col">
              <span className="text-[9px] text-zinc-400 uppercase tracking-wider font-semibold leading-none">Total P&L</span>
              <span className={`text-lg font-bold tabular-nums leading-tight ${
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
              <div className="h-8 w-px bg-zinc-800" />
              <div className="flex flex-col">
                <span className="text-[9px] text-zinc-400 uppercase tracking-wider font-semibold leading-none">Realized</span>
                <span className={`text-sm font-bold tabular-nums ${portfolio.total_realized_pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {portfolio.total_realized_pnl >= 0 ? '+' : ''}₹{portfolio.total_realized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <div className="h-8 w-px bg-zinc-800" />
              <div className="flex flex-col">
                <span className="text-[9px] text-zinc-400 uppercase tracking-wider font-semibold leading-none">Unrealized</span>
                <span className={`text-sm font-bold tabular-nums ${portfolio.total_unrealized_pnl >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                  {portfolio.total_unrealized_pnl >= 0 ? '+' : ''}₹{portfolio.total_unrealized_pnl.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <div className="h-8 w-px bg-zinc-800" />
              <div className="flex flex-col">
                <span className="text-[9px] text-zinc-400 uppercase tracking-wider font-semibold leading-none">Margin Avail</span>
                <span className="text-sm font-bold text-white tabular-nums">
                  ₹{portfolio.available_funds.toLocaleString('en-IN', { minimumFractionDigits: 0 })}
                </span>
              </div>
              <div className="h-8 w-px bg-zinc-800" />
              <div className="flex flex-col">
                <span className="text-[9px] text-zinc-400 uppercase tracking-wider font-semibold leading-none">Positions</span>
                <span className="text-sm font-bold text-white">{portfolio.positions.length}</span>
              </div>
            </>
          )}

          <button onClick={fetchPortfolio} disabled={portfolioLoading}
            className="p-1 rounded text-zinc-700 hover:text-zinc-400 transition-colors disabled:opacity-40" title="Refresh P&L">
            <RefreshCw className={`h-3 w-3 ${portfolioLoading ? 'animate-spin' : ''}`} />
          </button>

          {portfolio && !portfolio.success && (
            <div className="flex items-center gap-1.5 px-2 py-1 rounded-md bg-amber-500/10 border border-amber-500/30">
              <AlertTriangle className="h-3 w-3 text-amber-400 shrink-0" />
              <span className="text-[10px] text-amber-400 font-medium">
                Token expired — run <code className="font-mono bg-amber-500/10 px-0.5 rounded">login.py</code>
              </span>
            </div>
          )}
        </div>

        {/* Right: view tabs + running count + control buttons */}
        <div className="flex items-center gap-2 shrink-0">

          {/* P&L Guard toggle */}
          <button
            onClick={() => setShowPnlGuard(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 ${
              showPnlGuard
                ? 'bg-amber-900/30 border-amber-600/50 text-amber-300'
                : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            }`}
            title="Configure automatic P&L-based exit"
          >
            <Shield className="h-3 w-3" />
            P&L Guard
            {pnlGuardStatus?.pnlExitStatus === 'ACTIVE' && (
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
            )}
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showPnlGuard ? 'rotate-180' : ''}`} />
          </button>

          {/* Trade Replication toggle */}
          <button
            onClick={() => setShowCopyTrade(v => !v)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 ${
              showCopyTrade
                ? 'bg-sky-900/30 border-sky-600/50 text-sky-300'
                : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            }`}
            title="Replicate Dhan trades to child accounts"
          >
            <Repeat className="h-3 w-3" />
            Replication
            {copyTradeConfig.armed && (
              <span className="h-1.5 w-1.5 rounded-full bg-red-400 animate-pulse shrink-0" title="Armed — live" />
            )}
            <ChevronDown className={`h-3 w-3 transition-transform duration-200 ${showCopyTrade ? 'rotate-180' : ''}`} />
          </button>

          {/* View mode tabs */}
          <div className="flex items-center rounded-lg border border-zinc-800 bg-zinc-900/60 p-0.5 gap-0.5">
            <button
              onClick={() => setViewMode('active')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-bold transition-all ${
                viewMode === 'active'
                  ? 'bg-emerald-600/20 text-emerald-300 border border-emerald-500/30'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Zap className={`h-3 w-3 ${viewMode === 'active' ? 'text-emerald-400' : ''}`} />
              Active
              {runningCount > 0 && (
                <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold leading-none ${
                  viewMode === 'active' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-800 text-zinc-400'
                }`}>{runningCount}</span>
              )}
            </button>
            <button
              onClick={() => setViewMode('all')}
              className={`flex items-center gap-1.5 px-3 py-1 rounded-md text-[11px] font-bold transition-all ${
                viewMode === 'all'
                  ? 'bg-zinc-700/40 text-white border border-zinc-600/40'
                  : 'text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <LayoutList className="h-3 w-3" />
              All
              <span className={`px-1.5 py-0.5 rounded-full text-[9px] font-bold leading-none ${
                viewMode === 'all' ? 'bg-zinc-700 text-zinc-200' : 'bg-zinc-800 text-zinc-500'
              }`}>{strategyList.length}</span>
            </button>
          </div>

          <div className="flex items-center gap-1.5 mr-1">
            <Activity className={`h-3.5 w-3.5 ${runningCount > 0 ? 'text-emerald-500' : 'text-zinc-700'}`} />
            <span className="text-xs font-semibold text-zinc-300">
              {runningCount} / {strategyList.length} running
            </span>
          </div>

          {/* Stop All — graceful */}
          <button onClick={handleStopAll} disabled={stoppingAll || runningCount === 0}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
              confirmStopAll
                ? 'bg-orange-600/20 border-orange-500 text-orange-300 animate-pulse'
                : stoppingAll
                ? 'bg-zinc-900 border-zinc-700 text-zinc-500'
                : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200'
            }`}
            title="Gracefully stop all running strategies (write shutdown triggers)">
            {stoppingAll ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Power className="h-3 w-3" />}
            {stoppingAll ? 'Stopping…' : confirmStopAll ? 'Confirm Stop All?' : 'Stop All'}
          </button>

          {/* Exit ALL — nuclear broker exit */}
          <button onClick={handleExitAll} disabled={exitingAll}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
              exitingAll
                ? 'bg-red-900/40 border-red-800 text-red-400'
                : confirmExitAll
                ? 'bg-red-600 border-red-500 text-white animate-pulse shadow-lg shadow-red-500/20'
                : 'bg-red-950/60 border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300'
            }`}
            title="Immediately liquidate ALL positions at broker level (DELETE /positions)">
            {exitingAll ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <ShieldOff className="h-3 w-3" />
            )}
            {exitingAll ? 'Exiting…' : confirmExitAll ? 'Confirm EXIT ALL?' : 'EXIT ALL Positions'}
          </button>
        </div>
      </div>

      {/* ── P&L Guard Panel ── */}
      {showPnlGuard && (
        <div className="w-full border-b border-zinc-900 bg-zinc-950/60 px-4 py-3 flex items-center gap-4 flex-wrap">

          {/* Status chip */}
          <div className="flex items-center gap-2 shrink-0">
            {pnlGuardLoading ? (
              <RefreshCw className="h-3.5 w-3.5 text-zinc-600 animate-spin" />
            ) : pnlGuardStatus?.pnlExitStatus === 'ACTIVE' ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-bold">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                ACTIVE
                {pnlGuardStatus.profit ? ` ₹${pnlGuardStatus.profit.toLocaleString('en-IN')} profit` : ''}
                {pnlGuardStatus.profit && pnlGuardStatus.loss ? ' /' : ''}
                {pnlGuardStatus.loss ? ` ₹${pnlGuardStatus.loss.toLocaleString('en-IN')} loss` : ''}
              </span>
            ) : pnlGuardStatus ? (
              <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-500 text-[11px] font-bold">
                INACTIVE
              </span>
            ) : (
              <span className="text-[11px] text-zinc-600">—</span>
            )}
          </div>

          <div className="h-6 w-px bg-zinc-800 shrink-0" />

          {/* Profit target */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Profit</span>
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1">
              <span className="text-[11px] text-zinc-500">₹</span>
              <input
                type="number"
                min="0"
                value={profitValue}
                onChange={e => setProfitValue(e.target.value)}
                placeholder="e.g. 5000"
                className="bg-transparent text-[11px] text-white w-24 outline-none placeholder-zinc-700 tabular-nums"
              />
            </div>
          </div>

          {/* Loss limit */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Loss</span>
            <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1">
              <span className="text-[11px] text-zinc-500">₹</span>
              <input
                type="number"
                min="0"
                value={lossValue}
                onChange={e => setLossValue(e.target.value)}
                placeholder="e.g. 3000"
                className="bg-transparent text-[11px] text-white w-24 outline-none placeholder-zinc-700 tabular-nums"
              />
            </div>
          </div>

          <div className="h-6 w-px bg-zinc-800 shrink-0" />

          {/* Product type pills */}
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Type</span>
            {(['INTRADAY', 'DELIVERY'] as const).map(pt => {
              const selected = productTypes.includes(pt);
              return (
                <button
                  key={pt}
                  onClick={() => {
                    if (selected && productTypes.length === 1) return;
                    setProductTypes(prev =>
                      selected ? prev.filter(x => x !== pt) : [...prev, pt]
                    );
                  }}
                  className={`px-2.5 py-1 rounded-md text-[10px] font-bold border transition-all ${
                    selected
                      ? 'bg-zinc-700 border-zinc-500 text-white'
                      : 'bg-zinc-900/40 border-zinc-800 text-zinc-600 hover:border-zinc-700 hover:text-zinc-400'
                  }`}
                >
                  {pt}
                </button>
              );
            })}
          </div>

          <div className="h-6 w-px bg-zinc-800 shrink-0" />

          {/* Kill switch toggle */}
          <label className="flex items-center gap-2 cursor-pointer shrink-0">
            <div
              onClick={() => setEnableKillSwitch(v => !v)}
              className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                enableKillSwitch ? 'bg-red-600' : 'bg-zinc-700'
              }`}
            >
              <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${
                enableKillSwitch ? 'translate-x-4' : 'translate-x-0.5'
              }`} />
            </div>
            <span className="text-[10px] text-zinc-500 font-semibold">Kill switch on trigger</span>
          </label>

          <div className="h-6 w-px bg-zinc-800 shrink-0" />

          {/* Set button */}
          <button
            onClick={handleSetPnl}
            disabled={settingPnl}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed bg-emerald-900/40 border-emerald-700/60 text-emerald-300 hover:bg-emerald-800/40 hover:border-emerald-600"
          >
            {settingPnl ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Shield className="h-3 w-3" />}
            {settingPnl ? 'Setting…' : 'Set Guard'}
          </button>

          {/* Clear button */}
          <button
            onClick={handleClearPnl}
            disabled={clearingPnl}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
              confirmClear
                ? 'bg-red-600 border-red-500 text-white animate-pulse'
                : 'bg-zinc-900/60 border-zinc-700/60 text-zinc-500 hover:border-red-800 hover:text-red-400'
            }`}
          >
            {clearingPnl ? <RefreshCw className="h-3 w-3 animate-spin" /> : null}
            {clearingPnl ? 'Clearing…' : confirmClear ? 'Confirm Clear?' : 'Clear'}
          </button>
        </div>
      )}

      {/* ── Trade Replication Panel ── */}
      {showCopyTrade && (
        <div className="w-full border-b border-zinc-900 bg-zinc-950/60 px-4 py-3 flex flex-col gap-3">

          {copyTradeConfig.armed && copyTradeStatus?.status !== 'RUNNING' && (
            <div className="flex items-center gap-2 px-3 py-2 rounded-lg bg-red-950/60 border border-red-800/60">
              <AlertTriangle className="h-3.5 w-3.5 text-red-400 shrink-0" />
              <span className="text-[11px] text-red-300 font-semibold">
                Armed but the bridge is not running — the child account is NOT protected right now. Start the bridge or disarm.
              </span>
            </div>
          )}

          <div className="flex items-center gap-4 flex-wrap">
            {/* Bridge status chip */}
            <div className="flex items-center gap-2 shrink-0">
              {copyTradeStatus?.status === 'RUNNING' ? (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 text-[11px] font-bold">
                  <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shrink-0" />
                  LISTENING
                </span>
              ) : copyTradeStatus?.status === 'STARTING' ? (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[11px] font-bold">
                  <RefreshCw className="h-3 w-3 animate-spin" />
                  STARTING
                </span>
              ) : copyTradeStatus?.status === 'ERROR' ? (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-500/10 border border-red-500/30 text-red-400 text-[11px] font-bold" title={copyTradeStatus.detail}>
                  <AlertTriangle className="h-3 w-3" />
                  ERROR
                </span>
              ) : (
                <span className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-zinc-800 border border-zinc-700 text-zinc-500 text-[11px] font-bold">
                  STOPPED
                </span>
              )}
            </div>

            {/* Bridge start/stop */}
            <button
              onClick={handleToggleCopyTradeBridge}
              disabled={togglingBridge}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 bg-zinc-900/60 border-zinc-700/60 text-zinc-400 hover:border-zinc-600 hover:text-zinc-200"
            >
              {copyTradeBridgeRunning ? <Square className="h-3 w-3" /> : <Play className="h-3 w-3" />}
              {copyTradeBridgeRunning ? 'Stop Bridge' : 'Start Bridge'}
            </button>

            <div className="h-6 w-px bg-zinc-800 shrink-0" />

            {/* Child account row */}
            <div className="flex items-center gap-2 shrink-0">
              <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Child</span>
              <span className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-700 text-[11px] text-white font-semibold">Zerodha</span>
            </div>

            <div className="flex items-center gap-1.5 shrink-0">
              <span className="text-[10px] text-zinc-500 font-semibold uppercase tracking-wider">Multiplier</span>
              <div className="flex items-center gap-1 bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1">
                <input
                  type="number"
                  min="1"
                  step="1"
                  value={copyTradeConfig.children[0]?.multiplier ?? 1}
                  onChange={e => {
                    const n = parseInt(e.target.value, 10);
                    if (Number.isInteger(n) && n > 0) updateCopyTradeChild({ multiplier: n });
                  }}
                  className="bg-transparent text-[11px] text-white w-12 outline-none tabular-nums"
                />
                <span className="text-[11px] text-zinc-500">x</span>
              </div>
            </div>

            <label className="flex items-center gap-2 cursor-pointer shrink-0">
              <div
                onClick={() => updateCopyTradeChild({ enabled: !copyTradeConfig.children[0]?.enabled })}
                className={`relative w-8 h-4 rounded-full transition-colors cursor-pointer ${
                  copyTradeConfig.children[0]?.enabled ? 'bg-sky-600' : 'bg-zinc-700'
                }`}
              >
                <div className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${
                  copyTradeConfig.children[0]?.enabled ? 'translate-x-4' : 'translate-x-0.5'
                }`} />
              </div>
              <span className="text-[10px] text-zinc-500 font-semibold">Enabled</span>
            </label>

            <div className="h-6 w-px bg-zinc-800 shrink-0" />

            {/* Arm / Disarm */}
            {copyTradeConfig.armed ? (
              <button
                onClick={handleDisarmReplication}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 bg-red-950/60 border-red-900/60 text-red-400 hover:bg-red-900/40 hover:border-red-700 hover:text-red-300"
              >
                <ShieldOff className="h-3 w-3" />
                STOP Replication (Armed)
              </button>
            ) : (
              <button
                onClick={handleArmReplication}
                disabled={arming || !copyTradeConfig.children[0]?.enabled}
                title={!copyTradeConfig.children[0]?.enabled ? 'Enable at least one child account first' : undefined}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11px] font-bold border transition-all active:scale-95 disabled:opacity-40 disabled:cursor-not-allowed ${
                  confirmArm
                    ? 'bg-red-600 border-red-500 text-white animate-pulse shadow-lg shadow-red-500/20'
                    : 'bg-emerald-900/40 border-emerald-700/60 text-emerald-300 hover:bg-emerald-800/40 hover:border-emerald-600'
                }`}
              >
                {arming ? <RefreshCw className="h-3 w-3 animate-spin" /> : <Repeat className="h-3 w-3" />}
                {arming ? 'Arming…' : confirmArm ? 'Confirm ARM?' : 'ARM Replication'}
              </button>
            )}
          </div>

          {/* Activity feed */}
          <div className="border border-zinc-800 rounded-lg bg-zinc-950/60 max-h-40 overflow-y-auto">
            {copyTradeLog.length === 0 ? (
              <div className="px-3 py-2 text-[11px] text-zinc-600">No replication activity yet.</div>
            ) : (
              <div className="divide-y divide-zinc-800/50">
                {[...copyTradeLog].reverse().slice(0, 30).map((entry, i) => (
                  <div key={`${entry.order_no}-${entry.ts}-${i}`} className="flex items-center gap-2 px-3 py-1.5 text-[11px]">
                    {entry.result === 'success' || entry.result === 'safety_exit' ? (
                      <CheckCircle2 className={`h-3 w-3 shrink-0 ${entry.result === 'safety_exit' ? 'text-amber-400' : 'text-emerald-400'}`} />
                    ) : entry.result === 'error' || entry.result === 'safety_exit_error' ? (
                      <XCircle className="h-3 w-3 text-red-400 shrink-0" />
                    ) : (
                      <span className="h-3 w-3 rounded-full border border-zinc-600 shrink-0" />
                    )}
                    <span className="text-zinc-600 shrink-0 tabular-nums">
                      {new Date(entry.ts).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    </span>
                    {(entry.result === 'safety_exit' || entry.result === 'safety_exit_error') && (
                      <span className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-400 text-[10px] font-bold shrink-0">
                        <Shield className="h-2.5 w-2.5" /> SAFETY-NET
                      </span>
                    )}
                    <span className="text-zinc-300 font-medium truncate">
                      {entry.side} {entry.child_qty ?? entry.parent_qty} {entry.zerodha_symbol ?? entry.parent_symbol}
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
            <button
              onClick={() => setViewMode('all')}
              className="mt-1 flex items-center gap-1.5 px-4 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-400 hover:text-white hover:border-zinc-600 text-xs font-semibold transition-all"
            >
              <LayoutList className="h-3.5 w-3.5" />
              Show All Strategies
            </button>
          </div>
        ) : (
          <div className="w-full">
            {/* Table header */}
            <div className="flex items-center gap-0 px-4 py-1.5 border-b border-zinc-800 bg-zinc-900/60 sticky top-0 z-10">
              <div className="w-[90px] shrink-0 text-xs font-bold text-white">Status</div>
              <div className="w-[240px] shrink-0 text-xs font-bold text-white">Strategy</div>
              <div className="w-px mx-2" />
              <div className="flex-1 text-xs font-bold text-white">Live Data</div>
              <div className="shrink-0 w-[80px] text-right text-xs font-bold text-white">P&L</div>
              <div className="w-px mx-3" />
              <div className="shrink-0 w-[160px] text-xs font-bold text-white">Actions</div>
            </div>

            {/* Strategy rows */}
            <div className="divide-y divide-zinc-800/30">
              {displayList.map(([key, item]) => (
                <StrategyRowWide
                  key={key}
                  meta={item.meta}
                  state={item.state}
                  onRefresh={fetchStrategies}
                />
              ))}
            </div>

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
