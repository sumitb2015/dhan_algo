'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Plus, X, RefreshCw, Terminal, AlertTriangle } from 'lucide-react';
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
  ltp: number;
  prevClose: number;
  dayChangePct: number;
  portfolioQty: number;
  avgCostPrice: number;
  foreverOrders: ForeverOrderRow[];
}

interface WatchlistResponse {
  success: boolean;
  rows?: WatchlistRow[];
  asOf?: string;
  error?: string;
}

interface SymbolsResponse {
  success: boolean;
  symbols: string[];
}

// ─── Formatters ─────────────────────────────────────────────────────────────
function fmt(n: number, digits = 2) { return (n ?? 0).toFixed(digits); }
function fmtCountdown(s: number) { return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }

function PctPill({ v }: { v: number }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-px rounded-sm text-[11px] font-bold tabular-nums font-mono',
      v > 0 ? 'bg-emerald-500/10 text-emerald-400' : v < 0 ? 'bg-red-500/10 text-red-400' : 'bg-zinc-800 text-zinc-500')}>
      {v > 0 ? '+' : ''}{fmt(v)}%
    </span>
  );
}

function SideBadge({ side }: { side: string }) {
  return (
    <span className={cn('inline-flex items-center px-1.5 py-px rounded-sm text-[11px] font-bold uppercase tracking-wide',
      side === 'BUY' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-red-500/10 text-red-400')}>
      {side}
    </span>
  );
}

// Distance of the order's price from the current LTP — negative means the
// order price sits below LTP (the common case for a resting BUY trigger).
function VsLtpBadge({ orderPrice, ltp }: { orderPrice: number; ltp: number }) {
  if (!ltp) return <span className="text-zinc-600">—</span>;
  const diff = orderPrice - ltp;
  const pct = (diff / ltp) * 100;
  return (
    <span className={cn('inline-flex items-center gap-1 text-[11px] font-mono tabular-nums',
      diff < 0 ? 'text-red-400' : diff > 0 ? 'text-emerald-400' : 'text-zinc-500')}>
      <span className="font-bold">{diff > 0 ? '+' : ''}{fmt(pct)}%</span>
      <span className="text-zinc-500">({diff > 0 ? '+' : ''}₹{fmt(diff)})</span>
    </span>
  );
}

// ─── Table primitives (mirrors MarketMovers.tsx conventions) ───────────────
function TH({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return (
    <th className={cn('py-1.5 px-2 text-xs font-bold text-white bg-zinc-800 uppercase tracking-wide whitespace-nowrap sticky top-0 z-10',
      right ? 'text-right' : 'text-left', className)}>
      {children}
    </th>
  );
}

function TD({ children, right, className }: { children?: React.ReactNode; right?: boolean; className?: string }) {
  return <td className={cn('py-1.5 px-2 text-[12px] font-mono align-top', right ? 'text-right' : 'text-left', className)}>{children}</td>;
}

// ─── Order form state ───────────────────────────────────────────────────────
type OrderAction = 'place' | 'modify';

interface OrderFormState {
  symbol: string;
  action: OrderAction;
  orderId?: string;
  legName?: string | null;
  transactionType: 'BUY' | 'SELL';
  quantity: string;
  price: string;
  triggerPrice: string;
  orderFlag: 'SINGLE' | 'OCO';
  price1: string;
  triggerPrice1: string;
  quantity1: string;
  confirming: boolean;
  submitting: boolean;
  error: string | null;
}

function blankForm(symbol: string, action: OrderAction, existing?: ForeverOrderRow): OrderFormState {
  return {
    symbol,
    action,
    orderId: existing?.orderId,
    legName: existing?.legName,
    transactionType: (existing?.transactionType as 'BUY' | 'SELL') ?? 'BUY',
    quantity: existing ? String(existing.quantity) : '',
    price: existing ? String(existing.price) : '',
    triggerPrice: existing ? String(existing.triggerPrice) : '',
    orderFlag: (existing?.orderFlag as 'SINGLE' | 'OCO') ?? 'SINGLE',
    price1: '',
    triggerPrice1: '',
    quantity1: '',
    confirming: false,
    submitting: false,
    error: null,
  };
}

// ─── Inline order form / confirm ───────────────────────────────────────────
function OrderPanel({ form, onChange, onCancel, onSubmit }: {
  form: OrderFormState;
  onChange: (f: OrderFormState) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const summary = `${form.action === 'place' ? 'Place' : 'Modify'} ${form.transactionType} Forever order: ${form.quantity || '?'} ${form.symbol} @ ₹${form.price || '?'}, trigger ₹${form.triggerPrice || '?'}${form.orderFlag === 'OCO' ? ` (OCO target ₹${form.price1 || '?'})` : ''}`;

  if (form.confirming) {
    return (
      <div className="mt-2 p-2 rounded-sm border border-amber-500/30 bg-amber-500/5 text-[11px] flex flex-col gap-2">
        <div className="flex items-start gap-1.5 text-amber-300">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{summary}</span>
        </div>
        {form.error && <div className="text-red-400">{form.error}</div>}
        <div className="flex gap-2">
          <button
            disabled={form.submitting}
            onClick={onSubmit}
            className="px-2 py-1 rounded-sm bg-amber-500 text-oncolor-dark font-bold uppercase tracking-wide disabled:opacity-50"
          >
            {form.submitting ? 'Submitting…' : 'Confirm'}
          </button>
          <button
            disabled={form.submitting}
            onClick={() => onChange({ ...form, confirming: false })}
            className="px-2 py-1 rounded-sm border border-zinc-700 text-zinc-300 uppercase tracking-wide"
          >
            Back
          </button>
          <button
            disabled={form.submitting}
            onClick={onCancel}
            className="ml-auto px-2 py-1 text-zinc-500 hover:text-zinc-300 uppercase tracking-wide"
          >
            Close
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 p-2 rounded-sm border border-zinc-800 bg-zinc-900 text-[11px] flex flex-col gap-2">
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={form.transactionType}
          onChange={(e) => onChange({ ...form, transactionType: e.target.value as 'BUY' | 'SELL' })}
          className="bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
        >
          <option value="BUY">BUY</option>
          <option value="SELL">SELL</option>
        </select>
        <input
          type="number" placeholder="Qty" value={form.quantity}
          onChange={(e) => onChange({ ...form, quantity: e.target.value })}
          className="w-20 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
        />
        <input
          type="number" placeholder="Price" value={form.price}
          onChange={(e) => onChange({ ...form, price: e.target.value })}
          className="w-24 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
        />
        <input
          type="number" placeholder="Trigger" value={form.triggerPrice}
          onChange={(e) => onChange({ ...form, triggerPrice: e.target.value })}
          className="w-24 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
        />
        {form.action === 'place' && (
          <select
            value={form.orderFlag}
            onChange={(e) => onChange({ ...form, orderFlag: e.target.value as 'SINGLE' | 'OCO' })}
            className="bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
          >
            <option value="SINGLE">SINGLE</option>
            <option value="OCO">OCO</option>
          </select>
        )}
      </div>
      {form.action === 'place' && form.orderFlag === 'OCO' && (
        <div className="flex flex-wrap gap-2 items-center">
          <span className="text-zinc-500 uppercase tracking-wide">Target leg:</span>
          <input
            type="number" placeholder="Price1" value={form.price1}
            onChange={(e) => onChange({ ...form, price1: e.target.value })}
            className="w-24 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
          />
          <input
            type="number" placeholder="Trigger1" value={form.triggerPrice1}
            onChange={(e) => onChange({ ...form, triggerPrice1: e.target.value })}
            className="w-24 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
          />
          <input
            type="number" placeholder="Qty1" value={form.quantity1}
            onChange={(e) => onChange({ ...form, quantity1: e.target.value })}
            className="w-20 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
          />
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => onChange({ ...form, confirming: true })}
          disabled={!form.quantity || !form.price || !form.triggerPrice}
          className="px-2 py-1 rounded-sm bg-zinc-800 text-zinc-100 font-bold uppercase tracking-wide disabled:opacity-40"
        >
          Review
        </button>
        <button onClick={onCancel} className="px-2 py-1 text-zinc-500 hover:text-zinc-300 uppercase tracking-wide">
          Cancel
        </button>
      </div>
    </div>
  );
}

export default function EquityWatchlist() {
  const [rows, setRows] = useState<WatchlistRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [autoIn, setAutoIn] = useState(12);
  const [addSymbol, setAddSymbol] = useState('');
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [activeForm, setActiveForm] = useState<OrderFormState | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<{ orderId: string; symbol: string } | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);

  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchDataRef = useRef<(showLoading?: boolean) => Promise<void>>(async () => {});

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/equity-watchlist');
      const json: WatchlistResponse = await res.json();
      if (json.success) {
        setRows(json.rows ?? []);
        setAsOf(json.asOf ?? null);
      } else {
        setError(json.error ?? 'Unknown error');
      }
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetchDataRef.current = fetchData; }, [fetchData]);
  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    fetch('/api/symbols')
      .then((r) => r.json())
      .then((j: SymbolsResponse) => { if (j.success) setAllSymbols(j.symbols); })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (autoRef.current) clearInterval(autoRef.current);
    setAutoIn(12);
    autoRef.current = setInterval(() => {
      setAutoIn((c) => {
        if (c <= 1) { fetchDataRef.current(false); return 12; }
        return c - 1;
      });
    }, 1000);
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  }, [rows]);

  const handleAddSymbol = useCallback(async (sym?: string) => {
    const symbol = (sym ?? addSymbol).trim().toUpperCase();
    if (!symbol) return;
    setAddSymbol('');
    await fetch('/api/equity-watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    });
    fetchData(false);
  }, [addSymbol, fetchData]);

  const handleRemoveSymbol = useCallback(async (symbol: string) => {
    await fetch('/api/equity-watchlist', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    });
    fetchData(false);
  }, [fetchData]);

  const submitOrder = useCallback(async () => {
    if (!activeForm) return;
    setActiveForm({ ...activeForm, submitting: true, error: null });
    try {
      if (activeForm.action === 'place') {
        const res = await fetch('/api/equity-watchlist/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            symbol: activeForm.symbol,
            transactionType: activeForm.transactionType,
            quantity: Number(activeForm.quantity),
            price: Number(activeForm.price),
            triggerPrice: Number(activeForm.triggerPrice),
            orderFlag: activeForm.orderFlag,
            price1: activeForm.price1 ? Number(activeForm.price1) : undefined,
            triggerPrice1: activeForm.triggerPrice1 ? Number(activeForm.triggerPrice1) : undefined,
            quantity1: activeForm.quantity1 ? Number(activeForm.quantity1) : undefined,
          }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error ?? 'Failed to place order');
      } else {
        const res = await fetch('/api/equity-watchlist/orders', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            orderId: activeForm.orderId,
            orderFlag: activeForm.orderFlag,
            legName: activeForm.legName,
            quantity: Number(activeForm.quantity),
            price: Number(activeForm.price),
            triggerPrice: Number(activeForm.triggerPrice),
          }),
        });
        const json = await res.json();
        if (!json.success) throw new Error(json.error ?? 'Failed to modify order');
      }
      setActiveForm(null);
      fetchData(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setActiveForm((f) => (f ? { ...f, submitting: false, error: msg } : f));
    }
  }, [activeForm, fetchData]);

  const submitCancel = useCallback(async () => {
    if (!cancelConfirm) return;
    setCancelSubmitting(true);
    try {
      const res = await fetch('/api/equity-watchlist/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: cancelConfirm.orderId }),
      });
      const json = await res.json();
      // Cancelling the order also drops the symbol from the watchlist —
      // this page tracks symbols the user is actively GTT-managing.
      if (json.success) {
        await fetch('/api/equity-watchlist', {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ symbol: cancelConfirm.symbol }),
        });
      }
      setCancelConfirm(null);
      fetchData(false);
    } finally {
      setCancelSubmitting(false);
    }
  }, [cancelConfirm, fetchData]);

  const symbolOptions = useMemo(() => {
    const existing = new Set(rows.map((r) => r.symbol));
    return allSymbols.filter((s) => !existing.has(s));
  }, [allSymbols, rows]);

  const totalFundsRequired = useMemo(() => {
    return rows.reduce((sum, r) => {
      const rowTotal = r.foreverOrders
        .filter((o) => o.transactionType === 'BUY' && o.status.toUpperCase() === 'PENDING')
        .reduce((s, o) => s + o.quantity * o.price, 0);
      return sum + rowTotal;
    }, 0);
  }, [rows]);

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100">
      <header className="w-full border-b border-amber-900/25 bg-zinc-950 px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-sm bg-amber-500 flex items-center justify-center shrink-0">
            <Terminal className="h-3.5 w-3.5 text-oncolor-dark" />
          </div>
          <span className="text-[13px] font-bold tracking-widest text-amber-400 uppercase font-mono">FOREVER WATCHLIST</span>
        </div>
        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />
        <NavBar />
        <div className="flex items-center gap-2 ml-auto">
          {totalFundsRequired > 0 && (
            <span className="text-[10px] font-mono font-bold text-amber-400 hidden md:inline px-2 py-0.5 rounded-sm bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
              FUNDS REQ: ₹{totalFundsRequired.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
            </span>
          )}
          {asOf && (
            <span className="text-[10px] font-mono font-bold text-zinc-400 hidden md:inline px-2 py-0.5 rounded-sm bg-zinc-900 border border-zinc-800 uppercase tracking-wide">
              DATA: {new Date(asOf).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
            </span>
          )}
          {!loading && (
            <span className="text-[10px] text-zinc-600 tabular-nums font-mono hidden md:inline">
              AUTO {fmtCountdown(autoIn)}
            </span>
          )}
          <button onClick={() => fetchData()} disabled={loading}
            className="h-6 w-6 flex items-center justify-center rounded-sm border border-zinc-800 bg-zinc-900 text-zinc-500 hover:text-amber-400 hover:border-amber-900/40 transition-all disabled:opacity-50">
            <RefreshCw className={cn('h-3 w-3', loading && 'animate-spin')} />
          </button>
        </div>
      </header>

      <main className="flex-1 w-full mx-auto px-3 py-2 flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <input
            list="equity-watchlist-symbols"
            value={addSymbol}
            onChange={(e) => setAddSymbol(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddSymbol(); }}
            placeholder="Add symbol (e.g. RELIANCE)"
            className="bg-zinc-900 border border-zinc-800 rounded-sm px-2 py-1 text-[12px] font-mono w-56"
          />
          <datalist id="equity-watchlist-symbols">
            {symbolOptions.map((s) => <option key={s} value={s} />)}
          </datalist>
          <button
            onClick={() => handleAddSymbol()}
            className="flex items-center gap-1 px-2 py-1 rounded-sm bg-amber-500 text-oncolor-dark text-[11px] font-bold uppercase tracking-wide"
          >
            <Plus className="h-3 w-3" /> Add
          </button>
        </div>

        {error && (
          <div className="px-3 py-1.5 rounded-sm border border-red-500/20 bg-red-500/5 text-[11px] text-red-400 font-mono">
            {error}
          </div>
        )}

        <div className="border border-amber-900/20 bg-zinc-950 rounded-sm overflow-hidden flex flex-col">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse">
              <thead>
                <tr>
                  <TH>Symbol</TH>
                  <TH right>LTP</TH>
                  <TH right>Day %</TH>
                  <TH right>Portfolio Qty</TH>
                  <TH right>Avg Cost</TH>
                  <TH>Side</TH>
                  <TH right>Order Qty</TH>
                  <TH right>Order Price</TH>
                  <TH right>Trigger</TH>
                  <TH right>vs LTP</TH>
                  <TH>Flag</TH>
                  <TH>Status</TH>
                  <TH>Actions</TH>
                  <TH></TH>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={14} className="text-center text-zinc-600 text-[11px] py-6">
                    {loading ? 'Loading…' : 'No symbols in watchlist — add one above.'}
                  </td></tr>
                )}
                {rows.map((r) => {
                  const hasOrder = r.foreverOrders.length > 0;
                  const orders = hasOrder ? r.foreverOrders : [null];
                  return (
                    <tr key={r.symbol} className="border-b border-zinc-900/80 align-top">
                      <TD className="font-bold text-zinc-100">{r.symbol}</TD>
                      <TD right className="text-zinc-200">₹{fmt(r.ltp)}</TD>
                      <TD right><PctPill v={r.dayChangePct} /></TD>
                      <TD right className="text-zinc-300">{r.portfolioQty}</TD>
                      <TD right className="text-zinc-400">{r.avgCostPrice ? `₹${fmt(r.avgCostPrice)}` : '—'}</TD>
                      <TD>
                        <div className="flex flex-col gap-1">
                          {orders.map((o, i) => o
                            ? <SideBadge key={o.orderId} side={o.transactionType} />
                            : <span key={i} className="text-zinc-600">—</span>)}
                        </div>
                      </TD>
                      <TD right>
                        <div className="flex flex-col gap-1">
                          {orders.map((o, i) => (
                            <span key={o?.orderId ?? i} className={o ? 'text-zinc-300' : 'text-zinc-600'}>
                              {o ? o.quantity : '—'}
                            </span>
                          ))}
                        </div>
                      </TD>
                      <TD right>
                        <div className="flex flex-col gap-1">
                          {orders.map((o, i) => (
                            <span key={o?.orderId ?? i} className={o ? 'text-zinc-300' : 'text-zinc-600'}>
                              {o ? `₹${fmt(o.price)}` : '—'}
                            </span>
                          ))}
                        </div>
                      </TD>
                      <TD right>
                        <div className="flex flex-col gap-1">
                          {orders.map((o, i) => (
                            <span key={o?.orderId ?? i} className={o ? 'text-zinc-400' : 'text-zinc-600'}>
                              {o ? `₹${fmt(o.triggerPrice)}` : '—'}
                            </span>
                          ))}
                        </div>
                      </TD>
                      <TD right>
                        <div className="flex flex-col gap-1 items-end">
                          {orders.map((o, i) => o
                            ? <VsLtpBadge key={o.orderId} orderPrice={o.price} ltp={r.ltp} />
                            : <span key={i} className="text-zinc-600">—</span>)}
                        </div>
                      </TD>
                      <TD>
                        <div className="flex flex-col gap-1">
                          {orders.map((o, i) => (
                            <span key={o?.orderId ?? i} className={o ? 'text-[10px] text-zinc-500 uppercase' : 'text-zinc-600'}>
                              {o ? o.orderFlag : '—'}
                            </span>
                          ))}
                        </div>
                      </TD>
                      <TD>
                        <div className="flex flex-col gap-1">
                          {orders.map((o, i) => (
                            <span key={o?.orderId ?? i} className={o ? 'text-[10px] text-amber-400 uppercase' : 'text-zinc-600'}>
                              {o ? o.status : '—'}
                            </span>
                          ))}
                        </div>
                      </TD>
                      <TD className="min-w-[180px]">
                        <div className="flex gap-1.5 flex-wrap">
                          {!hasOrder && (
                            <button
                              onClick={() => setActiveForm(blankForm(r.symbol, 'place'))}
                              className="px-2 py-0.5 rounded-sm border border-zinc-700 text-zinc-200 text-[11px] uppercase tracking-wide hover:border-amber-500/40 hover:text-amber-400"
                            >
                              Place
                            </button>
                          )}
                          {hasOrder && r.foreverOrders.map((o) => (
                            <div key={o.orderId} className="flex gap-1">
                              <button
                                onClick={() => setActiveForm(blankForm(r.symbol, 'modify', o))}
                                className="px-2 py-0.5 rounded-sm border border-zinc-700 text-zinc-200 text-[11px] uppercase tracking-wide hover:border-amber-500/40 hover:text-amber-400"
                              >
                                Modify
                              </button>
                              <button
                                onClick={() => setCancelConfirm({ orderId: o.orderId, symbol: r.symbol })}
                                className="px-2 py-0.5 rounded-sm border border-zinc-700 text-zinc-200 text-[11px] uppercase tracking-wide hover:border-red-500/40 hover:text-red-400"
                              >
                                Cancel
                              </button>
                            </div>
                          ))}
                        </div>
                        {activeForm && activeForm.symbol === r.symbol && (
                          <OrderPanel
                            form={activeForm}
                            onChange={setActiveForm}
                            onCancel={() => setActiveForm(null)}
                            onSubmit={submitOrder}
                          />
                        )}
                        {cancelConfirm && cancelConfirm.symbol === r.symbol && (
                          <div className="mt-2 p-2 rounded-sm border border-red-500/30 bg-red-500/5 text-[11px] flex flex-col gap-2">
                            <div className="flex items-start gap-1.5 text-red-300">
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                              <span>Cancel Forever order {cancelConfirm.orderId} for {r.symbol}?</span>
                            </div>
                            <div className="flex gap-2">
                              <button
                                disabled={cancelSubmitting}
                                onClick={submitCancel}
                                className="px-2 py-1 rounded-sm bg-red-500 text-oncolor-dark font-bold uppercase tracking-wide disabled:opacity-50"
                              >
                                {cancelSubmitting ? 'Cancelling…' : 'Confirm Cancel'}
                              </button>
                              <button
                                disabled={cancelSubmitting}
                                onClick={() => setCancelConfirm(null)}
                                className="px-2 py-1 border border-zinc-700 text-zinc-300 uppercase tracking-wide rounded-sm"
                              >
                                Back
                              </button>
                            </div>
                          </div>
                        )}
                      </TD>
                      <TD right>
                        <button
                          onClick={() => handleRemoveSymbol(r.symbol)}
                          title="Remove from watchlist"
                          className="text-zinc-600 hover:text-red-400"
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
    </div>
  );
}
