'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { X, Minus, Plus, AlertTriangle, CheckCircle2, Loader2 } from 'lucide-react';
import { validateOrder, roundToTick, type Side, type Product, type OrderType } from '@/lib/equityOrder';

// Buy/Sell ticket for one NSE cash-equity stock (Dhan). REAL MONEY: the server re-validates every
// field and caps; this modal only makes the common mistakes hard. Typed fields commit on
// blur/Enter, never per keystroke (dhan-commit-on-blur), and the submit button stays disabled
// while a draft is uncommitted. See dhan-order-tickets.

interface Ctx {
  symbol: string;
  name: string;
  tick: number;
  ltp: number | null;
  ltpError: string | null;
  holding: { totalQty: number; availableQty: number; avgCost: number };
  positions: { product: string; netQty: number }[];
  portfolioError: string | null;
  availableFunds: number | null;
  limits: { maxQty: number; maxValue: number; limitBand: number };
}

interface Props {
  symbol: string;
  side: Side;
  onClose: () => void;
  /** Called once after Dhan accepted the order (or its outcome is unknown) so the page can refresh holdings. */
  onPlaced: () => void;
}

type Result = { kind: 'ok'; orderId: string; status: string | null; summary: string } | { kind: 'unknown'; message: string };
const BAD_STATUS = new Set(['REJECTED', 'CANCELLED', 'EXPIRED']);

const inr = (n: number, d = 2) => n.toLocaleString('en-IN', { minimumFractionDigits: d, maximumFractionDigits: d });
const PRODUCT_LABEL: Record<Product, string> = { CNC: 'Delivery (CNC)', INTRADAY: 'Intraday (MIS)' };

function Seg<T extends string>({ value, options, onChange, label, disabled }: {
  value: T; options: { id: T; label: string }[]; onChange: (v: T) => void; label: string; disabled?: boolean;
}) {
  return (
    <div role="radiogroup" aria-label={label} className="grid grid-flow-col auto-cols-fr gap-1 p-1 rounded-lg bg-zinc-900 border border-zinc-800">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          role="radio"
          aria-checked={value === o.id}
          disabled={disabled}
          onClick={() => onChange(o.id)}
          className={`px-2 py-1.5 rounded-md text-xs font-bold focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:opacity-50 ${
            value === o.id ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export default function EquityOrderModal({ symbol, side, onClose, onPlaced }: Props) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [product, setProduct] = useState<Product>('CNC');
  const [orderType, setOrderType] = useState<OrderType>('MARKET');
  const [qty, setQty] = useState(1);
  const [qtyDraft, setQtyDraft] = useState('1');
  const [price, setPrice] = useState<number | null>(null);
  const [priceDraft, setPriceDraft] = useState('');
  const [amo, setAmo] = useState(false);

  const [placing, setPlacing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<Result | null>(null);

  const dialogRef = useRef<HTMLDivElement>(null);
  const clientKey = useRef(''); // one idempotency key per ticket, minted on first submit (not during render)
  const defaulted = useRef(false);
  const isBuy = side === 'BUY';

  // The modal mounts once per ticket with loading=true. Retry bumps `tick`, which re-runs this
  // effect; the cancel flag is the out-of-order guard (a stale reply never lands).
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/equity-order?symbol=${encodeURIComponent(symbol)}`);
        const json = await res.json();
        if (cancelled) return;
        if (!json.success) throw new Error(json.error || 'Could not load the ticket');
        const c = json.data as Ctx;
        setCtx(c);
        if (!defaulted.current) {
          defaulted.current = true;
          // A sell defaults to whichever product actually holds the shares.
          if (!isBuy && c.holding.availableQty <= 0 && c.positions.some((p) => p.product === 'INTRADAY' && p.netQty > 0)) setProduct('INTRADAY');
          if (c.ltp) { const p = roundToTick(c.ltp, c.tick); setPrice(p); setPriceDraft(p.toFixed(2)); }
        }
        setLoadError(null);
      } catch (e) {
        if (!cancelled) setLoadError(e instanceof Error ? e.message : 'Could not load the ticket');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [symbol, isBuy, tick]);
  const reload = () => { setLoading(true); setLoadError(null); setTick((t) => t + 1); };

  // Move focus into the dialog on open and give it back to the button that opened it on close.
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { opener?.focus?.(); };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !placing) onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, placing]);

  const locked = placing || result !== null;
  const misLong = ctx ? ctx.positions.filter((p) => p.product === 'INTRADAY').reduce((n, p) => n + Math.max(0, p.netQty), 0) : 0;
  const sellMax = !isBuy && ctx ? (product === 'CNC' ? ctx.holding.availableQty : misLong) : 0;
  const nothingToSell = !isBuy && !!ctx && sellMax <= 0;
  const draftsCommitted = qtyDraft === String(qty) && (orderType === 'MARKET' || priceDraft === (price === null ? '' : price.toFixed(2)));

  const commitQty = (raw: string) => {
    const n = Math.max(1, Math.min(ctx?.limits.maxQty ?? 10_000, parseInt(raw, 10) || 1));
    setQty(n); setQtyDraft(String(n));
  };
  const commitPrice = (raw: string) => {
    const p = parseFloat(raw);
    if (!Number.isFinite(p) || p <= 0 || !ctx) { setPriceDraft(price === null ? '' : price.toFixed(2)); return; }
    const r = roundToTick(p, ctx.tick);
    setPrice(r); setPriceDraft(r.toFixed(2));
  };

  // The same rules the server enforces, so the button explains itself before a round trip.
  const check = useMemo(() => {
    if (!ctx) return null;
    if (!ctx.ltp) return { ok: false as const, error: ctx.ltpError ? `No live price (${ctx.ltpError}). Refresh to retry.` : 'No live price. Refresh to retry.' };
    return validateOrder(
      { side, product, orderType, quantity: qty, price, amo },
      { ltp: ctx.ltp, tick: ctx.tick, availableQty: ctx.holding.availableQty, intradayLongQty: misLong, pendingSellQty: 0 /* open orders are checked by the server */ },
    );
  }, [ctx, side, product, orderType, qty, price, amo, misLong]);

  const value = check && check.ok ? check.order.value : ctx?.ltp ? qty * (orderType === 'LIMIT' && price ? price : ctx.ltp) : 0;
  const canSubmit = !!check && check.ok && draftsCommitted && !locked && !loading && !(!isBuy && sellMax <= 0);

  async function submit() {
    if (!canSubmit) return;
    setPlacing(true);
    setError(null);
    try {
      if (!clientKey.current) clientKey.current = crypto.randomUUID();
      const res = await fetch('/api/equity-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol, side, product, orderType, quantity: qty, price: orderType === 'LIMIT' ? price : undefined, amo, clientKey: clientKey.current }),
      });
      const json = await res.json().catch(() => null);
      if (json === null) {
        // Not our JSON (a proxy/gateway page): the order may or may not have been booked.
        setResult({ kind: 'unknown', message: `Unexpected reply from the server (HTTP ${res.status}). Check the Dhan order book before placing ${symbol} again.` });
        onPlaced();
      } else if (json.success) {
        setResult({ kind: 'ok', orderId: String(json.orderId), status: json.orderStatus ?? null, summary: String(json.summary ?? '') });
        onPlaced();
      } else if (json.unknown) {
        setResult({ kind: 'unknown', message: String(json.error) });
        onPlaced();
      } else {
        setError(String(json.error || `Order failed (HTTP ${res.status})`));
        clientKey.current = ''; // a rejected ticket may be corrected and re-sent under a fresh key
      }
    } catch (e) {
      // The request may have reached Dhan even though the reply never reached us.
      setResult({ kind: 'unknown', message: `No reply from the server (${e instanceof Error ? e.message : e}). Check the Dhan order book before placing ${symbol} again.` });
      onPlaced();
    } finally {
      setPlacing(false);
    }
  }

  const sideTone = isBuy ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500';
  const sideText = isBuy ? 'text-emerald-400' : 'text-red-400';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-oncolor-dark/70" onMouseDown={(e) => { if (e.target === e.currentTarget && !placing) onClose(); }}>
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={`${isBuy ? 'Buy' : 'Sell'} ${symbol}`} className="focus:outline-none w-full max-w-md rounded-2xl border border-zinc-800 bg-zinc-950 shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-zinc-800">
          <div>
            <p className={`text-[10px] font-bold uppercase tracking-[0.16em] ${sideText}`}>{isBuy ? 'Buy' : 'Sell'} · NSE · Real order</p>
            <h2 className="text-base font-bold text-white leading-tight">{symbol}</h2>
            {ctx && <p className="text-[11px] text-zinc-500">{ctx.name}</p>}
          </div>
          <button onClick={onClose} disabled={placing} aria-label="Close order window" className="p-1 rounded-md text-zinc-400 hover:text-white hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:opacity-40">
            <X className="w-4 h-4" aria-hidden="true" />
          </button>
        </div>

        {loadError ? (
          <div className="p-5 space-y-3">
            <p role="alert" className="text-xs text-red-300">{loadError}</p>
            <button onClick={reload} className="px-3 py-1.5 rounded-md border border-zinc-700 text-xs font-bold text-zinc-200 hover:bg-zinc-800">Retry</button>
          </div>
        ) : !ctx ? (
          <div className="p-8 flex items-center justify-center gap-2 text-xs text-zinc-400">
            <Loader2 className="w-4 h-4 animate-spin text-emerald-400" aria-hidden="true" /> Loading price and holdings…
          </div>
        ) : (
          <div className="p-5 space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs font-mono">
              <div>
                <dt className="text-zinc-500">Live price</dt>
                <dd className="text-zinc-100 font-bold">
                  {ctx.ltp ? `₹${inr(ctx.ltp)}` : '—'}
                  <button type="button" onClick={reload} disabled={loading || locked} aria-label="Refresh price and holdings" className="ml-2 text-[11px] font-bold text-sky-400 hover:underline disabled:opacity-50">{loading ? 'Refreshing…' : 'Refresh'}</button>
                </dd>
              </div>
              <div><dt className="text-zinc-500">Available funds</dt><dd className="text-zinc-100">{ctx.availableFunds === null ? '—' : `₹${inr(ctx.availableFunds, 0)}`}</dd></div>
              <div>
                <dt className="text-zinc-500">In your holdings</dt>
                <dd className="text-zinc-100">
                  {ctx.holding.totalQty > 0 ? `${ctx.holding.totalQty.toLocaleString('en-IN')} (sellable ${ctx.holding.availableQty.toLocaleString('en-IN')})` : 'None'}
                  {ctx.holding.totalQty > 0 && ctx.holding.avgCost > 0 && <span className="block text-zinc-500">avg ₹{inr(ctx.holding.avgCost)}</span>}
                </dd>
              </div>
              <div>
                <dt className="text-zinc-500">Today&apos;s positions</dt>
                <dd className="text-zinc-100">
                  {ctx.positions.length === 0 ? 'None' : ctx.positions.map((p) => (
                    <span key={p.product} className="block">{p.product === 'INTRADAY' ? 'MIS' : p.product} <span className={p.netQty > 0 ? 'text-emerald-400' : 'text-red-400'}>{p.netQty > 0 ? '+' : ''}{p.netQty}</span></span>
                  ))}
                </dd>
              </div>
            </dl>
            {ctx.portfolioError && (
              <p className="text-[11px] text-amber-300">Could not read your holdings ({ctx.portfolioError}). Quantities above may be incomplete; a Delivery sell is re-checked on the server.</p>
            )}

            <div className="space-y-3">
              <div>
                <p className="text-[11px] font-bold text-zinc-400 mb-1">Product</p>
                <Seg label="Product" value={product} onChange={setProduct} disabled={locked}
                  options={[{ id: 'CNC', label: 'Delivery (CNC)' }, { id: 'INTRADAY', label: 'Intraday (MIS)' }]} />
              </div>
              <div>
                <p className="text-[11px] font-bold text-zinc-400 mb-1">Order type</p>
                <Seg label="Order type" value={orderType} onChange={setOrderType} disabled={locked}
                  options={[{ id: 'MARKET', label: 'Market' }, { id: 'LIMIT', label: 'Limit' }]} />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label htmlFor="eq-qty" className="text-[11px] font-bold text-zinc-400 mb-1 block">Quantity (shares)</label>
                  <div className="flex items-center gap-1">
                    <button type="button" aria-label="Decrease quantity" disabled={locked} onClick={() => commitQty(String(qty - 1))} className="p-2 rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"><Minus className="w-3 h-3" aria-hidden="true" /></button>
                    <input
                      id="eq-qty" type="number" min={1} inputMode="numeric" disabled={locked}
                      value={qtyDraft}
                      onChange={(e) => setQtyDraft(e.target.value)}
                      onBlur={(e) => commitQty(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                        if (e.key === 'Escape' && qtyDraft !== String(qty)) { e.stopPropagation(); setQtyDraft(String(qty)); } // revert an uncommitted edit first; a second Escape closes the window
                      }}
                      className="w-full min-w-0 px-2 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 text-sm font-mono text-center text-zinc-100 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50"
                    />
                    <button type="button" aria-label="Increase quantity" disabled={locked} onClick={() => commitQty(String(qty + 1))} className="p-2 rounded-md border border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"><Plus className="w-3 h-3" aria-hidden="true" /></button>
                  </div>
                  {!isBuy && sellMax > 0 && (
                    <button type="button" disabled={locked} onClick={() => commitQty(String(sellMax))} className="mt-1 text-[11px] font-bold text-sky-400 hover:underline disabled:opacity-50">
                      Sell all {sellMax.toLocaleString('en-IN')}
                    </button>
                  )}
                </div>
                <div>
                  <label htmlFor="eq-price" className="text-[11px] font-bold text-zinc-400 mb-1 block">Limit price (₹)</label>
                  <input
                    id="eq-price" type="number" step={ctx.tick} min={0} inputMode="decimal"
                    disabled={locked || orderType !== 'LIMIT'}
                    value={orderType === 'LIMIT' ? priceDraft : ''}
                    placeholder={orderType === 'LIMIT' ? '' : 'Market'}
                    onChange={(e) => setPriceDraft(e.target.value)}
                    onBlur={(e) => commitPrice(e.currentTarget.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                      if (e.key === 'Escape' && priceDraft !== (price === null ? '' : price.toFixed(2))) { e.stopPropagation(); setPriceDraft(price === null ? '' : price.toFixed(2)); }
                    }}
                    className="w-full px-2 py-1.5 rounded-md bg-zinc-900 border border-zinc-800 text-sm font-mono text-zinc-100 placeholder:text-zinc-500 focus:outline-none focus:ring-2 focus:ring-emerald-500/50 disabled:opacity-50"
                  />
                  {orderType === 'LIMIT' && ctx.ltp && (
                    <button type="button" disabled={locked} onClick={() => commitPrice(String(ctx.ltp))} className="mt-1 text-[11px] font-bold text-sky-400 hover:underline disabled:opacity-50">Use live price</button>
                  )}
                </div>
              </div>

              <label className="flex items-start gap-2 text-xs text-zinc-300 cursor-pointer">
                <input type="checkbox" checked={amo} disabled={locked} onChange={(e) => setAmo(e.target.checked)} className="mt-0.5 accent-emerald-500" />
                <span>After-market order (AMO)<span className="block text-[11px] text-zinc-500">Queued for the next session open. Tick only when the market is closed.</span></span>
              </label>
            </div>

            {nothingToSell && !result && (
              <p className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300">
                You have no {product === 'CNC' ? 'Delivery holding' : 'open Intraday position'} in {symbol}, so there is nothing to sell. Short-selling is not allowed here.
              </p>
            )}

            <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 px-3 py-2 text-xs font-mono flex items-center justify-between">
              <span className="text-zinc-400">Estimated value</span>
              <span className="text-zinc-100 font-bold">₹{inr(value, 0)}</span>
            </div>

            {check && !check.ok && !result && !nothingToSell && (
              <p role="alert" className="flex items-start gap-2 text-xs text-amber-300"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />{check.error}</p>
            )}
            {error && <p role="alert" className="flex items-start gap-2 text-xs text-red-300"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" aria-hidden="true" />{error}</p>}

            {result?.kind === 'ok' && result.status && BAD_STATUS.has(result.status) && (
              <div role="alert" className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-2 text-xs text-red-300 space-y-0.5">
                <p className="flex items-center gap-1.5 font-bold"><AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />Dhan accepted the request but the order is {result.status}</p>
                <p className="font-mono text-zinc-200">{result.summary}</p>
                <p className="font-mono text-zinc-400">Order {result.orderId} · check the Dhan order book for the reason.</p>
              </div>
            )}
            {result?.kind === 'ok' && !(result.status && BAD_STATUS.has(result.status)) && (
              <div role="status" className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-400 space-y-0.5">
                <p className="flex items-center gap-1.5 font-bold"><CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />Order sent to Dhan</p>
                <p className="font-mono text-zinc-200">{result.summary}</p>
                <p className="font-mono text-zinc-400">Order {result.orderId}{result.status ? ` · ${result.status}` : ''}</p>
              </div>
            )}
            {result?.kind === 'unknown' && (
              <p role="alert" className="rounded-lg border border-amber-500/25 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{result.message}</p>
            )}

            <div className="flex items-center gap-2 pt-1">
              <button type="button" onClick={onClose} disabled={placing} className="flex-1 px-3 py-2 rounded-lg border border-zinc-700 text-xs font-bold text-zinc-200 hover:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:opacity-50">
                {result ? 'Close' : 'Cancel'}
              </button>
              {!result && (
                <button type="button" onClick={submit} disabled={!canSubmit} className={`flex-[2] px-3 py-2 rounded-lg text-xs font-bold text-oncolor focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/50 disabled:opacity-40 disabled:cursor-not-allowed ${sideTone}`}>
                  {placing ? 'Placing…' : `${isBuy ? 'Buy' : 'Sell'} ${qty} ${symbol} · ${PRODUCT_LABEL[product].split(' ')[0]} · ${orderType === 'LIMIT' ? 'Limit' : 'Market'}`}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
