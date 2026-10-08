'use client';

import React, { useState, useMemo, useEffect, useCallback } from 'react';
import Link from 'next/link';
import {
  TrendingUp,
  TrendingDown,
  Activity,
  Search,
  Plus,
  Trash2,
  Edit2,
  RefreshCw,
  ExternalLink,
  Layers,
  Star,
  Check,
  X,
  SlidersHorizontal,
  ChevronUp,
  ChevronDown,
  ArrowUpRight,
  ArrowDownRight,
  Zap,
  Globe,
  Clock,
  Gauge,
  Sparkles,
} from 'lucide-react';
import { useDailyMarketWS, DailyMarketQuote } from '@/lib/useDailyMarketWS';
import NavBar from './NavBar';
import { istDateIso, isRegularSession, isNseTradingDay } from '@/lib/nseHolidays';

interface CustomTab {
  id: string;
  name: string;
  symbols: string[];
}

const STORAGE_KEY = 'daily_market_custom_tabs_v1';

type TabKey = 'nifty50' | 'banknifty' | 'nifty500' | 'next50' | 'midcap150' | 'smallcap250' | string;

type SortField =
  | 'symbol'
  | 'ltp'
  | 'change'
  | 'change_pct'
  | 'prev_close'
  | 'open'
  | 'high'
  | 'low'
  | 'vwap'
  | 'volume'
  | 'turnover_cr'
  | 'high_52w';

type SortDirection = 'asc' | 'desc';

type FilterDirection = 'all' | 'gainers' | 'losers' | 'near52h' | 'near52l';

export default function DailyMarketTerminal() {
  const {
    quotes,
    flashMap,
    wsStatus,
    transport,
    lastTickTime,
    wsPort,
    bridgeStatus,
    indexConstituents,
    isLoading,
    startBridge,
    stopBridge,
  } = useDailyMarketWS();

  // ── Tab Management ──────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabKey>('nifty50');
  const [customTabs, setCustomTabs] = useState<CustomTab[]>([]);
  const [isCreatingTab, setIsCreatingTab] = useState(false);
  const [newTabName, setNewTabName] = useState('');
  const [isRenamingTabId, setIsRenamingTabId] = useState<string | null>(null);
  const [renameTabName, setRenameTabName] = useState('');

  // ── Stock Picker Modal for Custom Tab ──────────────────────────────────────
  const [isAddingStock, setIsAddingStock] = useState(false);
  const [stockSearchQuery, setStockSearchQuery] = useState('');

  // ── Filters & Sorting ──────────────────────────────────────────────────────
  const [searchQuery, setSearchQuery] = useState('');
  const [industryFilter, setIndustryFilter] = useState('ALL');
  const [dirFilter, setDirFilter] = useState<FilterDirection>('all');
  const [sortField, setSortField] = useState<SortField>('change_pct');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [pageSize, setPageSize] = useState<number>(100);
  const [currentPage, setCurrentPage] = useState<number>(1);

  // ── IST Clock ──────────────────────────────────────────────────────────────
  const [istTime, setIstTime] = useState<string>('');
  const [isMarketOpen, setIsMarketOpen] = useState<boolean>(false);
  // Diwali Muhurat day: a one-hour evening session whose time isn't in the calendar, so don't guess OPEN/CLOSED.
  const [isMuhurat, setIsMuhurat] = useState<boolean>(false);

  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      // IST is UTC+5:30
      const istString = now.toLocaleTimeString('en-IN', {
        timeZone: 'Asia/Kolkata',
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      });
      setIstTime(istString);

      const istHours = Number(istString.split(':')[0]);
      const istMins = Number(istString.split(':')[1]);
      const currentMins = istHours * 60 + istMins;
      // IST calendar day (not the browser's) and the shared NSE holiday calendar.
      const iso = istDateIso(now);
      setIsMuhurat(isNseTradingDay(iso) && !isRegularSession(iso));
      setIsMarketOpen(
        isRegularSession(iso) && currentMins >= 9 * 60 + 15 && currentMins <= 15 * 60 + 30
      );
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // ── F1/F2/F3 function keys switch the system tabs ──────────────────────────
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tab = e.key === 'F1' ? 'nifty50' : e.key === 'F2' ? 'banknifty' : e.key === 'F3' ? 'nifty500' : e.key === 'F4' ? 'next50' : e.key === 'F5' ? 'midcap150' : e.key === 'F6' ? 'smallcap250' : null;
      if (!tab || e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      e.preventDefault();
      setActiveTab(tab);
      setCurrentPage(1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ── Load Custom Tabs from localStorage ─────────────────────────────────────
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setCustomTabs(parsed);
        }
      } else {
        // Initial default custom watchlist
        const defaultWatchlist: CustomTab = {
          id: 'custom_default',
          name: 'Core Watchlist',
          symbols: ['RELIANCE', 'HDFCBANK', 'ICICIBANK', 'INFY', 'TCS', 'BHARTIARTL', 'LT', 'SBIN'],
        };
        setCustomTabs([defaultWatchlist]);
        localStorage.setItem(STORAGE_KEY, JSON.stringify([defaultWatchlist]));
      }
    } catch {
      // ignore
    }
  }, []);

  // ── Save Custom Tabs to localStorage ───────────────────────────────────────
  const saveCustomTabs = useCallback((tabs: CustomTab[]) => {
    setCustomTabs(tabs);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs));
    } catch {
      // ignore
    }
  }, []);

  // ── Custom Tab Operations ──────────────────────────────────────────────────
  const handleCreateTab = useCallback(() => {
    const name = newTabName.trim();
    if (!name) return;
    const newTab: CustomTab = {
      id: `custom_${Date.now()}`,
      name,
      symbols: [],
    };
    const updated = [...customTabs, newTab];
    saveCustomTabs(updated);
    setActiveTab(newTab.id);
    setNewTabName('');
    setIsCreatingTab(false);
  }, [newTabName, customTabs, saveCustomTabs]);

  const handleDeleteTab = useCallback(
    (tabId: string) => {
      const updated = customTabs.filter((t) => t.id !== tabId);
      saveCustomTabs(updated);
      if (activeTab === tabId) {
        setActiveTab('nifty50');
      }
    },
    [customTabs, activeTab, saveCustomTabs]
  );

  const handleRenameTab = useCallback(
    (tabId: string) => {
      const name = renameTabName.trim();
      if (!name) return;
      const updated = customTabs.map((t) => (t.id === tabId ? { ...t, name } : t));
      saveCustomTabs(updated);
      setIsRenamingTabId(null);
      setRenameTabName('');
    },
    [renameTabName, customTabs, saveCustomTabs]
  );

  const handleAddStockToTab = useCallback(
    (symbol: string) => {
      if (!activeTab.startsWith('custom_')) return;
      const updated = customTabs.map((t) => {
        if (t.id === activeTab) {
          if (!t.symbols.includes(symbol)) {
            return { ...t, symbols: [...t.symbols, symbol] };
          }
        }
        return t;
      });
      saveCustomTabs(updated);
    },
    [activeTab, customTabs, saveCustomTabs]
  );

  const handleRemoveStockFromTab = useCallback(
    (symbol: string) => {
      if (!activeTab.startsWith('custom_')) return;
      const updated = customTabs.map((t) => {
        if (t.id === activeTab) {
          return { ...t, symbols: t.symbols.filter((s) => s !== symbol) };
        }
        return t;
      });
      saveCustomTabs(updated);
    },
    [activeTab, customTabs, saveCustomTabs]
  );

  // ── Active Tab Symbols Universe ────────────────────────────────────────────
  const activeSymbols = useMemo<string[]>(() => {
    if (activeTab === 'nifty50') {
      return indexConstituents.nifty50.length > 0
        ? indexConstituents.nifty50
        : Object.keys(quotes).slice(0, 50);
    }
    if (activeTab === 'banknifty') {
      return indexConstituents.banknifty.length > 0
        ? indexConstituents.banknifty
        : ['HDFCBANK', 'ICICIBANK', 'SBIN', 'KOTAKBANK', 'AXISBANK'];
    }
    if (activeTab === 'nifty500') {
      return indexConstituents.nifty500.length > 0
        ? indexConstituents.nifty500
        : Object.keys(quotes);
    }
    if (activeTab === 'next50') {
      return indexConstituents.next50;
    }
    if (activeTab === 'midcap150') {
      return indexConstituents.midcap150;
    }
    if (activeTab === 'smallcap250') {
      return indexConstituents.smallcap250;
    }
    // Custom Tab
    const custom = customTabs.find((t) => t.id === activeTab);
    return custom ? custom.symbols : [];
  }, [activeTab, indexConstituents, quotes, customTabs]);

  // ── Industries Set for Active Universe ─────────────────────────────────────
  const availableIndustries = useMemo<string[]>(() => {
    const set = new Set<string>();
    for (const sym of activeSymbols) {
      const q = quotes[sym];
      if (q && q.industry) set.add(q.industry);
    }
    return Array.from(set).sort();
  }, [activeSymbols, quotes]);

  // ── Raw Rows for Active Tab ────────────────────────────────────────────────
  const activeRows = useMemo<DailyMarketQuote[]>(() => {
    const list: DailyMarketQuote[] = [];
    for (const sym of activeSymbols) {
      const q = quotes[sym];
      if (q) {
        list.push(q);
      } else {
        // Fallback placeholder
        list.push({
          symbol: sym,
          company: sym,
          industry: 'General',
          ltp: 0,
          change: 0,
          change_pct: 0,
          prev_close: 0,
          open: 0,
          high: 0,
          low: 0,
          vwap: 0,
          volume: 0,
          turnover_cr: 0,
          high_52w: 0,
          low_52w: 0,
        });
      }
    }
    return list;
  }, [activeSymbols, quotes]);

  // ── Breadth & Telemetry Stats for Active Universe ──────────────────────────
  const stats = useMemo(() => {
    let advances = 0;
    let declines = 0;
    let unchanged = 0;
    let topGainer: DailyMarketQuote | null = null;
    let topLoser: DailyMarketQuote | null = null;
    let totalVolume = 0;
    let totalTurnoverCr = 0;

    for (const r of activeRows) {
      if (r.ltp <= 0) continue;
      if (r.change_pct > 0) advances++;
      else if (r.change_pct < 0) declines++;
      else unchanged++;

      totalVolume += r.volume;
      totalTurnoverCr += r.turnover_cr;

      if (!topGainer || r.change_pct > topGainer.change_pct) {
        topGainer = r;
      }
      if (!topLoser || r.change_pct < topLoser.change_pct) {
        topLoser = r;
      }
    }

    const totalValid = advances + declines + unchanged;
    const advanceRatio = totalValid > 0 ? (advances / totalValid) * 100 : 50;

    return {
      advances,
      declines,
      unchanged,
      advanceRatio,
      topGainer,
      topLoser,
      totalVolume,
      totalTurnoverCr,
      count: activeRows.length,
    };
  }, [activeRows]);

  // ── Filtered & Sorted Rows ─────────────────────────────────────────────────
  const filteredAndSortedRows = useMemo<DailyMarketQuote[]>(() => {
    let result = activeRows;

    // Search filter
    if (searchQuery.trim()) {
      const q = searchQuery.trim().toUpperCase();
      result = result.filter(
        (r) => r.symbol.toUpperCase().includes(q) || r.company.toUpperCase().includes(q)
      );
    }

    // Industry filter
    if (industryFilter !== 'ALL') {
      result = result.filter((r) => r.industry === industryFilter);
    }

    // Direction / 52W filter
    if (dirFilter === 'gainers') {
      result = result.filter((r) => r.change_pct > 0);
    } else if (dirFilter === 'losers') {
      result = result.filter((r) => r.change_pct < 0);
    } else if (dirFilter === 'near52h') {
      result = result.filter((r) => r.high_52w > 0 && r.ltp > 0 && r.ltp >= r.high_52w * 0.97);
    } else if (dirFilter === 'near52l') {
      result = result.filter((r) => r.low_52w > 0 && r.ltp > 0 && r.ltp <= r.low_52w * 1.03);
    }

    // Sorting
    return [...result].sort((a, b) => {
      // Rows with no price yet always sink to the bottom, whatever the sort.
      if ((a.ltp > 0) !== (b.ltp > 0)) return a.ltp > 0 ? -1 : 1;
      let aVal = a[sortField];
      let bVal = b[sortField];

      if (typeof aVal === 'string') {
        aVal = (aVal as string).toLowerCase();
        bVal = (bVal as string).toLowerCase();
      }

      if (aVal < bVal) return sortDirection === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortDirection === 'asc' ? 1 : -1;
      return 0;
    });
  }, [activeRows, searchQuery, industryFilter, dirFilter, sortField, sortDirection]);

  // ── Pagination ─────────────────────────────────────────────────────────────
  const totalPages = Math.ceil(filteredAndSortedRows.length / pageSize) || 1;
  useEffect(() => {
    if (currentPage > totalPages) setCurrentPage(totalPages);
  }, [currentPage, totalPages]);
  const paginatedRows = useMemo(() => {
    if (pageSize >= 100000) return filteredAndSortedRows;
    const start = (currentPage - 1) * pageSize;
    return filteredAndSortedRows.slice(start, start + pageSize);
  }, [filteredAndSortedRows, currentPage, pageSize]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  };

  // ── Stock Picker Filtered Symbols ──────────────────────────────────────────
  const pickerSuggestions = useMemo(() => {
    if (!isAddingStock) return [];
    const all = indexConstituents.nifty500.length > 0 ? indexConstituents.nifty500 : Object.keys(quotes);
    const custom = customTabs.find((t) => t.id === activeTab);
    const existing = new Set(custom ? custom.symbols : []);

    const query = stockSearchQuery.trim().toUpperCase();
    return all
      .filter((s) => !existing.has(s))
      .filter((s) => {
        if (!query) return true;
        const q = quotes[s];
        return s.toUpperCase().includes(query) || (q && q.company.toUpperCase().includes(query));
      })
      .slice(0, 30);
  }, [isAddingStock, indexConstituents, quotes, customTabs, activeTab, stockSearchQuery]);

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 text-zinc-100 font-sans selection:bg-amber-500/20">
      <NavBar />

      <main className="flex-1 px-3 py-3 md:px-5 md:py-4 space-y-3.5 max-w-[1700px] w-full mx-auto">
        {/* ── Bloomberg Top Function Keys Ribbon ── */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800/80 pb-2.5">
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-[11px]">
            <button
              onClick={() => { setActiveTab('nifty50'); setCurrentPage(1); }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                activeTab === 'nifty50'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <span className="text-[9px] font-bold text-amber-400/80">[F1]</span> NIFTY 50
            </button>
            <button
              onClick={() => { setActiveTab('banknifty'); setCurrentPage(1); }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                activeTab === 'banknifty'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <span className="text-[9px] font-bold text-amber-400/80">[F2]</span> BANK NIFTY
            </button>
            <button
              onClick={() => { setActiveTab('nifty500'); setCurrentPage(1); }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                activeTab === 'nifty500'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <span className="text-[9px] font-bold text-amber-400/80">[F3]</span> NIFTY 500
            </button>
            <button
              onClick={() => { setActiveTab('next50'); setCurrentPage(1); }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                activeTab === 'next50'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <span className="text-[9px] font-bold text-amber-400/80">[F4]</span> NEXT 50
            </button>
            <button
              onClick={() => { setActiveTab('midcap150'); setCurrentPage(1); }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                activeTab === 'midcap150'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <span className="text-[9px] font-bold text-amber-400/80">[F5]</span> MIDCAP 150
            </button>
            <button
              onClick={() => { setActiveTab('smallcap250'); setCurrentPage(1); }}
              className={`flex items-center gap-1 px-2.5 py-1 rounded transition-colors ${
                activeTab === 'smallcap250'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800/60'
              }`}
            >
              <span className="text-[9px] font-bold text-amber-400/80">[F6]</span> SMALLCAP 250
            </button>
            <button
              onClick={() => setIsCreatingTab(true)}
              className="flex items-center gap-1 px-2.5 py-1 rounded bg-zinc-900 text-zinc-400 border border-zinc-800 hover:text-amber-400 hover:border-amber-500/40 transition-colors"
            >
              <Plus className="h-3 w-3 text-amber-400" />
              <span>NEW WATCHLIST</span>
            </button>
          </div>

          {/* Right Status Meta */}
          <div className="flex items-center gap-3 font-mono text-[11px] text-zinc-400">
            {/* Live IST Clock */}
            <div className="flex items-center gap-1.5 px-2 py-0.5 rounded bg-zinc-900 border border-zinc-800">
              <Clock className="h-3.5 w-3.5 text-zinc-500" />
              <span className="tabular-nums text-zinc-300 font-semibold">{istTime || '--:--:--'} IST</span>
              <span
                className={`ml-1 text-[9px] px-1 py-0.2 rounded font-bold uppercase ${
                  isMuhurat
                    ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30'
                    : isMarketOpen
                    ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30'
                    : 'bg-zinc-800 text-zinc-500 border border-zinc-700'
                }`}
              >
                {isMuhurat ? 'MUHURAT' : isMarketOpen ? 'OPEN' : 'CLOSED'}
              </span>
            </div>

            {/* WebSocket Status Pill */}
            <div className="flex items-center gap-2 px-2.5 py-1 rounded border border-zinc-800 bg-zinc-900">
              <div
                className={`h-2 w-2 rounded-full ${
                  wsStatus === 'connected'
                    ? 'bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]'
                    : wsStatus === 'connecting'
                    ? 'bg-amber-400 animate-ping'
                    : 'bg-red-400'
                }`}
              />
              <span className="text-[10px] font-bold uppercase tracking-wider text-zinc-300">
                {wsStatus === 'connected' ? 'WS STREAMING' : wsStatus === 'connecting' ? 'CONNECTING WS' : 'WS OFFLINE'}
              </span>
              <span className="text-[10px] text-zinc-500">:{wsPort}</span>

              {bridgeStatus === 'STOPPED' ? (
                <button
                  onClick={startBridge}
                  className="ml-1 text-[10px] font-bold text-amber-400 hover:text-amber-300 underline uppercase"
                >
                  Start
                </button>
              ) : (
                <button
                  onClick={stopBridge}
                  className="ml-1 text-[10px] font-semibold text-zinc-500 hover:text-red-400 underline uppercase"
                >
                  Stop
                </button>
              )}
            </div>
          </div>
        </div>

        {/* ── Terminal Header Panel ── */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm overflow-hidden">
          <header className="flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-4 py-2.5">
            <div className="flex items-center gap-2">
              <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-amber-500/10 border border-amber-500/30 text-amber-400">
                <Globe className="h-4 w-4" />
              </div>
              <div>
                <h1 className="text-sm font-bold uppercase tracking-[0.16em] text-white flex items-center gap-2">
                  DAILY MARKET TERMINAL
                  <span className="text-[9px] font-bold tracking-wider px-1.5 py-0.5 rounded border border-emerald-500/30 bg-emerald-500/10 text-emerald-400">
                    REALTIME WS
                  </span>
                </h1>
                <p className="text-[10px] text-zinc-500 font-mono">
                  Full-depth equity ticks with instant previous day close diffs & multi-tab watchlists
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <span className="rounded px-2 py-0.5 font-mono text-[10px] font-bold border border-zinc-800 bg-zinc-950 text-zinc-400">
                DATA: {lastTickTime ? istDateIso(lastTickTime) : 'CONNECTING'}
              </span>
              <span className="rounded px-2 py-0.5 font-mono text-[10px] font-bold border border-zinc-800 bg-zinc-950 text-amber-400">
                {activeRows.length} STOCKS
              </span>
            </div>
          </header>

          {/* ── Summary Stat Tiles Strip ── */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2 p-3 bg-zinc-950/40">
            {/* Advance / Decline Tile */}
            <div className="flex flex-col justify-between gap-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
              <div className="flex items-center justify-between text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">
                <span>Breadth</span>
                <span className="font-mono text-zinc-400">{Math.round(stats.advanceRatio)}% ADV</span>
              </div>
              <div className="flex items-baseline gap-2 font-mono text-sm font-bold tabular-nums">
                <span className="text-emerald-400">{stats.advances} ▲</span>
                <span className="text-red-400">{stats.declines} ▼</span>
                <span className="text-zinc-500 text-xs">{stats.unchanged} ═</span>
              </div>
              {/* Progress bar */}
              <div className="h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden flex">
                <div
                  className="bg-emerald-400 transition-all duration-500"
                  style={{ width: `${stats.advanceRatio}%` }}
                />
                <div
                  className="bg-red-400 transition-all duration-500"
                  style={{ width: `${100 - stats.advanceRatio}%` }}
                />
              </div>
            </div>

            {/* Top Gainer */}
            <div className="flex flex-col justify-between gap-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">
                Top Gainer
              </span>
              <div className="flex items-center justify-between font-mono tabular-nums">
                <span className="text-xs font-bold text-zinc-200 truncate">
                  {stats.topGainer?.symbol || '—'}
                </span>
                <span className="text-xs font-bold text-emerald-400">
                  {stats.topGainer ? `+${stats.topGainer.change_pct.toFixed(2)}%` : '0.00%'}
                </span>
              </div>
              <span className="text-[9px] font-mono text-zinc-500 truncate">
                LTP: ₹{stats.topGainer?.ltp.toFixed(2) || '0.00'}
              </span>
            </div>

            {/* Top Loser */}
            <div className="flex flex-col justify-between gap-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">
                Top Loser
              </span>
              <div className="flex items-center justify-between font-mono tabular-nums">
                <span className="text-xs font-bold text-zinc-200 truncate">
                  {stats.topLoser?.symbol || '—'}
                </span>
                <span className="text-xs font-bold text-red-400">
                  {stats.topLoser ? `${stats.topLoser.change_pct.toFixed(2)}%` : '0.00%'}
                </span>
              </div>
              <span className="text-[9px] font-mono text-zinc-500 truncate">
                LTP: ₹{stats.topLoser?.ltp.toFixed(2) || '0.00'}
              </span>
            </div>

            {/* Total Traded Volume */}
            <div className="flex flex-col justify-between gap-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">
                Tab Traded Vol
              </span>
              <div className="font-mono text-sm font-bold tabular-nums text-zinc-100">
                {(stats.totalVolume / 1_000_000).toFixed(2)}M
              </div>
              <span className="text-[9px] font-mono text-zinc-500">
                {stats.totalVolume.toLocaleString('en-IN')} shares
              </span>
            </div>

            {/* Total Turnover */}
            <div className="flex flex-col justify-between gap-1 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2">
              <span className="text-[10px] font-bold uppercase tracking-[0.15em] text-zinc-500">
                Tab Turnover
              </span>
              <div className="font-mono text-sm font-bold tabular-nums text-amber-400">
                ₹{stats.totalTurnoverCr.toLocaleString('en-IN', { maximumFractionDigits: 1 })} Cr
              </div>
              <span className="text-[9px] font-mono text-zinc-500">Estimated value</span>
            </div>
          </div>
        </section>

        {/* ── Tabs Navigation Strip ── */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2">
          <div className="flex flex-wrap items-center gap-1.5 font-mono text-xs">
            {/* System Tabs */}
            <button
              onClick={() => {
                setActiveTab('nifty50');
                setCurrentPage(1);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'nifty50'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Activity className="h-3.5 w-3.5" />
              <span>NIFTY 50</span>
              <span className="text-[10px] opacity-70">
                ({indexConstituents.nifty50.length || 50})
              </span>
            </button>

            <button
              onClick={() => {
                setActiveTab('banknifty');
                setCurrentPage(1);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'banknifty'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>BANK NIFTY</span>
              <span className="text-[10px] opacity-70">
                ({indexConstituents.banknifty.length || 14})
              </span>
            </button>

            <button
              onClick={() => {
                setActiveTab('nifty500');
                setCurrentPage(1);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'nifty500'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Gauge className="h-3.5 w-3.5" />
              <span>NIFTY 500</span>
              <span className="text-[10px] opacity-70">
                ({indexConstituents.nifty500.length || 500})
              </span>
            </button>

            <button
              onClick={() => {
                setActiveTab('next50');
                setCurrentPage(1);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'next50'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>NEXT 50</span>
              <span className="text-[10px] opacity-70">
                ({indexConstituents.next50.length || 50})
              </span>
            </button>

            <button
              onClick={() => {
                setActiveTab('midcap150');
                setCurrentPage(1);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'midcap150'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>MIDCAP 150</span>
              <span className="text-[10px] opacity-70">
                ({indexConstituents.midcap150.length || 150})
              </span>
            </button>

            <button
              onClick={() => {
                setActiveTab('smallcap250');
                setCurrentPage(1);
              }}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                activeTab === 'smallcap250'
                  ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                  : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
              }`}
            >
              <Layers className="h-3.5 w-3.5" />
              <span>SMALLCAP 250</span>
              <span className="text-[10px] opacity-70">
                ({indexConstituents.smallcap250.length || 250})
              </span>
            </button>

            {/* Custom Watchlist Tabs */}
            {customTabs.map((ct) => (
              <div key={ct.id} className="relative flex items-center group">
                <button
                  onClick={() => {
                    setActiveTab(ct.id);
                    setCurrentPage(1);
                  }}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg transition-colors ${
                    activeTab === ct.id
                      ? 'bg-amber-500/20 text-amber-400 border border-amber-500/40 font-bold'
                      : 'bg-zinc-900/90 text-zinc-400 border border-zinc-800 hover:text-zinc-200 hover:bg-zinc-800'
                  }`}
                >
                  <Star className="h-3 w-3 text-amber-400 fill-amber-400/20" />
                  <span>{ct.name}</span>
                  <span className="text-[10px] opacity-70">({ct.symbols.length})</span>
                </button>

                {/* Edit / Delete on Hover */}
                {activeTab === ct.id && (
                  <div className="ml-1 flex items-center gap-0.5">
                    <button
                      onClick={() => {
                        setIsRenamingTabId(ct.id);
                        setRenameTabName(ct.name);
                      }}
                      title="Rename Tab"
                      className="p-1 rounded text-zinc-500 hover:text-amber-400 hover:bg-zinc-800"
                    >
                      <Edit2 className="h-3 w-3" />
                    </button>
                    <button
                      onClick={() => handleDeleteTab(ct.id)}
                      title="Delete Watchlist"
                      className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800"
                    >
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                )}
              </div>
            ))}

            {/* Add Custom Tab Button */}
            <button
              onClick={() => setIsCreatingTab(true)}
              className="flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-zinc-900 border border-dashed border-zinc-700 text-zinc-400 hover:text-amber-400 hover:border-amber-500/50 transition-colors"
            >
              <Plus className="h-3.5 w-3.5 text-amber-400" />
              <span>Add Tab</span>
            </button>
          </div>

          {/* Action on Custom Tab: Add Stock */}
          {activeTab.startsWith('custom_') && (
            <button
              onClick={() => {
                setIsAddingStock(true);
                setStockSearchQuery('');
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500/20 border border-amber-500/50 text-amber-400 hover:bg-amber-500/30 font-mono text-xs font-bold transition-colors"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Add Stock to Tab</span>
            </button>
          )}
        </div>

        {/* ── Toolbar: Search, Sector & Quick Direction Filters ── */}
        <div className="flex flex-wrap items-center justify-between gap-3 bg-zinc-900/60 p-2.5 rounded-xl border border-zinc-800">
          <div className="flex flex-wrap items-center gap-2">
            {/* Search Input */}
            <div className="relative min-w-[200px] md:min-w-[240px]">
              <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-zinc-500" />
              <input
                type="text"
                placeholder="Search symbol or company..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setCurrentPage(1);
                }}
                className="w-full pl-8 pr-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs font-mono text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
              />
              {searchQuery && (
                <button
                  onClick={() => setSearchQuery('')}
                  className="absolute right-2 top-2 text-zinc-500 hover:text-zinc-300"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Sector / Industry Dropdown */}
            <select
              value={industryFilter}
              onChange={(e) => {
                setIndustryFilter(e.target.value);
                setCurrentPage(1);
              }}
              className="px-2.5 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs font-mono text-zinc-300 focus:outline-none focus:border-amber-500/50"
            >
              <option value="ALL">All Sectors ({availableIndustries.length})</option>
              {availableIndustries.map((ind) => (
                <option key={ind} value={ind}>
                  {ind}
                </option>
              ))}
            </select>

            {/* Direction Filter Chips */}
            <div className="flex items-center gap-1 font-mono text-xs">
              <button
                onClick={() => {
                  setDirFilter('all');
                  setCurrentPage(1);
                }}
                className={`px-2 py-1 rounded transition-colors ${
                  dirFilter === 'all'
                    ? 'bg-zinc-800 text-white font-bold'
                    : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-800/50'
                }`}
              >
                All
              </button>
              <button
                onClick={() => {
                  setDirFilter('gainers');
                  setCurrentPage(1);
                }}
                className={`px-2 py-1 rounded transition-colors ${
                  dirFilter === 'gainers'
                    ? 'bg-emerald-500/20 text-emerald-400 font-bold border border-emerald-500/30'
                    : 'text-zinc-400 hover:text-emerald-400 hover:bg-zinc-800/50'
                }`}
              >
                Gainers
              </button>
              <button
                onClick={() => {
                  setDirFilter('losers');
                  setCurrentPage(1);
                }}
                className={`px-2 py-1 rounded transition-colors ${
                  dirFilter === 'losers'
                    ? 'bg-red-500/20 text-red-400 font-bold border border-red-500/30'
                    : 'text-zinc-400 hover:text-red-400 hover:bg-zinc-800/50'
                }`}
              >
                Losers
              </button>
              <button
                onClick={() => {
                  setDirFilter('near52h');
                  setCurrentPage(1);
                }}
                className={`px-2 py-1 rounded transition-colors ${
                  dirFilter === 'near52h'
                    ? 'bg-sky-500/20 text-sky-400 font-bold border border-sky-500/30'
                    : 'text-zinc-400 hover:text-sky-400 hover:bg-zinc-800/50'
                }`}
              >
                Near 52W High
              </button>
              <button
                onClick={() => {
                  setDirFilter('near52l');
                  setCurrentPage(1);
                }}
                className={`px-2 py-1 rounded transition-colors ${
                  dirFilter === 'near52l'
                    ? 'bg-purple-500/20 text-purple-400 font-bold border border-purple-500/30'
                    : 'text-zinc-400 hover:text-purple-400 hover:bg-zinc-800/50'
                }`}
              >
                Near 52W Low
              </button>
            </div>
          </div>

          {/* Page size & Count */}
          <div className="flex items-center gap-3 font-mono text-xs text-zinc-400">
            <span>
              Showing <span className="text-zinc-100 font-bold">{filteredAndSortedRows.length}</span> results
            </span>
            <div className="flex items-center gap-1">
              <span className="text-zinc-500">Rows:</span>
              <select
                value={pageSize}
                onChange={(e) => {
                  setPageSize(Number(e.target.value));
                  setCurrentPage(1);
                }}
                className="px-2 py-1 rounded bg-zinc-950 border border-zinc-800 text-xs text-zinc-300 focus:outline-none"
              >
                <option value={50}>50</option>
                <option value={100}>100</option>
                <option value={250}>250</option>
                <option value={100000}>All</option>
              </select>
            </div>
          </div>
        </div>

        {/* ── High-Density Bloomberg Institutional Table ── */}
        <div className="overflow-x-auto rounded-xl border border-zinc-800 bg-zinc-900/40 shadow-sm">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="bg-zinc-800 text-xs font-bold text-white uppercase tracking-wider">
                <th className="px-3 py-2 w-10 text-center text-zinc-400">#</th>
                <th
                  onClick={() => handleSort('symbol')}
                  className="px-3 py-2 cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center gap-1">
                    <span>Symbol</span>
                    {sortField === 'symbol' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('ltp')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>LTP (₹)</span>
                    {sortField === 'ltp' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('change')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>Chg (₹)</span>
                    {sortField === 'change' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('change_pct')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>Chg %</span>
                    {sortField === 'change_pct' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('prev_close')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>Prev Close</span>
                    {sortField === 'prev_close' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('open')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>Open</span>
                    {sortField === 'open' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('high')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>High</span>
                    {sortField === 'high' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('low')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>Low</span>
                    {sortField === 'low' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('vwap')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>VWAP</span>
                    {sortField === 'vwap' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th className="px-3 py-2 text-center min-w-[130px]">Day Range</th>
                <th
                  onClick={() => handleSort('volume')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>Volume</span>
                    {sortField === 'volume' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('turnover_cr')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>Turnover</span>
                    {sortField === 'turnover_cr' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th
                  onClick={() => handleSort('high_52w')}
                  className="px-3 py-2 text-right cursor-pointer hover:text-amber-400 select-none"
                >
                  <div className="flex items-center justify-end gap-1">
                    <span>52W H / L</span>
                    {sortField === 'high_52w' && (
                      sortDirection === 'asc' ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />
                    )}
                  </div>
                </th>
                <th className="px-3 py-2 text-center w-16">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800/80 font-mono text-xs">
              {paginatedRows.length === 0 ? (
                <tr>
                  <td colSpan={15} className="px-4 py-12 text-center text-zinc-500">
                    {isLoading ? (
                      <div className="flex items-center justify-center gap-2">
                        <RefreshCw className="h-4 w-4 animate-spin text-amber-400" />
                        <span>Streaming latest WebSocket market data...</span>
                      </div>
                    ) : (
                      'No stocks found matching the criteria.'
                    )}
                  </td>
                </tr>
              ) : (
                paginatedRows.map((r, idx) => {
                  const flash = flashMap[r.symbol];
                  const flashClass =
                    flash === 'up'
                      ? 'bg-emerald-500/20 text-emerald-300'
                      : flash === 'down'
                      ? 'bg-red-500/20 text-red-300'
                      : '';

                  const isUp = r.change_pct > 0;
                  const isDown = r.change_pct < 0;

                  // Day Range slider position %
                  const rangeSpan = r.high - r.low;
                  const rangePct =
                    rangeSpan > 0 && r.ltp >= r.low
                      ? Math.min(100, Math.max(0, ((r.ltp - r.low) / rangeSpan) * 100))
                      : 50;

                  return (
                    <tr
                      key={r.symbol}
                      className="transition-colors hover:bg-zinc-800/50 group"
                    >
                      {/* # */}
                      <td className="px-3 py-2 text-center text-zinc-500 text-[10px]">
                        {(currentPage - 1) * pageSize + idx + 1}
                      </td>

                      {/* Symbol & Company */}
                      <td className="px-3 py-2">
                        <div className="flex flex-col">
                          <div className="flex items-center gap-1.5">
                            <span className="font-bold text-zinc-100 group-hover:text-amber-400 transition-colors">
                              {r.symbol}
                            </span>
                            <span className="text-[9px] px-1 py-0.2 rounded bg-zinc-800/80 text-zinc-400 border border-zinc-700/50">
                              {r.industry}
                            </span>
                          </div>
                          <span className="text-[10px] text-zinc-500 truncate max-w-[180px]">
                            {r.company}
                          </span>
                        </div>
                      </td>

                      {/* LTP with Flash */}
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-bold transition-colors ${
                          flashClass || 'text-zinc-100'
                        }`}
                      >
                        ₹{r.ltp > 0 ? r.ltp.toFixed(2) : '—'}
                      </td>

                      {/* Change Point */}
                      <td
                        className={`px-3 py-2 text-right tabular-nums font-semibold ${
                          isUp ? 'text-emerald-400' : isDown ? 'text-red-400' : 'text-zinc-400'
                        }`}
                      >
                        {isUp ? `+${r.change.toFixed(2)}` : r.change.toFixed(2)}
                      </td>

                      {/* Change % Badge */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        <span
                          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold border ${
                            isUp
                              ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-400'
                              : isDown
                              ? 'border-red-500/30 bg-red-500/10 text-red-400'
                              : 'border-zinc-700 bg-zinc-800 text-zinc-400'
                          }`}
                        >
                          {isUp ? `+${r.change_pct.toFixed(2)}%` : `${r.change_pct.toFixed(2)}%`}
                        </span>
                      </td>

                      {/* Prev Close */}
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                        ₹{r.prev_close > 0 ? r.prev_close.toFixed(2) : '—'}
                      </td>

                      {/* Open */}
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                        {r.open > 0 ? r.open.toFixed(2) : '—'}
                      </td>

                      {/* High */}
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                        {r.high > 0 ? r.high.toFixed(2) : '—'}
                      </td>

                      {/* Low */}
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                        {r.low > 0 ? r.low.toFixed(2) : '—'}
                      </td>

                      {/* VWAP */}
                      <td className="px-3 py-2 text-right tabular-nums text-amber-400/90 font-medium">
                        {r.vwap > 0 ? r.vwap.toFixed(2) : '—'}
                      </td>

                      {/* Day Range Mini Meter */}
                      <td className="px-3 py-2">
                        <div className="flex flex-col gap-0.5">
                          <div className="flex justify-between text-[9px] text-zinc-500 font-mono">
                            <span>{r.low > 0 ? r.low.toFixed(0) : ''}</span>
                            <span>{r.high > 0 ? r.high.toFixed(0) : ''}</span>
                          </div>
                          <div className="relative h-1.5 w-full rounded-full bg-zinc-800 overflow-hidden">
                            <div
                              className="absolute top-0 bottom-0 w-2 -ml-1 rounded-full bg-amber-400 shadow-[0_0_6px_rgba(251,191,36,0.8)]"
                              style={{ left: `${rangePct}%` }}
                            />
                          </div>
                        </div>
                      </td>

                      {/* Volume */}
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                        {r.volume >= 1_000_000
                          ? `${(r.volume / 1_000_000).toFixed(2)}M`
                          : r.volume >= 1_000
                          ? `${(r.volume / 1_000).toFixed(1)}K`
                          : r.volume.toLocaleString('en-IN')}
                      </td>

                      {/* Turnover (₹ Cr) */}
                      <td className="px-3 py-2 text-right tabular-nums text-zinc-400">
                        {r.turnover_cr > 0 ? `₹${r.turnover_cr.toFixed(1)} Cr` : '—'}
                      </td>

                      {/* 52W High / Low */}
                      <td className="px-3 py-2 text-right tabular-nums">
                        <div className="flex flex-col text-[10px]">
                          <span className="text-zinc-300">H: ₹{r.high_52w.toFixed(1)}</span>
                          <span className="text-zinc-500">L: ₹{r.low_52w.toFixed(1)}</span>
                        </div>
                      </td>

                      {/* Action */}
                      <td className="px-3 py-2 text-center">
                        <div className="flex items-center justify-center gap-1">
                          {activeTab.startsWith('custom_') ? (
                            <button
                              onClick={() => handleRemoveStockFromTab(r.symbol)}
                              title="Remove from this tab"
                              className="p-1 rounded text-zinc-500 hover:text-red-400 hover:bg-zinc-800 transition-colors"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => {
                                if (customTabs.length > 0) {
                                  // Add to first custom tab
                                  const targetTab = customTabs[0];
                                  if (!targetTab.symbols.includes(r.symbol)) {
                                    const updated = customTabs.map((t) =>
                                      t.id === targetTab.id
                                        ? { ...t, symbols: [...t.symbols, r.symbol] }
                                        : t
                                    );
                                    saveCustomTabs(updated);
                                  }
                                } else {
                                  // Create new custom tab
                                  const newTab: CustomTab = {
                                    id: `custom_${Date.now()}`,
                                    name: 'My Watchlist',
                                    symbols: [r.symbol],
                                  };
                                  saveCustomTabs([newTab]);
                                }
                              }}
                              title="Add to Watchlist"
                              className="p-1 rounded text-zinc-500 hover:text-amber-400 hover:bg-zinc-800 transition-colors"
                            >
                              <Star className="h-3.5 w-3.5" />
                            </button>
                          )}
                          <Link
                            href={`/candlestick?symbol=${r.symbol}`}
                            title="Open Candlestick Chart"
                            className="p-1 rounded text-zinc-500 hover:text-sky-400 hover:bg-zinc-800 transition-colors"
                          >
                            <ExternalLink className="h-3.5 w-3.5" />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* ── Pagination Controls ── */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between py-2 text-xs font-mono text-zinc-400">
            <span>
              Page {currentPage} of {totalPages}
            </span>
            <div className="flex items-center gap-1">
              <button
                disabled={currentPage === 1}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="px-2.5 py-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 disabled:opacity-40 hover:bg-zinc-800"
              >
                Previous
              </button>
              {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
                const windowStart = Math.max(1, Math.min(currentPage - 2, totalPages - 4));
                const pageNum = windowStart + i;
                return (
                  <button
                    key={pageNum}
                    onClick={() => setCurrentPage(pageNum)}
                    className={`px-2.5 py-1 rounded border transition-colors ${
                      currentPage === pageNum
                        ? 'bg-amber-500/20 text-amber-400 border-amber-500/40 font-bold'
                        : 'bg-zinc-900 text-zinc-400 border-zinc-800 hover:bg-zinc-800'
                    }`}
                  >
                    {pageNum}
                  </button>
                );
              })}
              <button
                disabled={currentPage === totalPages}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="px-2.5 py-1 rounded bg-zinc-900 border border-zinc-800 text-zinc-300 disabled:opacity-40 hover:bg-zinc-800"
              >
                Next
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ── Modal: Create Custom Tab ── */}
      {isCreatingTab && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="font-bold text-sm uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                <Plus className="h-4 w-4" /> Create Custom Watchlist
              </h3>
              <button
                onClick={() => setIsCreatingTab(false)}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                Tab Name
              </label>
              <input
                type="text"
                autoFocus
                placeholder="e.g. Breakout Stocks, High Momentum..."
                value={newTabName}
                onChange={(e) => setNewTabName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleCreateTab()}
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setIsCreatingTab(false)}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-400 text-xs font-mono hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={handleCreateTab}
                className="px-4 py-1.5 rounded-lg bg-amber-500 text-zinc-950 font-bold text-xs font-mono hover:bg-amber-400"
              >
                Create Tab
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Rename Custom Tab ── */}
      {isRenamingTabId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-sm rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-xl space-y-4">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="font-bold text-sm uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                <Edit2 className="h-4 w-4" /> Rename Watchlist
              </h3>
              <button
                onClick={() => setIsRenamingTabId(null)}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-bold uppercase tracking-wider text-zinc-400">
                New Name
              </label>
              <input
                type="text"
                autoFocus
                value={renameTabName}
                onChange={(e) => setRenameTabName(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleRenameTab(isRenamingTabId)}
                className="w-full px-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
              />
            </div>
            <div className="flex items-center justify-end gap-2 pt-2">
              <button
                onClick={() => setIsRenamingTabId(null)}
                className="px-3 py-1.5 rounded-lg bg-zinc-900 text-zinc-400 text-xs font-mono hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => handleRenameTab(isRenamingTabId)}
                className="px-4 py-1.5 rounded-lg bg-amber-500 text-zinc-950 font-bold text-xs font-mono hover:bg-amber-400"
              >
                Save
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Modal: Add Stock to Custom Tab ── */}
      {isAddingStock && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-oncolor-dark/80 backdrop-blur-sm p-4">
          <div className="w-full max-w-lg rounded-xl border border-zinc-800 bg-zinc-950 p-5 shadow-2xl space-y-4 max-h-[80vh] flex flex-col">
            <div className="flex items-center justify-between border-b border-zinc-800 pb-3">
              <h3 className="font-bold text-sm uppercase tracking-wider text-amber-400 flex items-center gap-1.5">
                <Plus className="h-4 w-4" /> Add Stock to Watchlist
              </h3>
              <button
                onClick={() => setIsAddingStock(false)}
                className="text-zinc-500 hover:text-zinc-300"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            {/* Search */}
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-zinc-500" />
              <input
                type="text"
                autoFocus
                placeholder="Search symbol or company name (e.g. INFY, Tata Motors)..."
                value={stockSearchQuery}
                onChange={(e) => setStockSearchQuery(e.target.value)}
                className="w-full pl-9 pr-3 py-2 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-mono text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-amber-500/50"
              />
            </div>

            {/* Suggestions list */}
            <div className="flex-1 overflow-y-auto divide-y divide-zinc-800/80 pr-1 max-h-[360px]">
              {pickerSuggestions.length === 0 ? (
                <div className="py-8 text-center text-zinc-500 font-mono text-xs">
                  No unadded stocks match &quot;{stockSearchQuery}&quot;
                </div>
              ) : (
                pickerSuggestions.map((sym) => {
                  const q = quotes[sym];
                  return (
                    <div
                      key={sym}
                      className="flex items-center justify-between py-2 px-2 hover:bg-zinc-900 rounded-lg transition-colors group"
                    >
                      <div className="flex flex-col">
                        <div className="flex items-center gap-2">
                          <span className="font-bold font-mono text-xs text-zinc-100 group-hover:text-amber-400">
                            {sym}
                          </span>
                          {q && (
                            <span className="text-[9px] px-1 py-0.2 rounded bg-zinc-800 text-zinc-400">
                              {q.industry}
                            </span>
                          )}
                        </div>
                        <span className="text-[10px] text-zinc-500">
                          {q ? q.company : sym}
                        </span>
                      </div>

                      <div className="flex items-center gap-3">
                        {q && (
                          <div className="text-right font-mono text-xs tabular-nums">
                            <div className="font-bold text-zinc-200">₹{q.ltp.toFixed(2)}</div>
                            <div
                              className={`text-[10px] ${
                                q.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400'
                              }`}
                            >
                              {q.change_pct >= 0 ? `+${q.change_pct.toFixed(2)}%` : `${q.change_pct.toFixed(2)}%`}
                            </div>
                          </div>
                        )}
                        <button
                          onClick={() => {
                            handleAddStockToTab(sym);
                          }}
                          className="flex items-center gap-1 px-2.5 py-1 rounded bg-amber-500/20 text-amber-400 border border-amber-500/40 hover:bg-amber-500/30 text-xs font-mono font-bold transition-colors"
                        >
                          <Plus className="h-3 w-3" /> Add
                        </button>
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <div className="border-t border-zinc-800 pt-3 flex justify-end">
              <button
                onClick={() => setIsAddingStock(false)}
                className="px-4 py-1.5 rounded-lg bg-zinc-900 text-zinc-300 text-xs font-mono hover:bg-zinc-800"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
