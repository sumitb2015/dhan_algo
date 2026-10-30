'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Loader2, ArrowUpRight, ArrowDownRight, XCircle } from 'lucide-react';
import { BROKER_LABELS, scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import {
  FLAT_LEG, applyPaperFill, describePosition, lotCap, paperPnl, type LegResult, type PaperLeg, type PnfAction, type PnfProduct,
} from '@/lib/pnfOrderLogic';
import { legPositions, type Book } from '@/lib/pnfAccount';
import { fetchSliceTradedPrice, type TradedSliceMemo } from '@/lib/tradedPriceClient';
import { targetKey, type Target } from '@/lib/pnfTarget';
import type { PnfExecutionMarker } from '@/lib/straddlePnf';

// The P&F page's 1-click trade bar. It names only the chart's target, the side and the lots: the server resolves the
// contract and lot size, and sizes a SQUARE OFF from the broker's own book (app/api/straddle-pnf/order). REAL is never
// remembered: every page load starts in PAPER.

export interface PnfTradeBarProps {
  target: Target;
  /** Live prices: a straddle's CE and PE, or one instrument's price split as ce + pe. */
  live: { ce: number; pe: number } | null;
  /** The account orders go to: the page header's broker picker owns it (one source for the bar and the Margin / P&L chips). */
  broker: Broker;
  mode: 'PAPER' | 'REAL';
  onModeChange: (mode: 'PAPER' | 'REAL') => void;
  onPnlChange?: (pnl: number) => void;
  onSwitchTarget?: (target: Target) => void;
  onTradeExecuted?: (marker: PnfExecutionMarker) => void;
  /** A REAL marker's price once the broker reports the traded price (it starts at the live price, marked as an estimate). */
  onMarkerPrice?: (id: string, price: number) => void;
}

type LegInfo = { label: string; side: string; lot: number; unitsPerLot: number | null; key: string | null; lotUnits: number | null };
type Info = { key: string; legs: LegInfo[]; unsupported: string | null; error?: string };
type Real = { key: string; lots: number[]; book: Book } | { key: string; error: string };
type OrderReply = { success?: boolean; error?: string; outcome?: string; legs?: LegResult[]; message?: string };

/** A marker's id and time, taken when the order is sent (module scope: never called during render). */
const stamp = () => ({ id: `pnf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, t: Math.floor(Date.now() / 1000) });

const inr = (n: number) => `${n < 0 ? '-' : ''}₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
const pnlTone = (n: number | null) => (n == null || n === 0 ? 'text-zinc-400' : n > 0 ? 'text-emerald-400' : 'text-red-400');

export default function PnfTradeBar({
  target, live, broker, mode, onModeChange, onPnlChange, onSwitchTarget, onTradeExecuted, onMarkerPrice,
}: PnfTradeBarProps) {
  const [productPick, setProduct] = useState<PnfProduct>('INTRADAY');
  const [lotsPick, setLots] = useState(1);
  const [lotsDraft, setLotsDraft] = useState('1');
  const [busy, setBusy] = useState(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [real, setReal] = useState<Real | null>(null);
  /** Paper legs per chart (targetKey), kept for the page's life so switching charts and back keeps them. */
  const [paper, setPaper] = useState<Record<string, PaperLeg[]>>({});
  const memoRef = useRef<TradedSliceMemo>(new Map());

  const isStraddle = target.kind === 'options' && target.side === 'STRADDLE';
  const isIndex = target.kind === 'index';
  const isEquity = target.kind === 'equity';
  const tk = targetKey(target);
  const infoKey = `${broker}|${tk}`;
  const cap = lotCap(target);
  // Derived, never stored: a cap or product that does not fit the current instrument falls back without an effect.
  const lots = Math.min(lotsPick, cap);
  const product: PnfProduct = isEquity ? (productPick === 'MARGIN' ? 'INTRADAY' : productPick) : productPick === 'CNC' ? 'INTRADAY' : productPick;

  // What one lot is, and whether this broker can trade the chart (server-resolved; the browser never names a contract).
  useEffect(() => {
    if (isIndex) return;
    let dead = false;
    void (async () => {
      try {
        const res = await fetch(`/api/straddle-pnf/order?broker=${broker}&target=${encodeURIComponent(JSON.stringify(target))}`);
        const j = await res.json() as { success?: boolean; error?: string; legs?: LegInfo[]; unsupported?: string | null };
        if (dead) return;
        setInfo(j.success ? { key: infoKey, legs: j.legs ?? [], unsupported: j.unsupported ?? null }
          : { key: infoKey, legs: [], unsupported: null, error: j.error ?? 'Contract lookup failed' });
      } catch {
        if (!dead) setInfo({ key: infoKey, legs: [], unsupported: null, error: 'Contract lookup failed' });
      }
    })();
    return () => { dead = true; };
    // target is fully described by its key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [infoKey, isIndex]);
  const cur = info && info.key === infoKey ? info : null;
  const keys = cur && !cur.unsupported ? cur.legs.map(l => l.key ?? '') : [];
  const lotUnits = cur && !cur.unsupported ? cur.legs.map(l => l.lotUnits ?? 0) : [];
  const keysSig = keys.join(',');

  // REAL: the chart's own position from the broker book every 5 s (the poll route prices Kotak legs from the live chain).
  useEffect(() => {
    if (mode !== 'REAL' || !keysSig) return;
    let dead = false;
    const k = keys.slice(), units = lotUnits.slice();
    const read = async () => {
      try {
        const res = await fetch(`${scalperRoute(broker, 'poll')}?only=positions`);
        const j = await res.json() as { positions?: Array<Record<string, unknown>>; positionsError?: string | null; error?: string };
        if (dead) return;
        if (j.positionsError || !Array.isArray(j.positions)) setReal({ key: infoKey, error: j.positionsError ?? j.error ?? 'Positions unavailable' });
        else setReal({ key: infoKey, ...legPositions(j.positions, broker !== 'dhan', k, units) });
      } catch {
        if (!dead) setReal({ key: infoKey, error: 'Positions unavailable' });
      }
    };
    void read();
    const id = setInterval(read, 5_000);
    return () => { dead = true; clearInterval(id); };
    // keys / lotUnits are fully described by keysSig + infoKey
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, broker, keysSig, infoKey]);

  // Leg prices: CE and PE for a straddle, else the one instrument's price.
  const prices: (number | null)[] = !live ? [null, null] : isStraddle ? [live.ce || null, live.pe || null] : [live.ce + live.pe || null];
  const paperLegs = paper[tk] ?? [];
  const unitsPerLot = (cur?.legs ?? []).map(l => l.unitsPerLot ?? l.lot);
  const paperTotal = paperLegs.length ? paperPnl(paperLegs, prices, unitsPerLot) : 0;
  const sides = (cur?.legs ?? []).map(l => l.side);

  const r = real && real.key === infoKey ? real : null;
  const position = isIndex ? null
    : mode === 'PAPER' ? describePosition(paperLegs.map(l => l.lots), sides, isEquity)
    : r && 'lots' in r ? describePosition(r.lots, sides, isEquity) : null;
  const shownPnl = mode === 'PAPER' ? (paperLegs.length ? paperTotal : null) : r && 'book' in r ? r.book.total : null;

  useEffect(() => { onPnlChange?.(paperTotal); }, [paperTotal, onPnlChange]);

  const commitLots = (raw: string) => {
    const val = parseInt(raw, 10);
    const next = Math.max(1, Math.min(cap, Number.isNaN(val) ? lots : val));
    setLots(next);
    setLotsDraft(String(next));
  };
  const pickLots = (n: number) => { const next = Math.max(1, Math.min(cap, n)); setLots(next); setLotsDraft(String(next)); };

  const unsupported = mode === 'REAL' ? cur?.unsupported ?? cur?.error ?? null : cur?.error ?? null;
  const ready = !!cur && !unsupported && cur.legs.length > 0;

  // ── Order dispatch ────────────────────────────────────────────────────────
  const post = async (body: Record<string, unknown>): Promise<OrderReply> => {
    const res = await fetch('/api/straddle-pnf/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ broker, mode, target, ...body }),
    });
    return await res.json() as OrderReply;
  };

  const marker = (action: PnfAction, n: number, estimate: boolean) => {
    const px = prices.reduce<number>((s, p) => s + (p ?? 0), 0);
    const m: PnfExecutionMarker = { ...stamp(), action, price: px, lots: n, mode, estimate };
    onTradeExecuted?.(m);
    return m.id;
  };

  /** The traded price of a REAL send (a straddle's is CE + PE, each leg qty-weighted over its rows), then the marker moves to it. */
  const settleMarker = async (id: string, legs: LegResult[]) => {
    const byLeg = new Map<string, { qty: number; value: number }>();
    for (const l of legs) {
      if (l.status !== 'placed' || !l.orderId) return;
      const px = await fetchSliceTradedPrice(l.orderId, 'open', l.qty, memoRef.current, { broker });
      if (px == null) return;                                   // never reported: the marker stays an estimate
      const cur = byLeg.get(l.label) ?? { qty: 0, value: 0 };
      byLeg.set(l.label, { qty: cur.qty + l.qty, value: cur.value + px * l.qty });
    }
    const price = [...byLeg.values()].reduce((s, v) => s + v.value / v.qty, 0);
    if (price > 0) onMarkerPrice?.(id, price);
  };

  const paperFill = (deltaLots: number[]) => {
    if (prices.slice(0, deltaLots.length).some(p => p == null)) { toast.error('No live price yet - paper order not filled'); return false; }
    setPaper(prev => {
      const legs = prev[tk] ?? deltaLots.map(() => FLAT_LEG);
      return { ...prev, [tk]: legs.map((l, i) => applyPaperFill(l, deltaLots[i] ?? 0, prices[i]!, unitsPerLot[i] ?? 1)) };
    });
    return true;
  };

  const reportReply = (j: OrderReply, what: string): boolean => {
    const msg = j.message ?? j.error ?? 'Unknown error';
    if (j.outcome === 'placed') { toast.success(`[${BROKER_LABELS[broker].toUpperCase()}] ${what}. ${msg}`); return true; }
    if (j.outcome === 'partial') toast.error(msg, { duration: Infinity });
    else if (j.outcome === 'unknown') toast.warning(msg, { duration: Infinity });
    else if (j.outcome === 'reversed') toast.warning(msg, { duration: 15_000 });
    else toast.error(`Order failed: ${msg}`);
    return false;
  };

  const executeOrder = async (action: PnfAction) => {
    if (isIndex || !ready || busy) return;
    setBusy(true);
    try {
      if (mode === 'PAPER') {
        const j = await post({ action, lots, product });
        if (!j.success) { toast.error(`Order failed: ${j.error ?? 'Unknown error'}`); return; }
        const delta = cur!.legs.map(() => (action === 'BUY' ? lots : -lots));
        if (!paperFill(delta)) return;
        toast.success(`[PAPER] ${action} ${lots} ${isEquity ? 'sh' : `lot${lots > 1 ? 's' : ''}`} ${product}`);
        marker(action, lots, false);
        return;
      }
      const j = await post({ action, lots, product });
      if (reportReply(j, `${action} ${lots} ${isEquity ? 'sh' : `lot${lots > 1 ? 's' : ''}`} ${product}`)) {
        const id = marker(action, lots, true);
        void settleMarker(id, j.legs ?? []);
      }
    } catch (err) {
      toast.warning(`Order status unknown - check Orders/Positions before retrying (${(err as Error).message})`, { duration: Infinity });
    } finally {
      setBusy(false);
    }
  };

  /** Close the whole position on the chart's contract(s): paper from the ledger, REAL sized by the server from the broker book. */
  const executeSquareOff = async () => {
    if (!position || busy) return;
    setBusy(true);
    try {
      if (mode === 'PAPER') {
        const delta = paperLegs.map(l => -l.lots);
        if (!paperFill(delta)) return;
        const action: PnfAction = paperLegs[0].lots > 0 ? 'SELL' : 'BUY';
        toast.success('[PAPER] position squared off');
        marker(action, Math.max(...paperLegs.map(l => Math.abs(l.lots))), false);
        return;
      }
      const j = await post({ close: true });
      if (reportReply(j, 'Square off')) {
        const legs = j.legs ?? [];
        const id = marker(legs[0]?.side ?? 'SELL', r && 'lots' in r ? Math.max(...r.lots.map(Math.abs)) : 0, true);
        void settleMarker(id, legs);
      }
    } catch (err) {
      toast.warning(`Close status unknown - check Orders/Positions before retrying (${(err as Error).message})`, { duration: Infinity });
    } finally {
      setBusy(false);
    }
  };

  const pill = (active: boolean) =>
    `px-2 h-6 text-[11px] font-bold rounded transition-colors ${active ? 'bg-zinc-700 text-white' : 'text-zinc-400 hover:text-zinc-200'}`;
  const disabled = busy || !ready;
  const squareTitle = mode === 'REAL'
    ? `Closes the whole ${BROKER_LABELS[broker]} position on this contract (every product), including any opened from another page`
    : 'Closes the paper position';

  const squareOff = position && (
    <button type="button" disabled={busy} onClick={executeSquareOff} title={squareTitle}
            className="flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold bg-amber-600 hover:bg-amber-500 text-oncolor disabled:opacity-50 disabled:cursor-not-allowed transition-colors">
      <XCircle className="w-3.5 h-3.5" />
      <span>SQUARE OFF</span>
    </button>
  );
  const actionButton = (action: PnfAction, label: string) => (
    <button type="button" disabled={disabled} onClick={() => executeOrder(action)}
            className={`flex items-center gap-1.5 px-3 h-7 rounded text-xs font-bold ${action === 'BUY' ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-red-600 hover:bg-red-500'} text-oncolor disabled:opacity-50 disabled:cursor-not-allowed shadow transition-colors`}>
      {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : action === 'BUY' ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
      <span>{label}</span>
    </button>
  );

  return (
    <div data-testid="pnf-trade-bar" className="flex items-center gap-x-4 gap-y-2 flex-wrap px-6 py-2 bg-zinc-900/70 border-b border-zinc-800 text-xs">
      {/* 1. Broker & Trading Mode */}
      <div className="flex items-center gap-2">
        {/* the broker is picked in the page header; the bar names it so the order target is never in doubt */}
        <span data-testid="pnf-trade-broker" className="text-[11px] font-bold text-zinc-300">{BROKER_LABELS[broker]}</span>
        <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Execution mode">
          <button type="button" className={pill(mode === 'PAPER')} onClick={() => onModeChange('PAPER')} title="Simulate orders without placing real trades">
            PAPER
          </button>
          <button type="button"
                  className={`px-2 h-6 text-[11px] font-bold rounded transition-colors ${mode === 'REAL' ? 'bg-red-500/20 text-red-400 border border-red-500/40' : 'text-zinc-400 hover:text-zinc-200'}`}
                  onClick={() => onModeChange('REAL')} title="Place live orders with real capital (not remembered: every page load starts in PAPER)">
            REAL
          </button>
        </div>
      </div>

      <span className="w-px h-5 bg-zinc-800 shrink-0" />

      {/* 2. Product & Lot Sizing */}
      {!isIndex && (
        <div className="flex items-center gap-3">
          <div className="inline-flex items-center gap-0.5 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950" role="group" aria-label="Product">
            <button type="button" className={pill(product === 'INTRADAY')} onClick={() => setProduct('INTRADAY')}>MIS</button>
            {isEquity
              ? <button type="button" className={pill(product === 'CNC')} onClick={() => setProduct('CNC')}>CNC</button>
              : <button type="button" className={pill(product === 'MARGIN')} onClick={() => setProduct('MARGIN')}>NRML</button>}
          </div>

          {/* Sizing Input with commit-on-blur */}
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-400 text-[11px] font-medium">{isEquity ? 'Qty' : 'Lots'}:</span>
            <div className="inline-flex items-center rounded border border-zinc-700 bg-zinc-950">
              <button type="button" aria-label={`Decrease ${isEquity ? 'quantity' : 'lots'}`}
                      className="w-6 h-6 flex items-center justify-center text-zinc-300 hover:bg-zinc-800 rounded-l" onClick={() => pickLots(lots - 1)}>
                −
              </button>
              <input
                type="text"
                aria-label={isEquity ? 'Order quantity' : 'Order lots'}
                value={lotsDraft}
                onChange={e => setLotsDraft(e.target.value)}
                onBlur={e => commitLots(e.currentTarget.value)}
                onKeyDown={e => {
                  if (e.key === 'Enter') {
                    commitLots((e.target as HTMLInputElement).value);
                    (e.target as HTMLInputElement).blur();
                  }
                  if (e.key === 'Escape') { setLotsDraft(String(lots)); (e.target as HTMLInputElement).blur(); }
                }}
                className="w-10 h-6 text-center text-xs font-mono font-bold bg-transparent text-white focus:outline-none"
              />
              <button type="button" aria-label={`Increase ${isEquity ? 'quantity' : 'lots'}`}
                      className="w-6 h-6 flex items-center justify-center text-zinc-300 hover:bg-zinc-800 rounded-r" onClick={() => pickLots(lots + 1)}>
                +
              </button>
            </div>

            {/* Quick lot presets */}
            <div className="flex items-center gap-1">
              {(isEquity ? [10, 50, 100] : [1, 2, 5, 10]).map(n => (
                <button key={n} type="button" onClick={() => pickLots(n)}
                        className={`px-1.5 h-6 rounded text-[10px] font-mono border ${lots === n ? 'border-zinc-500 bg-zinc-800 text-white' : 'border-zinc-800 bg-zinc-950 text-zinc-400 hover:text-zinc-200'}`}>
                  {isEquity ? n : `${n}L`}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* 3. Action Buttons */}
      <div className="flex items-center gap-2 ml-auto">
        {isIndex ? (
          <div className="flex items-center gap-2">
            <span className="text-zinc-400 text-[11px] italic">Index spot is non-tradable directly.</span>
            {onSwitchTarget && (
              <>
                <button type="button" onClick={() => onSwitchTarget({ kind: 'options', symbol: target.symbol, name: target.name || target.symbol, side: 'STRADDLE' })}
                        className="px-2.5 h-7 rounded text-[11px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors">
                  Trade ATM Straddle
                </button>
                <button type="button" onClick={() => onSwitchTarget({ kind: 'futures', symbol: target.symbol, name: target.name || target.symbol })}
                        className="px-2.5 h-7 rounded text-[11px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700 transition-colors">
                  Trade Near Future
                </button>
              </>
            )}
          </div>
        ) : (
          <>
            {unsupported && <span data-testid="pnf-trade-unsupported" className="text-[11px] text-amber-400 max-w-[22rem] truncate" title={unsupported}>{unsupported}</span>}
            {isStraddle
              ? <>{actionButton('SELL', 'SHORT STRADDLE')}{actionButton('BUY', 'LONG STRADDLE')}</>
              : <>{actionButton('BUY', 'BUY MARKET')}{actionButton('SELL', 'SELL MARKET')}</>}
            {squareOff}
          </>
        )}

        {/* 4. Active Position & P&L readout */}
        {!isIndex && (
          <div className="flex items-center gap-2 pl-3 border-l border-zinc-800 font-mono text-[11px]">
            {mode === 'REAL' && r && 'error' in r ? (
              <span className="text-amber-400" title={r.error}>POSITION ?</span>
            ) : position ? (
              <div className="flex items-center gap-2">
                <span data-testid="pnf-trade-position"
                      className={`px-1.5 py-0.5 rounded font-bold ${position.side === 'LONG' ? 'bg-emerald-500/20 text-emerald-400' : position.side === 'SHORT' ? 'bg-red-500/20 text-red-400' : 'bg-amber-500/20 text-amber-400'}`}>
                  {position.text}
                </span>
                {shownPnl != null && <span className={`font-bold ${pnlTone(shownPnl)}`}>{inr(shownPnl)}</span>}
              </div>
            ) : (
              <span className="text-zinc-500">FLAT{mode === 'PAPER' && shownPnl ? <span className={`ml-2 font-bold ${pnlTone(shownPnl)}`}>{inr(shownPnl)}</span> : null}</span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
