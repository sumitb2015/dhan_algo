'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  Plus,
  X,
  RefreshCw,
  Terminal,
  AlertTriangle,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  Clock,
  CheckCircle2,
  SlidersHorizontal,
  Edit2,
  Trash2,
  Zap,
  ShieldCheck,
  Search,
  Wallet,
  Layers,
  Pause,
  Play,
  Percent,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';

// ─── Types ──────────────────────────────────────────────────────────────────
interface ForeverOrderRow {
  orderId: string;
  orderFlag: string;
  transactionType: string;
  quantity: number;
  price: number;
  triggerPrice: number;
  status: string;
  legName: string | null;
  createTime: string;
  updateTime: string;
}

interface WatchlistRow {
  symbol: string;
  name: string;
  tick: number;
  ltp: number;
  prevClose: number;
  dayChangePct: number;
  dayChangeRs: number;
  open: number;
  high: number;
  low: number;
  portfolioQty: number;
  avgCostPrice: number;
  unrealizedPnl: number;
  foreverOrders: ForeverOrderRow[];
}

interface WatchlistResponse {
  success: boolean;
  rows?: WatchlistRow[];
  availableFunds?: number | null;
  asOf?: string;
  error?: string;
}

interface SymbolsResponse {
  success: boolean;
  symbols: string[];
}

interface ToastMessage {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  description?: string;
}

// ─── Formatters & Utility Helpers ───────────────────────────────────────────
function fmt(n: number, digits = 2) {
  return (n ?? 0).toFixed(digits);
}

function fmtInr(n: number, maxDigits = 2) {
  return (n ?? 0).toLocaleString('en-IN', {
    maximumFractionDigits: maxDigits,
    minimumFractionDigits: maxDigits > 0 ? 2 : 0,
  });
}

function fmtCountdown(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

// Visual Day Range Bar: Low ───●─── High
function DayRangeBar({ low, high, ltp }: { low: number; high: number; ltp: number }) {
  if (!low || !high || high <= low || !ltp) {
    return <span className="text-[11px] text-zinc-600 font-mono">—</span>;
  }
  const pct = Math.max(0, Math.min(100, ((ltp - low) / (high - low)) * 100));

  return (
    <div className="flex flex-col gap-1 w-36">
      <div className="flex justify-between items-center text-[10px] font-mono text-zinc-400">
        <span>₹{fmt(low)}</span>
        <span>₹{fmt(high)}</span>
      </div>
      <div className="relative w-full h-1.5 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className="absolute top-0 bottom-0 left-0 bg-gradient-to-r from-emerald-500/30 to-emerald-500 rounded-full"
          style={{ width: `${pct}%` }}
        />
        <div
          className="absolute top-0 bottom-0 w-1.5 bg-white rounded-full shadow-sm -ml-0.5"
          style={{ left: `${pct}%` }}
        />
      </div>
    </div>
  );
}

function PctPill({ v, pts }: { v: number; pts?: number }) {
  const isPos = v > 0;
  const isNeg = v < 0;
  return (
    <div className="flex items-center gap-1.5 justify-end">
      <span
        className={cn(
          'inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded-sm text-[11px] font-bold tabular-nums font-mono',
          isPos
            ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
            : isNeg
            ? 'bg-rose-500/10 text-rose-400 border border-rose-500/20'
            : 'bg-zinc-800 text-zinc-400'
        )}
      >
        {isPos ? <ArrowUpRight className="h-3 w-3" /> : isNeg ? <ArrowDownRight className="h-3 w-3" /> : null}
        {isPos ? '+' : ''}
        {fmt(v)}%
      </span>
      {pts !== undefined && pts !== 0 && (
        <span
          className={cn(
            'text-[10px] font-mono tabular-nums',
            isPos ? 'text-emerald-400/80' : isNeg ? 'text-rose-400/80' : 'text-zinc-500'
          )}
        >
          ({isPos ? '+' : ''}₹{fmt(pts)})
        </span>
      )}
    </div>
  );
}

function SideBadge({ side }: { side: string }) {
  const isBuy = side.toUpperCase() === 'BUY';
  return (
    <span
      className={cn(
        'inline-flex items-center px-1.5 py-0.5 rounded-sm text-[10px] font-bold uppercase tracking-wider',
        isBuy
          ? 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30'
          : 'bg-rose-500/15 text-rose-400 border border-rose-500/30'
      )}
    >
      {side}
    </span>
  );
}

// Distance of the order's price from current LTP
function VsLtpBadge({ orderPrice, ltp, side }: { orderPrice: number; ltp: number; side?: string }) {
  if (!ltp || !orderPrice) return <span className="text-zinc-600 font-mono">—</span>;
  const diff = orderPrice - ltp;
  const pct = (diff / ltp) * 100;
  const isClose = Math.abs(pct) <= 0.5;

  return (
    <div
      className={cn(
        'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-sm text-[10px] font-mono tabular-nums border',
        isClose
          ? 'bg-amber-500/10 text-amber-300 border-amber-500/30 font-bold'
          : diff < 0
          ? 'bg-zinc-900/80 text-zinc-300 border-zinc-800'
          : 'bg-zinc-900/80 text-zinc-300 border-zinc-800'
      )}
      title={`Order price is ₹${Math.abs(diff).toFixed(2)} (${Math.abs(pct).toFixed(2)}%) ${
        diff < 0 ? 'below' : 'above'
      } LTP`}
    >
      <span className={diff < 0 ? 'text-amber-400 font-semibold' : 'text-emerald-400 font-semibold'}>
        {diff > 0 ? '+' : ''}
        {fmt(pct)}%
      </span>
      <span className="text-zinc-400">({diff > 0 ? '+' : ''}₹{fmt(diff)})</span>
    </div>
  );
}

// ─── Table Header Primitive ────────────────────────────────────────────────
function TH({
  children,
  right,
  className,
}: {
  children?: React.ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <th
      className={cn(
        'py-2 px-3 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wider whitespace-nowrap sticky top-0 z-10 select-none border-b border-zinc-700/60',
        right ? 'text-right' : 'text-left',
        className
      )}
    >
      {children}
    </th>
  );
}

function TD({
  children,
  right,
  className,
}: {
  children?: React.ReactNode;
  right?: boolean;
  className?: string;
}) {
  return (
    <td
      className={cn(
        'py-2.5 px-3 text-[12px] font-mono align-middle border-b border-zinc-800/60',
        right ? 'text-right' : 'text-left',
        className
      )}
    >
      {children}
    </td>
  );
}

// ─── Order Form / Modal Ticket State ───────────────────────────────────────
type OrderMode = 'PLACE' | 'MODIFY';
type OrderKind = 'FOREVER' | 'REGULAR';

interface OrderTicketState {
  symbol: string;
  name: string;
  ltp: number;
  tick: number;
  mode: OrderMode;
  orderId?: string;
  legName?: string | null;
  orderKind: OrderKind;
  transactionType: 'BUY' | 'SELL';
  productType: 'CNC' | 'INTRADAY';
  orderFlag: 'SINGLE' | 'OCO';
  quantityDraft: string;
  priceDraft: string;
  triggerPriceDraft: string;
  price1Draft: string;
  triggerPrice1Draft: string;
  quantity1Draft: string;
  autoSyncTrigger: boolean;
  submitting: boolean;
  error: string | null;
}

function createInitialTicket(
  symbol: string,
  name: string,
  ltp: number,
  tick: number,
  mode: OrderMode = 'PLACE',
  existing?: ForeverOrderRow,
  defaultDipPct?: number
): OrderTicketState {
  const initialSide = (existing?.transactionType as 'BUY' | 'SELL') ?? 'BUY';
  let initialPrice = ltp;

  if (defaultDipPct && ltp > 0) {
    initialPrice = Number((ltp * (1 + defaultDipPct / 100)).toFixed(2));
  } else if (existing) {
    initialPrice = existing.price;
  }

  // Trigger price defaults slightly above price for buy, or equal/custom
  let initialTrigger = existing ? existing.triggerPrice : initialPrice;
  if (!existing && initialSide === 'BUY' && ltp > 0) {
    initialTrigger = Number((initialPrice + Math.max(0.1, tick)).toFixed(2));
  } else if (!existing && initialSide === 'SELL' && ltp > 0) {
    initialTrigger = Number((initialPrice - Math.max(0.1, tick)).toFixed(2));
  }

  return {
    symbol,
    name,
    ltp,
    tick,
    mode,
    orderId: existing?.orderId,
    legName: existing?.legName,
    orderKind: 'FOREVER',
    transactionType: initialSide,
    productType: 'CNC',
    orderFlag: (existing?.orderFlag as 'SINGLE' | 'OCO') ?? 'SINGLE',
    quantityDraft: existing ? String(existing.quantity) : '10',
    priceDraft: initialPrice > 0 ? String(initialPrice) : '',
    triggerPriceDraft: initialTrigger > 0 ? String(initialTrigger) : '',
    price1Draft: '',
    triggerPrice1Draft: '',
    quantity1Draft: '',
    autoSyncTrigger: true,
    submitting: false,
    error: null,
  };
}

export default function EquityWatchlist() {
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [availableFunds, setAvailableFunds] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [autoIn, setAutoIn] = useState(12);
  const [autoPaused, setAutoPaused] = useState(false);
  const [addSymbol, setAddSymbol] = useState('');
  const [searchFilter, setSearchFilter] = useState('');
  const [activeTab, setActiveTab] = useState<'ALL' | 'ORDERS' | 'HOLDINGS'>('ALL');
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [ticket, setTicket] = useState<OrderTicketState | null>(null);
  const [cancelModal, setCancelModal] = useState<{
    orderId: string;
    symbol: string;
    side: string;
    qty: number;
    price: number;
  } | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const fetchSeqRef = useRef(0);
  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const addToast = useCallback((type: 'success' | 'error' | 'info', title: string, description?: string) => {
    const id = `${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    setToasts((prev) => [...prev.slice(-4), { id, type, title, description }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4500);
  }, []);

  const fetchData = useCallback(async (isInitial = false) => {
    const seq = ++fetchSeqRef.current;
    if (isInitial) setLoading(true);
    else setRefreshing(true);
    setError(null);

    try {
      const res = await fetch('/api/equity-watchlist');
      const json: WatchlistResponse = await res.json();
      if (seq !== fetchSeqRef.current) return;

      if (json.success) {
        setRows(json.rows ?? []);
        if (json.availableFunds !== undefined) setAvailableFunds(json.availableFunds);
        setAsOf(json.asOf ?? null);
      } else {
        setError(json.error ?? 'Failed to load watchlist data');
      }
    } catch (err) {
      if (seq === fetchSeqRef.current) {
        setError('Network connection error while fetching watchlist');
      }
    } finally {
      if (seq === fetchSeqRef.current) {
        setLoading(false);
        setRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    fetchData(true);
  }, [fetchData]);

  // Load symbols for autocomplete
  useEffect(() => {
    fetch('/api/symbols')
      .then((r) => r.json())
      .then((j: SymbolsResponse) => {
        if (j.success && Array.isArray(j.symbols)) setAllSymbols(j.symbols);
      })
      .catch(() => {});
  }, []);

  // Auto-refresh timer loop
  useEffect(() => {
    if (autoRef.current) clearInterval(autoRef.current);
    if (autoPaused) return;

    setAutoIn(12);
    autoRef.current = setInterval(() => {
      setAutoIn((c) => {
        if (c <= 1) {
          fetchData(false);
          return 12;
        }
        return c - 1;
      });
    }, 1000);

    return () => {
      if (autoRef.current) clearInterval(autoRef.current);
    };
  }, [rows, autoPaused, fetchData]);

  // Add symbol to watchlist
  const handleAddSymbol = useCallback(
    async (sym?: string) => {
      const s = (sym ?? addSymbol).trim().toUpperCase();
      if (!s) return;
      setAddSymbol('');

      try {
        const res = await fetch('/api/equity-watchlist', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: s }),
        });
        const json = await res.json();
        if (json.success) {
          addToast('success', `Added ${s} to Watchlist`);
          fetchData(false);
        } else {
          addToast('error', `Could not add ${s}`, json.error);
        }
      } catch {
        addToast('error', `Failed to add ${s}`);
      }
    },
    [addSymbol, fetchData, addToast]
  );

  // Remove symbol from watchlist
  const handleRemoveSymbol = useCallback(
    async (symbol: string) => {
      try {
        const res = await fetch('/api/equity-watchlist', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol }),
        });
        const json = await res.json();
        if (json.success) {
          addToast('info', `Removed ${symbol} from Watchlist`);
          setRows((prev) => prev.filter((r) => r.symbol !== symbol));
          fetchData(false);
        }
      } catch {
        addToast('error', `Failed to remove ${symbol}`);
      }
    },
    [fetchData, addToast]
  );

  // Open ticket helper
  const openOrderTicket = useCallback(
    (
      symbol: string,
      name: string,
      ltp: number,
      tick: number,
      mode: OrderMode = 'PLACE',
      existing?: ForeverOrderRow,
      dipPct?: number
    ) => {
      setTicket(createInitialTicket(symbol, name, ltp, tick, mode, existing, dipPct));
    },
    []
  );

  // Submit order from Ticket
  const handleSubmitTicket = useCallback(async () => {
    if (!ticket) return;

    const qty = parseInt(ticket.quantityDraft, 10);
    const price = parseFloat(ticket.priceDraft);
    const triggerPrice = parseFloat(ticket.triggerPriceDraft);

    if (!qty || qty <= 0) {
      setTicket({ ...ticket, error: 'Please enter a valid positive quantity' });
      return;
    }
    if (!price || price <= 0) {
      setTicket({ ...ticket, error: 'Please enter a valid limit price' });
      return;
    }
    if (ticket.orderKind === 'FOREVER' && (!triggerPrice || triggerPrice <= 0)) {
      setTicket({ ...ticket, error: 'Please enter a valid trigger price for Forever order' });
      return;
    }

    setTicket((prev) => (prev ? { ...prev, submitting: true, error: null } : prev));

    try {
      if (ticket.mode === 'PLACE') {
        const res = await fetch('/api/equity-watchlist/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: ticket.symbol,
            transactionType: ticket.transactionType,
            quantity: qty,
            price: price,
            triggerPrice: triggerPrice,
            orderFlag: ticket.orderFlag,
            orderKind: ticket.orderKind,
            productType: ticket.productType,
            price1: ticket.price1Draft ? parseFloat(ticket.price1Draft) : undefined,
            triggerPrice1: ticket.triggerPrice1Draft ? parseFloat(ticket.triggerPrice1Draft) : undefined,
            quantity1: ticket.quantity1Draft ? parseInt(ticket.quantity1Draft, 10) : undefined,
          }),
        });

        const json = await res.json();
        if (!json.success) throw new Error(json.error ?? 'Failed to place order');

        addToast(
          'success',
          `${ticket.orderKind === 'FOREVER' ? 'GTT' : 'Day'} Limit Order Placed`,
          `${ticket.transactionType} ${qty} ${ticket.symbol} @ ₹${fmt(price)}`
        );
      } else {
        // Modify forever order
        const res = await fetch('/api/equity-watchlist/orders', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: ticket.orderId,
            orderFlag: ticket.orderFlag,
            legName: ticket.legName ?? 'STOP_LOSS_LEG',
            quantity: qty,
            price: price,
            triggerPrice: triggerPrice,
          }),
        });

        const json = await res.json();
        if (!json.success) throw new Error(json.error ?? 'Failed to modify order');

        addToast(
          'success',
          'Order Modified Successfully',
          `${ticket.symbol} order #${ticket.orderId} updated to ${qty} @ ₹${fmt(price)}`
        );
      }

      setTicket(null);
      fetchData(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setTicket((prev) => (prev ? { ...prev, submitting: false, error: msg } : prev));
    }
  }, [ticket, fetchData, addToast]);

  // Submit cancel order
  const handleCancelOrder = useCallback(async () => {
    if (!cancelModal) return;
    setCancelSubmitting(true);

    try {
      const res = await fetch('/api/equity-watchlist/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: cancelModal.orderId }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to cancel order');

      addToast('info', 'Order Cancelled', `Forever order for ${cancelModal.symbol} was removed`);
      setCancelModal(null);
      fetchData(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      addToast('error', 'Cancellation Failed', msg);
    } finally {
      setCancelSubmitting(false);
    }
  }, [cancelModal, fetchData, addToast]);

  // Quick liquid symbols suggestions
  const quickPicks = useMemo(() => {
    const defaultPicks = ['RELIANCE', 'HDFCBANK', 'TCS', 'INFY', 'ICICIBANK', 'LT', 'SBIN', 'TATAMOTORS'];
    const current = new Set(rows.map((r) => r.symbol));
    return defaultPicks.filter((s) => !current.has(s));
  }, [rows]);

  // Filtered rows for display
  const filteredRows = useMemo(() => {
    let result = rows;
    if (searchFilter.trim()) {
      const q = searchFilter.trim().toUpperCase();
      result = result.filter((r) => r.symbol.includes(q) || r.name.toUpperCase().includes(q));
    }
    if (activeTab === 'ORDERS') {
      result = result.filter((r) => r.foreverOrders.length > 0);
    } else if (activeTab === 'HOLDINGS') {
      result = result.filter((r) => r.portfolioQty > 0);
    }
    return result;
  }, [rows, searchFilter, activeTab]);

  // Summary Metrics
  const summaryMetrics = useMemo(() => {
    let totalCommitted = 0;
    let totalActiveOrders = 0;
    let totalHoldingsVal = 0;

    for (const r of rows) {
      if (r.portfolioQty > 0 && r.ltp > 0) {
        totalHoldingsVal += r.portfolioQty * r.ltp;
      }
      for (const o of r.foreverOrders) {
        if (o.status.toUpperCase() === 'PENDING') {
          totalActiveOrders++;
          if (o.transactionType.toUpperCase() === 'BUY') {
            totalCommitted += o.quantity * o.price;
          }
        }
      }
    }

    return { totalCommitted, totalActiveOrders, totalHoldingsVal };
  }, [rows]);

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100 select-none">
      {/* ─── Sticky Header ─────────────────────────────────────────────────── */}
      <header className="w-full border-b border-zinc-800/80 bg-zinc-950/90 backdrop-blur-md px-4 py-2.5 flex flex-wrap items-center gap-3 z-30 sticky top-0">
        <div className="flex items-center gap-2.5 mr-1">
          <div className="h-7 w-7 rounded-md bg-amber-500/10 border border-amber-500/30 flex items-center justify-center shrink-0 shadow-sm">
            <TrendingUp className="h-4 w-4 text-amber-400" />
          </div>
          <div className="flex flex-col">
            <span className="text-[13px] font-bold tracking-wider text-amber-400 uppercase font-mono leading-none">
              EQUITY WATCHLIST & LIMIT DESK
            </span>
            <span className="text-[10px] text-zinc-400 font-mono tracking-tight mt-0.5">
              Instant GTT Forever & Exchange Limit Orders
            </span>
          </div>
        </div>

        <div className="w-px h-6 bg-zinc-800 hidden sm:block" />
        <NavBar />

        {/* Header Badges & Quick Stats */}
        <div className="flex items-center gap-2 ml-auto flex-wrap">
          {availableFunds !== null && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] font-mono">
              <Wallet className="h-3 w-3 text-emerald-400" />
              <span className="text-zinc-400 uppercase text-[10px]">CASH:</span>
              <span className="font-bold text-emerald-400">₹{fmtInr(availableFunds, 0)}</span>
            </div>
          )}

          {summaryMetrics.totalCommitted > 0 && (
            <div className="flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] font-mono">
              <span className="text-zinc-400 uppercase text-[10px]">COMMITTED:</span>
              <span className="font-bold text-amber-400">₹{fmtInr(summaryMetrics.totalCommitted, 0)}</span>
            </div>
          )}

          {summaryMetrics.totalActiveOrders > 0 && (
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-sky-500/10 border border-sky-500/25 text-[11px] font-mono text-sky-400">
              <Zap className="h-3 w-3" />
              <span className="font-bold">{summaryMetrics.totalActiveOrders} GTT ACTIVE</span>
            </div>
          )}

          {asOf && (
            <span className="text-[10px] font-mono font-bold text-zinc-400 hidden xl:inline px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
              DATA: {new Date(asOf).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </span>
          )}

          {/* Auto Refresh toggle & countdown */}
          <button
            onClick={() => setAutoPaused((p) => !p)}
            className="flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 text-[10px] font-mono text-zinc-400 hover:text-zinc-200 transition-colors"
            title={autoPaused ? 'Resume auto-refresh' : 'Pause auto-refresh'}
          >
            {autoPaused ? <Play className="h-2.5 w-2.5 text-amber-400" /> : <Pause className="h-2.5 w-2.5" />}
            <span>{autoPaused ? 'PAUSED' : `AUTO ${fmtCountdown(autoIn)}`}</span>
          </button>

          {/* Manual Refresh */}
          <button
            onClick={() => fetchData(false)}
            disabled={refreshing || loading}
            title="Refresh Quotes Now"
            className="h-7 w-7 flex items-center justify-center rounded-md border border-zinc-800 bg-zinc-900 text-zinc-400 hover:text-amber-400 hover:border-amber-500/40 transition-all disabled:opacity-50"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', (refreshing || loading) && 'animate-spin text-amber-400')} />
          </button>
        </div>
      </header>

      {/* ─── Main Content Area ─────────────────────────────────────────────── */}
      <main className="flex-1 w-full mx-auto px-4 py-3 flex flex-col gap-3.5 max-w-[1720px]">
        {/* Controls Toolbar: Add symbol + Quick picks + Table search filter */}
        <div className="flex flex-wrap items-center justify-between gap-3 p-3 rounded-lg bg-zinc-950/80 border border-zinc-800/80 shadow-sm">
          {/* Left: Add Symbol Input + Quick picks */}
          <div className="flex items-center gap-2 flex-wrap">
            <div className="relative">
              <input
                list="equity-symbols-list"
                value={addSymbol}
                onChange={(e) => setAddSymbol(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleAddSymbol();
                }}
                placeholder="Search symbol (e.g. RELIANCE)"
                className="bg-zinc-900 border border-zinc-700/80 rounded-md px-3 py-1.5 text-xs font-mono w-60 placeholder:text-zinc-500 focus:outline-none focus:border-amber-500/60 transition-colors"
              />
              <datalist id="equity-symbols-list">
                {allSymbols.slice(0, 150).map((s) => (
                  <option key={s} value={s} />
                ))}
              </datalist>
            </div>

            <button
              onClick={() => handleAddSymbol()}
              disabled={!addSymbol.trim()}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-amber-500 text-oncolor-dark text-xs font-bold uppercase tracking-wider hover:bg-amber-400 transition-colors disabled:opacity-40"
            >
              <Plus className="h-3.5 w-3.5" />
              Add Stock
            </button>

            {/* Quick liquid suggestions */}
            {quickPicks.length > 0 && (
              <div className="flex items-center gap-1.5 ml-2 hidden lg:flex">
                <span className="text-[10px] uppercase font-mono text-zinc-500">Quick add:</span>
                <div className="flex items-center gap-1 flex-wrap">
                  {quickPicks.slice(0, 5).map((qp) => (
                    <button
                      key={qp}
                      onClick={() => handleAddSymbol(qp)}
                      className="px-2 py-0.5 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 hover:text-white text-[10px] font-mono transition-colors"
                    >
                      +{qp}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>

          {/* Right: Table search & Filter Tabs */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="relative">
              <Search className="absolute left-2.5 top-2 h-3.5 w-3.5 text-zinc-500" />
              <input
                type="text"
                value={searchFilter}
                onChange={(e) => setSearchFilter(e.target.value)}
                placeholder="Filter watchlist..."
                className="pl-8 pr-3 py-1.5 bg-zinc-900 border border-zinc-800 rounded-md text-xs font-mono w-44 placeholder:text-zinc-500 focus:outline-none focus:border-zinc-600 transition-colors"
              />
              {searchFilter && (
                <button
                  onClick={() => setSearchFilter('')}
                  className="absolute right-2 top-2 text-zinc-500 hover:text-zinc-300"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {/* Filter Tabs */}
            <div className="flex p-0.5 rounded-md bg-zinc-900 border border-zinc-800 text-[11px] font-mono">
              <button
                onClick={() => setActiveTab('ALL')}
                className={cn(
                  'px-2.5 py-1 rounded-sm transition-colors font-semibold',
                  activeTab === 'ALL' ? 'bg-zinc-800 text-white' : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                All ({rows.length})
              </button>
              <button
                onClick={() => setActiveTab('ORDERS')}
                className={cn(
                  'px-2.5 py-1 rounded-sm transition-colors font-semibold',
                  activeTab === 'ORDERS' ? 'bg-zinc-800 text-amber-400' : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                GTT Orders ({summaryMetrics.totalActiveOrders})
              </button>
              <button
                onClick={() => setActiveTab('HOLDINGS')}
                className={cn(
                  'px-2.5 py-1 rounded-sm transition-colors font-semibold',
                  activeTab === 'HOLDINGS' ? 'bg-zinc-800 text-emerald-400' : 'text-zinc-400 hover:text-zinc-200'
                )}
              >
                Holdings ({rows.filter((r) => r.portfolioQty > 0).length})
              </button>
            </div>
          </div>
        </div>

        {error && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-md border border-rose-500/30 bg-rose-500/10 text-xs text-rose-300 font-mono">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{error}</span>
          </div>
        )}

        {/* ─── Watchlist Table Card ────────────────────────────────────────── */}
        <div className="border border-zinc-800 bg-zinc-950 rounded-lg overflow-hidden shadow-xl flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <TH className="min-w-[190px]">Stock & Ticker</TH>
                  <TH right className="min-w-[130px]">LTP (₹)</TH>
                  <TH right className="min-w-[150px]">Day Change</TH>
                  <TH className="min-w-[160px]">Day Range</TH>
                  <TH right className="min-w-[140px]">Holdings</TH>
                  <TH className="min-w-[340px]">Active GTT & Limit Orders</TH>
                  <TH className="min-w-[260px]">Fast Limit Actions</TH>
                  <TH className="w-10"></TH>
                </tr>
              </thead>
              <tbody>
                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={8} className="text-center text-zinc-500 text-xs py-14 font-mono">
                      {loading ? (
                        <div className="flex items-center justify-center gap-2 text-zinc-400">
                          <RefreshCw className="h-4 w-4 animate-spin text-amber-400" />
                          <span>Fetching quotes & orders from Dhan...</span>
                        </div>
                      ) : rows.length === 0 ? (
                        <div className="flex flex-col items-center gap-2">
                          <span className="text-zinc-400 text-[13px] font-bold">Watchlist is currently empty</span>
                          <span className="text-zinc-600 text-xs">Add a stock symbol above to begin monitoring and placing limit orders.</span>
                        </div>
                      ) : (
                        <span>No stocks matching filter &quot;{searchFilter}&quot;</span>
                      )}
                    </td>
                  </tr>
                )}

                {filteredRows.map((r) => {
                  const hasOrders = r.foreverOrders.length > 0;
                  const hasHolding = r.portfolioQty > 0;

                  return (
                    <tr
                      key={r.symbol}
                      className="border-b border-zinc-800/60 hover:bg-zinc-900/40 transition-colors group align-middle"
                    >
                      {/* Stock Symbol & Company Name */}
                      <TD>
                        <div className="flex flex-col gap-0.5">
                          <div className="flex items-center gap-2">
                            <span className="font-bold text-[13px] text-white tracking-wide font-mono">
                              {r.symbol}
                            </span>
                            {hasHolding && (
                              <span className="px-1.5 py-0.5 rounded-sm bg-purple-500/15 border border-purple-500/30 text-purple-400 text-[10px] font-bold font-mono">
                                HELD: {r.portfolioQty}
                              </span>
                            )}
                          </div>
                          <span className="text-[10px] text-zinc-400 truncate max-w-[180px]" title={r.name}>
                            {r.name}
                          </span>
                        </div>
                      </TD>

                      {/* LTP */}
                      <TD right>
                        <div className="flex flex-col items-end">
                          <span className="font-bold text-[14px] text-white tracking-tight tabular-nums font-mono">
                            ₹{fmt(r.ltp)}
                          </span>
                          <span className="text-[10px] text-zinc-400 font-mono">
                            Tick: ₹{fmt(r.tick)}
                          </span>
                        </div>
                      </TD>

                      {/* Day % & Points */}
                      <TD right>
                        <PctPill v={r.dayChangePct} pts={r.dayChangeRs} />
                      </TD>

                      {/* Day Range Low - High */}
                      <TD>
                        <DayRangeBar low={r.low} high={r.high} ltp={r.ltp} />
                      </TD>

                      {/* Holdings & P&L */}
                      <TD right>
                        {hasHolding ? (
                          <div className="flex flex-col items-end gap-0.5">
                            <span className="font-bold text-zinc-200 font-mono text-[12px]">
                              {r.portfolioQty} sh @ ₹{fmt(r.avgCostPrice)}
                            </span>
                            <span
                              className={cn(
                                'text-[11px] font-bold font-mono',
                                r.unrealizedPnl > 0
                                  ? 'text-emerald-400'
                                  : r.unrealizedPnl < 0
                                  ? 'text-rose-400'
                                  : 'text-zinc-500'
                              )}
                            >
                              {r.unrealizedPnl > 0 ? '+' : ''}₹{fmt(r.unrealizedPnl)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-zinc-600 font-mono">—</span>
                        )}
                      </TD>

                      {/* Active Forever / GTT Orders */}
                      <TD>
                        {!hasOrders ? (
                          <span className="text-zinc-600 font-mono text-[11px]">No active orders</span>
                        ) : (
                          <div className="flex flex-col gap-1.5">
                            {r.foreverOrders.map((o) => (
                              <div
                                key={o.orderId}
                                className="flex items-center justify-between gap-2 p-1.5 rounded-md bg-zinc-900/90 border border-zinc-800 text-[11px] font-mono shadow-sm"
                              >
                                <div className="flex items-center gap-1.5 flex-wrap">
                                  <SideBadge side={o.transactionType} />
                                  <span className="font-bold text-white">
                                    {o.quantity} @ ₹{fmt(o.price)}
                                  </span>
                                  <span className="text-zinc-400 text-[10px]">
                                    (Trig: ₹{fmt(o.triggerPrice)})
                                  </span>
                                  <VsLtpBadge orderPrice={o.price} ltp={r.ltp} side={o.transactionType} />
                                </div>

                                <div className="flex items-center gap-1 shrink-0 ml-auto">
                                  <button
                                    onClick={() => openOrderTicket(r.symbol, r.name, r.ltp, r.tick, 'MODIFY', o)}
                                    title="Modify this limit order"
                                    className="p-1 rounded-sm hover:bg-zinc-800 text-zinc-400 hover:text-amber-400 transition-colors"
                                  >
                                    <Edit2 className="h-3 w-3" />
                                  </button>
                                  <button
                                    onClick={() =>
                                      setCancelModal({
                                        orderId: o.orderId,
                                        symbol: r.symbol,
                                        side: o.transactionType,
                                        qty: o.quantity,
                                        price: o.price,
                                      })
                                    }
                                    title="Cancel this order"
                                    className="p-1 rounded-sm hover:bg-zinc-800 text-zinc-400 hover:text-rose-400 transition-colors"
                                  >
                                    <Trash2 className="h-3 w-3" />
                                  </button>
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </TD>

                      {/* Fast Limit Actions (The Core "Faster & Sleek" Feature) */}
                      <TD>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {/* Standard Order Ticket Button */}
                          <button
                            onClick={() => openOrderTicket(r.symbol, r.name, r.ltp, r.tick, 'PLACE')}
                            className="flex items-center gap-1 px-2.5 py-1 rounded-md bg-amber-500/10 hover:bg-amber-500/20 text-amber-400 border border-amber-500/30 text-[11px] font-bold uppercase tracking-wider transition-colors shadow-sm"
                          >
                            <Plus className="h-3 w-3" />
                            + Limit
                          </button>

                          {/* Instant Dip Presets (Clicking preloads ticket with 1% or 2% dip) */}
                          <button
                            onClick={() => openOrderTicket(r.symbol, r.name, r.ltp, r.tick, 'PLACE', undefined, -1.0)}
                            title="Preload Buy Limit at 1% below current LTP"
                            className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 hover:border-emerald-500/40 text-emerald-400/90 hover:text-emerald-300 text-[10px] font-mono font-semibold transition-colors"
                          >
                            Dip -1%
                          </button>

                          <button
                            onClick={() => openOrderTicket(r.symbol, r.name, r.ltp, r.tick, 'PLACE', undefined, -2.0)}
                            title="Preload Buy Limit at 2% below current LTP"
                            className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 hover:border-emerald-500/40 text-emerald-400/90 hover:text-emerald-300 text-[10px] font-mono font-semibold transition-colors"
                          >
                            Dip -2%
                          </button>

                          {hasHolding && (
                            <button
                              onClick={() => {
                                const t = createInitialTicket(r.symbol, r.name, r.ltp, r.tick, 'PLACE', undefined, 2.0);
                                t.transactionType = 'SELL';
                                t.quantityDraft = String(r.portfolioQty);
                                setTicket(t);
                              }}
                              title="Preload Sell Limit at 2% above current LTP for your held shares"
                              className="px-2 py-1 rounded-md bg-zinc-900 border border-zinc-800 hover:border-rose-500/40 text-rose-400/90 hover:text-rose-300 text-[10px] font-mono font-semibold transition-colors"
                            >
                              Target +2%
                            </button>
                          )}
                        </div>
                      </TD>

                      {/* Remove from watchlist */}
                      <TD right>
                        <button
                          onClick={() => handleRemoveSymbol(r.symbol)}
                          title={`Remove ${r.symbol} from watchlist`}
                          className="h-7 w-7 flex items-center justify-center rounded-md text-zinc-500 hover:text-rose-400 hover:bg-rose-500/10 transition-colors"
                        >
                          <X className="h-3.5 w-3.5" />
                        </button>
                      </TD>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      </main>

      {/* ─── Fast Order Execution Drawer / Modal ────────────────────────────── */}
      {ticket && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div
            className="w-full max-w-lg bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl overflow-hidden flex flex-col gap-0 animate-in zoom-in-95 duration-150"
            onKeyDown={(e) => {
              if (e.key === 'Escape') setTicket(null);
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSubmitTicket();
            }}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-5 py-3.5 border-b border-zinc-800/80 bg-zinc-900/60">
              <div className="flex items-center gap-2.5">
                <div
                  className={cn(
                    'h-7 w-7 rounded-md flex items-center justify-center border font-bold text-xs font-mono',
                    ticket.transactionType === 'BUY'
                      ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400'
                      : 'bg-rose-500/10 border-rose-500/30 text-rose-400'
                  )}
                >
                  {ticket.transactionType === 'BUY' ? 'B' : 'S'}
                </div>
                <div className="flex flex-col">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-[14px] text-white font-mono">{ticket.symbol}</span>
                    <span className="text-[11px] text-zinc-400 font-mono">LTP: ₹{fmt(ticket.ltp)}</span>
                  </div>
                  <span className="text-[10px] text-zinc-400 truncate max-w-[280px]">{ticket.name}</span>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-sm bg-zinc-800 text-zinc-300 uppercase">
                  {ticket.mode === 'PLACE' ? 'New Limit Order' : `Modify #${ticket.orderId}`}
                </span>
                <button
                  onClick={() => setTicket(null)}
                  className="h-7 w-7 flex items-center justify-center rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
                >
                  <X className="h-4 w-4" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="p-5 flex flex-col gap-4 text-xs font-mono">
              {/* Order Kind Tabs: GTT Forever vs Regular Day */}
              {ticket.mode === 'PLACE' && (
                <div className="grid grid-cols-2 p-1 rounded-lg bg-zinc-900 border border-zinc-800 text-xs font-bold text-center">
                  <button
                    type="button"
                    onClick={() => setTicket({ ...ticket, orderKind: 'FOREVER', productType: 'CNC' })}
                    className={cn(
                      'py-1.5 rounded-md transition-all flex items-center justify-center gap-1.5',
                      ticket.orderKind === 'FOREVER'
                        ? 'bg-amber-500 text-oncolor-dark shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    )}
                  >
                    <Clock className="h-3.5 w-3.5" />
                    <span>FOREVER (GTT)</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setTicket({ ...ticket, orderKind: 'REGULAR' })}
                    className={cn(
                      'py-1.5 rounded-md transition-all flex items-center justify-center gap-1.5',
                      ticket.orderKind === 'REGULAR'
                        ? 'bg-amber-500 text-oncolor-dark shadow-sm'
                        : 'text-zinc-400 hover:text-zinc-200'
                    )}
                  >
                    <Zap className="h-3.5 w-3.5" />
                    <span>REGULAR (DAY)</span>
                  </button>
                </div>
              )}

              {/* Side Selector: BUY vs SELL */}
              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={() => setTicket({ ...ticket, transactionType: 'BUY' })}
                  className={cn(
                    'py-2 rounded-lg font-bold uppercase tracking-wider text-xs border transition-all flex items-center justify-center gap-1.5',
                    ticket.transactionType === 'BUY'
                      ? 'bg-emerald-500/20 border-emerald-500 text-emerald-300 shadow-sm'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  <ArrowUpRight className="h-4 w-4" />
                  BUY LIMIT
                </button>
                <button
                  type="button"
                  onClick={() => setTicket({ ...ticket, transactionType: 'SELL' })}
                  className={cn(
                    'py-2 rounded-lg font-bold uppercase tracking-wider text-xs border transition-all flex items-center justify-center gap-1.5',
                    ticket.transactionType === 'SELL'
                      ? 'bg-rose-500/20 border-rose-500 text-rose-300 shadow-sm'
                      : 'bg-zinc-900 border-zinc-800 text-zinc-400 hover:text-zinc-200'
                  )}
                >
                  <ArrowDownRight className="h-4 w-4" />
                  SELL LIMIT
                </button>
              </div>

              {/* Limit Price Input with Quick Percent Offsets */}
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="font-bold text-zinc-300 uppercase">Limit Price (₹)</span>
                  {ticket.ltp > 0 && ticket.priceDraft && (
                    <VsLtpBadge
                      orderPrice={parseFloat(ticket.priceDraft) || 0}
                      ltp={ticket.ltp}
                      side={ticket.transactionType}
                    />
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    step={ticket.tick || 0.05}
                    value={ticket.priceDraft}
                    onChange={(e) => {
                      const newP = e.target.value;
                      const pNum = parseFloat(newP) || 0;
                      let newTrig = ticket.triggerPriceDraft;
                      if (ticket.autoSyncTrigger && pNum > 0) {
                        newTrig =
                          ticket.transactionType === 'BUY'
                            ? String(Number((pNum + Math.max(0.1, ticket.tick)).toFixed(2)))
                            : String(Number((pNum - Math.max(0.1, ticket.tick)).toFixed(2)));
                      }
                      setTicket({ ...ticket, priceDraft: newP, triggerPriceDraft: newTrig });
                    }}
                    className="flex-1 bg-zinc-900 border border-zinc-700/80 rounded-md px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-amber-500"
                    placeholder="Enter price"
                  />
                  {/* Steppers */}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        const cur = parseFloat(ticket.priceDraft) || ticket.ltp || 100;
                        const next = Number((cur - 1).toFixed(2));
                        setTicket({
                          ...ticket,
                          priceDraft: String(next),
                          triggerPriceDraft: ticket.autoSyncTrigger
                            ? String(Number((next + Math.max(0.1, ticket.tick)).toFixed(2)))
                            : ticket.triggerPriceDraft,
                        });
                      }}
                      className="px-2 py-2 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs font-mono"
                    >
                      -₹1
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const cur = parseFloat(ticket.priceDraft) || ticket.ltp || 100;
                        const next = Number((cur + 1).toFixed(2));
                        setTicket({
                          ...ticket,
                          priceDraft: String(next),
                          triggerPriceDraft: ticket.autoSyncTrigger
                            ? String(Number((next + Math.max(0.1, ticket.tick)).toFixed(2)))
                            : ticket.triggerPriceDraft,
                        });
                      }}
                      className="px-2 py-2 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs font-mono"
                    >
                      +₹1
                    </button>
                  </div>
                </div>

                {/* Quick Price Preset Chips */}
                {ticket.ltp > 0 && (
                  <div className="flex items-center gap-1 flex-wrap pt-0.5">
                    <span className="text-[10px] text-zinc-500 uppercase mr-1">Presets:</span>
                    <button
                      type="button"
                      onClick={() => {
                        const p = ticket.ltp;
                        setTicket({
                          ...ticket,
                          priceDraft: String(p),
                          triggerPriceDraft: ticket.autoSyncTrigger
                            ? String(Number((p + 0.1).toFixed(2)))
                            : ticket.triggerPriceDraft,
                        });
                      }}
                      className="px-1.5 py-0.5 rounded-sm bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-[10px]"
                    >
                      LTP
                    </button>
                    {(ticket.transactionType === 'BUY'
                      ? [-0.5, -1.0, -2.0, -3.0, -5.0]
                      : [0.5, 1.0, 2.0, 3.0, 5.0]
                    ).map((pct) => (
                      <button
                        key={pct}
                        type="button"
                        onClick={() => {
                          const p = Number((ticket.ltp * (1 + pct / 100)).toFixed(2));
                          const trig =
                            ticket.transactionType === 'BUY'
                              ? Number((p + Math.max(0.1, ticket.tick)).toFixed(2))
                              : Number((p - Math.max(0.1, ticket.tick)).toFixed(2));
                          setTicket({
                            ...ticket,
                            priceDraft: String(p),
                            triggerPriceDraft: ticket.autoSyncTrigger ? String(trig) : ticket.triggerPriceDraft,
                          });
                        }}
                        className="px-1.5 py-0.5 rounded-sm bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-[10px]"
                      >
                        {pct > 0 ? `+${pct}%` : `${pct}%`}
                      </button>
                    ))}
                  </div>
                )}
              </div>

              {/* Trigger Price (for Forever Orders) */}
              {ticket.orderKind === 'FOREVER' && (
                <div className="flex flex-col gap-1.5">
                  <div className="flex justify-between items-center text-[11px]">
                    <span className="font-bold text-zinc-300 uppercase">Trigger Price (₹)</span>
                    <label className="flex items-center gap-1.5 cursor-pointer text-[10px] text-zinc-400">
                      <input
                        type="checkbox"
                        checked={ticket.autoSyncTrigger}
                        onChange={(e) => setTicket({ ...ticket, autoSyncTrigger: e.target.checked })}
                        className="rounded border-zinc-700 bg-zinc-900 text-amber-500 focus:ring-0"
                      />
                      <span>Auto-sync trigger</span>
                    </label>
                  </div>
                  <input
                    type="number"
                    step={ticket.tick || 0.05}
                    value={ticket.triggerPriceDraft}
                    onChange={(e) => setTicket({ ...ticket, triggerPriceDraft: e.target.value })}
                    className="bg-zinc-900 border border-zinc-700/80 rounded-md px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-amber-500"
                    placeholder="Enter trigger price"
                  />
                  <span className="text-[10px] text-zinc-400">
                    Order activates on Dhan when LTP crosses Trigger, then places Limit order.
                  </span>
                </div>
              )}

              {/* Quantity Input with Quick Amount / Share Presets */}
              <div className="flex flex-col gap-1.5">
                <div className="flex justify-between items-center text-[11px]">
                  <span className="font-bold text-zinc-300 uppercase">Quantity (Shares)</span>
                  {ticket.priceDraft && (
                    <span className="text-zinc-400 font-mono">
                      Order Val: ₹
                      {fmtInr((parseFloat(ticket.quantityDraft) || 0) * (parseFloat(ticket.priceDraft) || 0), 0)}
                    </span>
                  )}
                </div>

                <div className="flex items-center gap-2">
                  <input
                    type="number"
                    min="1"
                    value={ticket.quantityDraft}
                    onChange={(e) => setTicket({ ...ticket, quantityDraft: e.target.value })}
                    className="flex-1 bg-zinc-900 border border-zinc-700/80 rounded-md px-3 py-2 text-sm font-mono text-white focus:outline-none focus:border-amber-500"
                    placeholder="Quantity"
                  />
                  {/* Share steppers */}
                  <div className="flex items-center gap-1">
                    <button
                      type="button"
                      onClick={() => {
                        const cur = parseInt(ticket.quantityDraft, 10) || 10;
                        setTicket({ ...ticket, quantityDraft: String(Math.max(1, cur - 10)) });
                      }}
                      className="px-2 py-2 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs font-mono"
                    >
                      -10
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        const cur = parseInt(ticket.quantityDraft, 10) || 10;
                        setTicket({ ...ticket, quantityDraft: String(cur + 10) });
                      }}
                      className="px-2 py-2 rounded-md bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-xs font-mono"
                    >
                      +10
                    </button>
                  </div>
                </div>

                {/* Capital Presets */}
                <div className="flex items-center gap-1 flex-wrap pt-0.5">
                  <span className="text-[10px] text-zinc-500 uppercase mr-1">Amounts:</span>
                  {[10_000, 25_000, 50_000, 100_000].map((amt) => {
                    const price = parseFloat(ticket.priceDraft) || ticket.ltp || 1;
                    const calculatedQty = Math.max(1, Math.floor(amt / price));
                    return (
                      <button
                        key={amt}
                        type="button"
                        onClick={() => setTicket({ ...ticket, quantityDraft: String(calculatedQty) })}
                        className="px-1.5 py-0.5 rounded-sm bg-zinc-900 border border-zinc-800 hover:border-zinc-700 text-zinc-300 text-[10px]"
                      >
                        ₹{amt >= 100_000 ? `${amt / 100_000}L` : `${amt / 1_000}k`} ({calculatedQty} sh)
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Order Summary & Funds Check */}
              {(() => {
                const qty = parseInt(ticket.quantityDraft, 10) || 0;
                const price = parseFloat(ticket.priceDraft) || 0;
                const totalReq = qty * price;
                const isInsufficient =
                  ticket.transactionType === 'BUY' &&
                  availableFunds !== null &&
                  totalReq > (availableFunds ?? 0);

                return (
                  <div className="p-3 rounded-lg bg-zinc-900/80 border border-zinc-800 flex flex-col gap-1.5">
                    <div className="flex justify-between items-center text-xs">
                      <span className="text-zinc-400">Total Order Capital:</span>
                      <span className="font-bold text-white font-mono text-[13px]">
                        ₹{fmtInr(totalReq, 0)}
                      </span>
                    </div>

                    {availableFunds !== null && (
                      <div className="flex justify-between items-center text-[11px] text-zinc-400">
                        <span>Available Cash:</span>
                        <span className="font-mono text-zinc-300">₹{fmtInr(availableFunds, 0)}</span>
                      </div>
                    )}

                    {isInsufficient && (
                      <div className="flex items-center gap-1.5 text-rose-400 text-[11px] mt-1 pt-1 border-t border-zinc-800">
                        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                        <span>Insufficient funds! Balance is ₹{fmtInr(availableFunds ?? 0, 0)}.</span>
                      </div>
                    )}
                  </div>
                );
              })()}

              {ticket.error && (
                <div className="p-2.5 rounded-md border border-rose-500/40 bg-rose-500/10 text-xs text-rose-300 font-mono">
                  {ticket.error}
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-2 pt-2">
                <button
                  type="button"
                  disabled={ticket.submitting}
                  onClick={handleSubmitTicket}
                  className={cn(
                    'flex-1 py-2.5 rounded-lg font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-all shadow-lg disabled:opacity-50',
                    ticket.transactionType === 'BUY'
                      ? 'bg-emerald-500 hover:bg-emerald-400 text-oncolor-dark'
                      : 'bg-rose-500 hover:bg-rose-400 text-oncolor-dark'
                  )}
                >
                  {ticket.submitting ? (
                    <>
                      <RefreshCw className="h-4 w-4 animate-spin" />
                      <span>Transmitting to Dhan...</span>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="h-4 w-4" />
                      <span>
                        {ticket.mode === 'PLACE' ? 'Place' : 'Update'}{' '}
                        {ticket.orderKind === 'FOREVER' ? 'GTT Forever' : 'Day'}{' '}
                        {ticket.transactionType} Order
                      </span>
                    </>
                  )}
                </button>

                <button
                  type="button"
                  disabled={ticket.submitting}
                  onClick={() => setTicket(null)}
                  className="px-4 py-2.5 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white uppercase tracking-wider text-xs font-semibold hover:bg-zinc-900 transition-colors"
                >
                  Cancel
                </button>
              </div>

              <span className="text-[10px] text-center text-zinc-500 font-mono">
                Shortcut: Press <kbd className="px-1 py-0.5 bg-zinc-900 border border-zinc-800 rounded">Ctrl+Enter</kbd> to submit immediately
              </span>
            </div>
          </div>
        </div>
      )}

      {/* ─── Cancel Confirmation Modal ─────────────────────────────────────── */}
      {cancelModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70 backdrop-blur-sm animate-in fade-in duration-150">
          <div className="w-full max-w-sm bg-zinc-950 border border-zinc-800 rounded-xl shadow-2xl p-5 flex flex-col gap-4 text-xs font-mono">
            <div className="flex items-center gap-2 text-rose-400 font-bold text-sm">
              <AlertTriangle className="h-4 w-4" />
              <span>Cancel Forever Order</span>
            </div>

            <p className="text-zinc-300">
              Are you sure you want to cancel the resting {cancelModal.side} order for{' '}
              <span className="font-bold text-white">{cancelModal.symbol}</span> (
              {cancelModal.qty} shares @ ₹{fmt(cancelModal.price)})?
            </p>

            <div className="flex gap-2 pt-1">
              <button
                disabled={cancelSubmitting}
                onClick={handleCancelOrder}
                className="flex-1 py-2 rounded-lg bg-rose-500 hover:bg-rose-400 text-oncolor-dark font-bold uppercase tracking-wider text-xs disabled:opacity-50 transition-colors"
              >
                {cancelSubmitting ? 'Cancelling...' : 'Confirm Cancel'}
              </button>
              <button
                disabled={cancelSubmitting}
                onClick={() => setCancelModal(null)}
                className="px-3 py-2 rounded-lg border border-zinc-800 text-zinc-400 hover:text-white uppercase tracking-wider text-xs transition-colors"
              >
                Keep Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ─── Floating Toast Notification Feedback ─────────────────────────── */}
      <div className="fixed bottom-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2.5 px-4 py-3 rounded-lg border shadow-xl backdrop-blur-md text-xs font-mono max-w-sm animate-in slide-in-from-bottom-3 duration-200',
              t.type === 'success'
                ? 'bg-zinc-950/95 border-emerald-500/40 text-emerald-300'
                : t.type === 'error'
                ? 'bg-zinc-950/95 border-rose-500/40 text-rose-300'
                : 'bg-zinc-950/95 border-zinc-700 text-zinc-200'
            )}
          >
            {t.type === 'success' ? (
              <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0 mt-0.5" />
            ) : t.type === 'error' ? (
              <AlertTriangle className="h-4 w-4 text-rose-400 shrink-0 mt-0.5" />
            ) : (
              <Terminal className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            )}
            <div className="flex flex-col gap-0.5">
              <span className="font-bold text-[12px]">{t.title}</span>
              {t.description && <span className="text-[11px] text-zinc-400">{t.description}</span>}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
