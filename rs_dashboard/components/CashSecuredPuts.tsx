'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Plus, X, RefreshCw, Terminal, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import NavBar from './NavBar';
import { TH, TD, PnlBadge, fmt, fmtCountdown, fetchWithTimeout } from './cspShared';

// ─── Types ──────────────────────────────────────────────────────────────────
interface CspOrderRow {
  orderId: string;
  tradingSymbol: string;
  transactionType: string;
  strike: number;
  expiry: string;
  quantity: number;
  price: number;
  triggerPrice: number;
  orderType: string;
  productType: string;
  status: string;
  securityId: string;
  exchangeSegment: string;
  createTime: string;
  updateTime: string;
}

interface CspTradeRow {
  tradingSymbol: string;
  side: string;
  netQty: number;
  strike: number;
  expiry: string;
  costPrice: number;
  unrealizedProfit: number;
  realizedProfit: number;
  productType: string;
  securityId: string;
  exchangeSegment: string;
}

interface CspRow {
  symbol: string;
  ltp: number;
  lotSize: number;
  activeOrders: CspOrderRow[];
  activeTrades: CspTradeRow[];
}

interface WatchlistResponse {
  success: boolean;
  rows?: CspRow[];
  asOf?: string;
  error?: string;
}

interface SymbolsResponse {
  success: boolean;
  symbols: string[];
}

interface StrikeRow {
  strike: number;
  ltp: number;
  oi: number;
  iv: number;
}

// ─── Sell Put order form ────────────────────────────────────────────────────
interface SellPutFormState {
  symbol: string;
  lotSize: number;
  expiries: string[];
  expiry: string;
  strikes: StrikeRow[];
  strike: string;
  lots: string;
  orderType: 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'STOP_LOSS_MARKET';
  price: string;
  triggerPrice: string;
  afterMarketOrder: boolean;
  amoTime: 'OPEN' | 'OPEN_30' | 'OPEN_60';
  productType: 'MARGIN' | 'CNC';
  confirming: boolean;
  submitting: boolean;
  loadingExpiries: boolean;
  loadingChain: boolean;
  error: string | null;
}

function blankSellPutForm(symbol: string, lotSize: number): SellPutFormState {
  return {
    symbol, lotSize,
    expiries: [], expiry: '',
    strikes: [], strike: '',
    lots: '1',
    orderType: 'MARKET',
    price: '',
    triggerPrice: '',
    afterMarketOrder: false,
    amoTime: 'OPEN',
    productType: 'MARGIN',
    confirming: false,
    submitting: false,
    loadingExpiries: true,
    loadingChain: false,
    error: null,
  };
}

function SellPutPanel({ form, onChange, onExpiryChange, onCancel, onSubmit }: {
  form: SellPutFormState;
  onChange: (f: SellPutFormState) => void;
  onExpiryChange: (symbol: string, expiry: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const quantity = (Number(form.lots) || 0) * form.lotSize;
  const needsPrice = form.orderType === 'LIMIT' || form.orderType === 'STOP_LOSS';
  const needsTrigger = form.orderType === 'STOP_LOSS' || form.orderType === 'STOP_LOSS_MARKET';
  const priceSuffix = needsPrice ? ` @ ₹${form.price || '?'}` : form.orderType === 'MARKET' ? ' at MARKET' : '';
  const triggerSuffix = needsTrigger ? ` trigger ₹${form.triggerPrice || '?'}` : '';
  const amoSuffix = form.afterMarketOrder ? ` (AMO ${form.amoTime})` : '';
  const summary = `SELL ${quantity || '?'} qty (${form.lots || '?'} lot${form.lots === '1' ? '' : 's'}) of ${form.symbol} ${form.strike || '?'} PE, expiry ${form.expiry || '?'} ${form.orderType}${priceSuffix}${triggerSuffix}${amoSuffix} — ${form.productType}`;

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
            {form.submitting ? 'Submitting…' : 'Confirm Sell'}
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
    <div className="mt-2 p-2 rounded-sm border border-zinc-800 bg-zinc-900 text-[11px] flex flex-col gap-2 min-w-[420px]">
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={form.expiry}
          onChange={(e) => onExpiryChange(form.symbol, e.target.value)}
          className="bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono min-w-[120px]"
        >
          <option value="">{form.loadingExpiries ? 'Loading…' : 'Select expiry'}</option>
          {form.expiries.map((e) => <option key={e} value={e}>{e}</option>)}
        </select>
        <input
          type="number" placeholder="Strike" value={form.strike}
          onChange={(e) => onChange({ ...form, strike: e.target.value })}
          className="w-24 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
        />
        <input
          type="number" placeholder="Lots" value={form.lots}
          onChange={(e) => onChange({ ...form, lots: e.target.value })}
          className="w-16 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
        />
        <span className="text-zinc-500">= {quantity || '?'} qty</span>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={form.orderType}
          onChange={(e) => {
            const orderType = e.target.value as 'MARKET' | 'LIMIT' | 'STOP_LOSS' | 'STOP_LOSS_MARKET';
            const selected = form.strikes.find((s) => String(s.strike) === form.strike);
            const needsPrice = orderType === 'LIMIT' || orderType === 'STOP_LOSS';
            const price = needsPrice && !form.price && selected ? String(selected.ltp) : form.price;
            onChange({ ...form, orderType, price });
          }}
          className="bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
        >
          <option value="MARKET">MARKET</option>
          <option value="LIMIT">LIMIT</option>
          <option value="STOP_LOSS">SL</option>
          <option value="STOP_LOSS_MARKET">SL-M</option>
        </select>
        <input
          type="number"
          placeholder={needsPrice ? 'Limit price' : 'At market'}
          value={needsPrice ? form.price : ''}
          disabled={!needsPrice}
          onChange={(e) => onChange({ ...form, price: e.target.value })}
          className="w-24 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono disabled:opacity-40"
        />
        <input
          type="number"
          placeholder="Trigger price"
          value={needsTrigger ? form.triggerPrice : ''}
          disabled={!needsTrigger}
          onChange={(e) => onChange({ ...form, triggerPrice: e.target.value })}
          className="w-24 bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono disabled:opacity-40"
        />
        <select
          value={form.productType}
          onChange={(e) => onChange({ ...form, productType: e.target.value as 'MARGIN' | 'CNC' })}
          className="bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
        >
          <option value="MARGIN">MARGIN</option>
          <option value="CNC">CNC</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-2 items-center">
        <label className="flex items-center gap-1.5 text-zinc-300 cursor-pointer">
          <input
            type="checkbox"
            checked={form.afterMarketOrder}
            onChange={(e) => onChange({ ...form, afterMarketOrder: e.target.checked })}
            className="accent-amber-500"
          />
          AMO
        </label>
        {form.afterMarketOrder && (
          <select
            value={form.amoTime}
            onChange={(e) => onChange({ ...form, amoTime: e.target.value as 'OPEN' | 'OPEN_30' | 'OPEN_60' })}
            className="bg-zinc-950 border border-zinc-800 rounded-sm px-1.5 py-1 font-mono"
          >
            <option value="OPEN">OPEN</option>
            <option value="OPEN_30">OPEN_30</option>
            <option value="OPEN_60">OPEN_60</option>
          </select>
        )}
      </div>
      {form.error && !form.confirming && (
        <div className="flex items-start gap-1.5 text-red-400">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>{form.error}</span>
        </div>
      )}
      {form.expiry && (
        <div className="max-h-32 overflow-y-auto border border-zinc-800 rounded-sm">
          {form.loadingChain && <div className="text-zinc-500 px-2 py-1">Loading chain…</div>}
          {!form.loadingChain && form.strikes.length === 0 && (
            <div className="text-zinc-600 px-2 py-1">No PE strikes found</div>
          )}
          {!form.loadingChain && form.strikes.map((s) => (
            <button
              key={s.strike}
              onClick={() => onChange({
                ...form,
                strike: String(s.strike),
                price: needsPrice ? String(s.ltp) : form.price,
              })}
              className={cn('w-full flex justify-between px-2 py-0.5 text-left hover:bg-zinc-800',
                String(s.strike) === form.strike && 'bg-amber-500/10 text-amber-300')}
            >
              <span>{s.strike}</span>
              <span className="text-zinc-400">₹{fmt(s.ltp)}</span>
            </button>
          ))}
        </div>
      )}
      <div className="flex gap-2">
        <button
          onClick={() => onChange({ ...form, confirming: true })}
          disabled={!form.expiry || !form.strike || !form.lots || (needsPrice && !form.price) || (needsTrigger && !form.triggerPrice)}
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

export default function CashSecuredPuts() {
  const [rows, setRows] = useState<CspRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);
  const [autoIn, setAutoIn] = useState(15);
  const [addSymbol, setAddSymbol] = useState('');
  const [allSymbols, setAllSymbols] = useState<string[]>([]);
  const [sellForm, setSellForm] = useState<SellPutFormState | null>(null);
  const [cancelConfirm, setCancelConfirm] = useState<{ orderId: string; symbol: string } | null>(null);
  const [cancelSubmitting, setCancelSubmitting] = useState(false);
  const [exitConfirm, setExitConfirm] = useState<{ trade: CspTradeRow; symbol: string } | null>(null);
  const [exitSubmitting, setExitSubmitting] = useState(false);

  const autoRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const fetchDataRef = useRef<(showLoading?: boolean) => Promise<void>>(async () => {});

  const fetchData = useCallback(async (showLoading = true) => {
    if (showLoading) setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/csp-watchlist');
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
    setAutoIn(15);
    autoRef.current = setInterval(() => {
      setAutoIn((c) => {
        if (c <= 1) { fetchDataRef.current(false); return 15; }
        return c - 1;
      });
    }, 1000);
    return () => { if (autoRef.current) clearInterval(autoRef.current); };
  }, [rows]);

  const handleAddSymbol = useCallback(async (sym?: string) => {
    const symbol = (sym ?? addSymbol).trim().toUpperCase();
    if (!symbol) return;
    setAddSymbol('');
    await fetch('/api/csp-watchlist', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    });
    fetchData(false);
  }, [addSymbol, fetchData]);

  const handleRemoveSymbol = useCallback(async (symbol: string) => {
    const row = rows.find((r) => r.symbol === symbol);
    if (row && (row.activeOrders.length > 0 || row.activeTrades.length > 0)) return;
    await fetch('/api/csp-watchlist', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol }),
    });
    fetchData(false);
  }, [rows, fetchData]);

  const openSellForm = useCallback(async (symbol: string, lotSize: number) => {
    const form = blankSellPutForm(symbol, lotSize);
    setSellForm(form);
    try {
      const res = await fetchWithTimeout(`/api/csp-watchlist/expiries?symbol=${encodeURIComponent(symbol)}`, 25_000);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to load expiries');
      setSellForm((f) => (f && f.symbol === symbol ? { ...f, expiries: json.expiries ?? [], loadingExpiries: false } : f));
    } catch (err: unknown) {
      const msg = err instanceof Error && err.name === 'AbortError' ? 'Timed out loading expiries' : (err instanceof Error ? err.message : 'Failed to load expiries');
      setSellForm((f) => (f && f.symbol === symbol ? { ...f, loadingExpiries: false, error: msg } : f));
    }
  }, []);

  const handleExpirySelected = useCallback(async (symbol: string, expiry: string) => {
    if (!symbol) return;
    setSellForm((f) => (f && f.symbol === symbol ? { ...f, expiry, strike: '', strikes: [], loadingChain: true } : f));
    try {
      const res = await fetchWithTimeout(`/api/csp-watchlist/chain?symbol=${encodeURIComponent(symbol)}&expiry=${encodeURIComponent(expiry)}`, 25_000);
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to load chain');
      setSellForm((cur) => (cur && cur.symbol === symbol && cur.expiry === expiry
        ? { ...cur, strikes: (json.strikes ?? []).sort((a: StrikeRow, b: StrikeRow) => a.strike - b.strike), loadingChain: false }
        : cur));
    } catch (err: unknown) {
      const msg = err instanceof Error && err.name === 'AbortError' ? 'Timed out loading option chain' : (err instanceof Error ? err.message : 'Failed to load chain');
      setSellForm((cur) => (cur && cur.symbol === symbol ? { ...cur, loadingChain: false, error: msg } : cur));
    }
  }, []);

  const submitSellPut = useCallback(async () => {
    if (!sellForm) return;
    setSellForm({ ...sellForm, submitting: true, error: null });
    try {
      const res = await fetch('/api/csp-watchlist/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol: sellForm.symbol,
          expiry: sellForm.expiry,
          strike: Number(sellForm.strike),
          quantity: (Number(sellForm.lots) || 0) * sellForm.lotSize,
          orderType: sellForm.orderType,
          price: (sellForm.orderType === 'LIMIT' || sellForm.orderType === 'STOP_LOSS') ? Number(sellForm.price) : undefined,
          triggerPrice: (sellForm.orderType === 'STOP_LOSS' || sellForm.orderType === 'STOP_LOSS_MARKET') ? Number(sellForm.triggerPrice) : undefined,
          afterMarketOrder: sellForm.afterMarketOrder,
          amoTime: sellForm.amoTime,
          productType: sellForm.productType,
        }),
      });
      const json = await res.json();
      if (!json.success) throw new Error(json.error ?? 'Failed to place order');
      setSellForm(null);
      fetchData(false);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      setSellForm((f) => (f ? { ...f, submitting: false, error: msg } : f));
    }
  }, [sellForm, fetchData]);

  const submitCancel = useCallback(async () => {
    if (!cancelConfirm) return;
    setCancelSubmitting(true);
    try {
      await fetch('/api/csp-watchlist/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId: cancelConfirm.orderId }),
      });
      setCancelConfirm(null);
      fetchData(false);
    } finally {
      setCancelSubmitting(false);
    }
  }, [cancelConfirm, fetchData]);

  const submitExit = useCallback(async () => {
    if (!exitConfirm) return;
    setExitSubmitting(true);
    try {
      await fetch('/api/csp-watchlist/exit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          securityId: exitConfirm.trade.securityId,
          exchangeSegment: exitConfirm.trade.exchangeSegment,
          quantity: exitConfirm.trade.netQty,
          productType: exitConfirm.trade.productType,
        }),
      });
      setExitConfirm(null);
      fetchData(false);
    } finally {
      setExitSubmitting(false);
    }
  }, [exitConfirm, fetchData]);

  const symbolOptions = useMemo(() => {
    const existing = new Set(rows.map((r) => r.symbol));
    return allSymbols.filter((s) => !existing.has(s));
  }, [allSymbols, rows]);

  return (
    <div className="flex flex-col flex-1 w-full bg-black min-h-screen text-zinc-100">
      <header className="w-full border-b border-amber-900/25 bg-zinc-950 px-4 py-2 flex flex-wrap items-center gap-2.5 z-20 sticky top-0 backdrop-blur-md">
        <div className="flex items-center gap-2 mr-1">
          <div className="h-6 w-6 rounded-sm bg-amber-500 flex items-center justify-center shrink-0">
            <Terminal className="h-3.5 w-3.5 text-oncolor-dark" />
          </div>
          <span className="text-[13px] font-bold tracking-widest text-amber-400 uppercase font-mono">CASH SECURED PUTS</span>
        </div>
        <div className="w-px h-5 bg-zinc-800 hidden sm:block" />
        <NavBar />
        <div className="flex items-center gap-2 ml-auto">
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
            list="csp-watchlist-symbols"
            value={addSymbol}
            onChange={(e) => setAddSymbol(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') handleAddSymbol(); }}
            placeholder="Add underlying (e.g. RELIANCE)"
            className="bg-zinc-900 border border-zinc-800 rounded-sm px-2 py-1 text-[12px] font-mono w-56"
          />
          <datalist id="csp-watchlist-symbols">
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
                  <TH right>Lot Size</TH>
                  <TH>Active Orders</TH>
                  <TH>Active Trades</TH>
                  <TH>Sell Put</TH>
                  <TH></TH>
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="text-center text-zinc-600 text-[11px] py-6">
                    {loading ? 'Loading…' : 'No symbols tracked — add an underlying above.'}
                  </td></tr>
                )}
                {rows.map((r) => (
                  <tr key={r.symbol} className="border-b border-zinc-900/80 align-top">
                    <TD className="font-bold text-zinc-100">{r.symbol}</TD>
                    <TD right className="text-zinc-200">₹{fmt(r.ltp)}</TD>
                    <TD right className="text-zinc-300">{r.lotSize || '—'}</TD>
                    <TD className="min-w-[260px]">
                      {r.activeOrders.length === 0 && <span className="text-zinc-600">—</span>}
                      <div className="flex flex-col gap-1.5">
                        {r.activeOrders.map((o) => (
                          <div key={o.orderId} className="flex items-center gap-2 flex-wrap">
                            <span className="text-zinc-200">{o.strike} PE</span>
                            <span className="text-zinc-500 text-[10px]">{o.expiry}</span>
                            <span className="text-zinc-300">{o.quantity} qty @ ₹{fmt(o.price)}</span>
                            <span className="text-[10px] text-amber-400 uppercase">{o.status}</span>
                            <button
                              onClick={() => setCancelConfirm({ orderId: o.orderId, symbol: r.symbol })}
                              className="px-1.5 py-0.5 rounded-sm border border-zinc-700 text-zinc-300 text-[10px] uppercase tracking-wide hover:border-red-500/40 hover:text-red-400"
                            >
                              Cancel
                            </button>
                          </div>
                        ))}
                      </div>
                    </TD>
                    <TD className="min-w-[280px]">
                      {r.activeTrades.length === 0 && <span className="text-zinc-600">—</span>}
                      <div className="flex flex-col gap-1.5">
                        {r.activeTrades.map((t) => (
                          <div key={t.securityId} className="flex items-center gap-2 flex-wrap">
                            <span className="text-zinc-200">{t.strike} PE</span>
                            <span className="text-zinc-500 text-[10px]">{t.expiry}</span>
                            <span className="text-zinc-300">{Math.abs(t.netQty)} qty @ ₹{fmt(t.costPrice)}</span>
                            <PnlBadge v={t.unrealizedProfit} />
                            <button
                              onClick={() => setExitConfirm({ trade: t, symbol: r.symbol })}
                              className="px-1.5 py-0.5 rounded-sm border border-zinc-700 text-zinc-300 text-[10px] uppercase tracking-wide hover:border-red-500/40 hover:text-red-400"
                            >
                              Exit
                            </button>
                          </div>
                        ))}
                      </div>
                    </TD>
                    <TD className="min-w-[200px]">
                      <button
                        onClick={() => openSellForm(r.symbol, r.lotSize)}
                        className="px-2 py-0.5 rounded-sm border border-zinc-700 text-zinc-200 text-[11px] uppercase tracking-wide hover:border-amber-500/40 hover:text-amber-400"
                      >
                        Sell Put
                      </button>
                      {sellForm && sellForm.symbol === r.symbol && (
                        <SellPutPanel
                          form={sellForm}
                          onChange={setSellForm}
                          onExpiryChange={handleExpirySelected}
                          onCancel={() => setSellForm(null)}
                          onSubmit={submitSellPut}
                        />
                      )}
                      {cancelConfirm && cancelConfirm.symbol === r.symbol && (
                        <div className="mt-2 p-2 rounded-sm border border-red-500/30 bg-red-500/5 text-[11px] flex flex-col gap-2">
                          <div className="flex items-start gap-1.5 text-red-300">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span>Cancel order {cancelConfirm.orderId} for {r.symbol}?</span>
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
                      {exitConfirm && exitConfirm.symbol === r.symbol && (
                        <div className="mt-2 p-2 rounded-sm border border-red-500/30 bg-red-500/5 text-[11px] flex flex-col gap-2">
                          <div className="flex items-start gap-1.5 text-red-300">
                            <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                            <span>Buy to close {Math.abs(exitConfirm.trade.netQty)} qty of {exitConfirm.trade.tradingSymbol} at MARKET?</span>
                          </div>
                          <div className="flex gap-2">
                            <button
                              disabled={exitSubmitting}
                              onClick={submitExit}
                              className="px-2 py-1 rounded-sm bg-red-500 text-oncolor-dark font-bold uppercase tracking-wide disabled:opacity-50"
                            >
                              {exitSubmitting ? 'Exiting…' : 'Confirm Exit'}
                            </button>
                            <button
                              disabled={exitSubmitting}
                              onClick={() => setExitConfirm(null)}
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
                        disabled={r.activeOrders.length > 0 || r.activeTrades.length > 0}
                        title={r.activeOrders.length > 0 || r.activeTrades.length > 0
                          ? 'Cancel active orders and exit open trades before removing this symbol'
                          : 'Remove from watchlist'}
                        className="text-zinc-600 hover:text-red-400 disabled:opacity-30 disabled:hover:text-zinc-600 disabled:cursor-not-allowed"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </TD>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
