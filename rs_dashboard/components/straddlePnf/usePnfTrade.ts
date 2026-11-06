'use client';

import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { BROKER_LABELS, scalperRoute, type Broker } from '@/hooks/useBrokerSelector';
import {
  FLAT_LEG, applyPaperFill, describePosition, liveRealPnl, lotCap, paperPnl, type LegResult, type PaperLeg, type PnfAction, type PnfProduct,
} from '@/lib/pnfOrderLogic';
import { legPositions, type Book } from '@/lib/pnfAccount';
import type { BracketSpec } from '@/lib/pnfBracket';
import { fetchSliceTradedPrice, type TradedSliceMemo } from '@/lib/tradedPriceClient';
import { targetKey, type Target } from '@/lib/pnfTarget';
import type { PnfExecutionMarker } from '@/lib/straddlePnf';
import type { PnfScope } from '@/lib/pnfScope';

// The P&F / Renko page's 1-click order engine, shared by the trade bar and the Scalper window so both trade one position
// with one lots value. It names only the chart's target, the side and the lots: the server resolves the contract and lot
// size, and sizes a SQUARE OFF from the broker's own book (app/api/straddle-pnf/order). REAL is never remembered: every
// page load starts in PAPER.

export interface PnfTradeOptions {
  target: Target;
  /** Live prices: a straddle's CE and PE, or one instrument's price split as ce + pe. */
  live: { ce: number; pe: number } | null;
  /** The account orders go to: the page header's broker picker owns it (one source for the bar and the Margin / P&L chips). */
  broker: Broker;
  mode: 'PAPER' | 'REAL';
  onPnlChange?: (pnl: number) => void;
  /** `target` is the chart target at the click, so a chart switch while the order is out never files it under another scrip. */
  onTradeExecuted?: (marker: PnfExecutionMarker, target: Target) => void;
  /** A REAL marker's price once the broker reports the traded price (it starts at the live price, marked as an estimate). */
  onMarkerPrice?: (id: string, price: number) => void;
  /** The paper ledger per chart (targetKey), owned by the page so resting orders on the rail fill into the same position. */
  paper: Record<string, PaperLeg[]>;
  setPaper: React.Dispatch<React.SetStateAction<Record<string, PaperLeg[]>>>;
  /** The current lots / product, for the rail's orders. */
  onSizing?: (s: { lots: number; product: PnfProduct }) => void;
  /** The Single / Bracket / Cover choice: a spec to attach to the next entry, null for Single, or why it is not ready (the order is then NOT sent). */
  bracketSpec?: () => BracketSpec | null | string;
  /** An entry order (not one that reduces the position) went through: the page arms its bracket exits. */
  onEntered?: (e: { action: PnfAction; lots: number; price: number; mode: 'PAPER' | 'REAL'; product: PnfProduct; spec: BracketSpec }) => void;
  /** A manual square off went through: the chart's bracket exits are cancelled. */
  onSquaredOff?: () => void;
  /** A manual order's outcome, for the page's trade chimes (entry / exit / warn, lib/pnfChime.ts). */
  onSound?: (outcome: string | undefined, close: boolean) => void;
  /** The page (P&F or Renko) whose resting ledger the order route checks for this chart's open orders. */
  scope?: PnfScope;
}

type LegInfo = { label: string; side: string; lot: number; unitsPerLot: number | null; key: string | null; lotUnits: number | null };
type Info = { key: string; legs: LegInfo[]; unsupported: string | null; error?: string };
/** `atPoll`: the leg prices when the poll landed, so the P&L can follow the ticks until the next poll. */
type Real = { key: string; lots: number[]; book: Book; atPoll: (number | null)[] } | { key: string; error: string };
type OrderReply = { success?: boolean; error?: string; outcome?: string; legs?: LegResult[]; message?: string };

/** A marker's id and time, taken when the order is sent (module scope: never called during render). */
const stamp = () => ({ id: `pnf-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, t: Math.floor(Date.now() / 1000) });

export type PnfTrade = ReturnType<typeof usePnfTrade>;

export function usePnfTrade({
  target, live, broker, mode, onPnlChange, onTradeExecuted, onMarkerPrice, onSound, paper, setPaper, onSizing, bracketSpec, onEntered, onSquaredOff, scope = 'pnf',
}: PnfTradeOptions) {
  const [productPick, setProduct] = useState<PnfProduct>('INTRADAY');
  const [lotsPick, setLots] = useState(1);
  const [lotsDraft, setLotsDraft] = useState('1');
  const [busy, setBusy] = useState(false);
  // One order at a time, checked synchronously: a hotkey and a click in the same frame must not both send.
  const inFlight = useRef(false);
  const [info, setInfo] = useState<Info | null>(null);
  const [real, setReal] = useState<Real | null>(null);
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
  useEffect(() => { onSizing?.({ lots, product }); }, [lots, product, onSizing]);

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

  // Leg prices: CE and PE for a straddle, else the one instrument's price.
  const prices: (number | null)[] = !live ? [null, null] : isStraddle ? [live.ce || null, live.pe || null] : [live.ce + live.pe || null];
  const pricesRef = useRef(prices);
  useEffect(() => { pricesRef.current = prices; });

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
        else setReal({ key: infoKey, ...legPositions(j.positions, broker !== 'dhan', k, units), atPoll: pricesRef.current.slice() });
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

  const paperLegs = paper[tk] ?? [];
  const unitsPerLot = (cur?.legs ?? []).map(l => l.unitsPerLot ?? l.lot);
  const paperTotal = paperLegs.length ? paperPnl(paperLegs, prices, unitsPerLot) : 0;
  const sides = (cur?.legs ?? []).map(l => l.side);

  const r = real && real.key === infoKey ? real : null;
  const positionLots: number[] = isIndex ? [] : mode === 'PAPER' ? paperLegs.map(l => l.lots) : r && 'lots' in r ? r.lots : [];
  const position = isIndex ? null : positionLots.length ? describePosition(positionLots, sides, isEquity) : null;
  const shownPnl = mode === 'PAPER' ? (paperLegs.length ? paperTotal : null)
    : r && 'book' in r ? (r.book.unpriced > 0 ? r.book.total : liveRealPnl(r.book.total, r.lots, r.atPoll, prices, unitsPerLot)) : null;
  /** Paper: the average entry per leg (summed for a straddle); REAL has no average in the book reply. */
  const paperAvg = mode === 'PAPER' && paperLegs.some(l => l.lots !== 0) ? paperLegs.reduce((s, l) => s + (l.lots ? l.avg : 0), 0) : null;
  const realError = mode === 'REAL' && r && 'error' in r ? r.error : null;

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
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ broker, mode, target, scope, ...body }),
    });
    return await res.json() as OrderReply;
  };

  const marker = (action: PnfAction, n: number, estimate: boolean) => {
    const px = prices.reduce<number>((s, p) => s + (p ?? 0), 0);
    const m: PnfExecutionMarker = { ...stamp(), action, price: px, lots: n, mode, estimate };
    onTradeExecuted?.(m, target);
    return m.id;
  };

  /** Looks up the traded price of a REAL send (a straddle's is CE + PE, each leg qty-weighted over its rows) and moves the
   *  marker to it; resolves with that price (null when the broker never reported it). */
  const settleMarker = async (id: string, legs: LegResult[]): Promise<number | null> => {
    const byLeg = new Map<string, { qty: number; value: number }>();
    for (const l of legs) {
      if (l.status !== 'placed' || !l.orderId) return null;
      const px = await fetchSliceTradedPrice(l.orderId, 'open', l.qty, memoRef.current, { broker });
      if (px == null) return null;                              // never reported: the marker stays an estimate
      const c = byLeg.get(l.label) ?? { qty: 0, value: 0 };
      byLeg.set(l.label, { qty: c.qty + l.qty, value: c.value + px * l.qty });
    }
    const price = [...byLeg.values()].reduce((s, v) => s + v.value / v.qty, 0);
    if (price > 0) onMarkerPrice?.(id, price);
    return price > 0 ? price : null;
  };

  const paperFill = (deltaLots: number[]) => {
    if (prices.slice(0, deltaLots.length).some(p => p == null)) { toast.error('No live price yet - paper order not filled'); return false; }
    setPaper(prev => {
      const legs = prev[tk] ?? deltaLots.map(() => FLAT_LEG);
      return { ...prev, [tk]: legs.map((l, i) => applyPaperFill(l, deltaLots[i] ?? 0, prices[i]!, unitsPerLot[i] ?? 1)) };
    });
    return true;
  };

  const reportReply = (j: OrderReply, what: string, close: boolean): boolean => {
    onSound?.(j.outcome, close);
    const msg = j.message ?? j.error ?? 'Unknown error';
    if (j.outcome === 'placed') { toast.success(`[${BROKER_LABELS[broker].toUpperCase()}] ${what}. ${msg}`); return true; }
    // a square-off that found only the other page's AUTO quantity on the contract: nothing was sent, nothing failed
    if (j.outcome === 'kept') { toast.info(msg, { duration: 15_000 }); return false; }
    if (j.outcome === 'partial') toast.error(msg, { duration: Infinity });
    else if (j.outcome === 'unknown') toast.warning(msg, { duration: Infinity });
    else if (j.outcome === 'reversed') toast.warning(msg, { duration: 15_000 });
    else toast.error(`Order failed: ${msg}`);
    return false;
  };

  /** One order out at a time; resolves true only when the order went through. */
  const exclusive = async (fn: () => Promise<boolean>): Promise<boolean> => {
    if (inFlight.current) return false;
    inFlight.current = true;
    setBusy(true);
    try { return await fn(); } finally { inFlight.current = false; setBusy(false); }
  };

  /** `n` lots (default: the stepper's); `entry` forces an entry (a reverse's second leg, sent while the old position still shows). */
  const sendOrder = async (action: PnfAction, n = lots, entry = false): Promise<boolean> => {
    // An order against the open position reduces it: it sounds like an exit, not a new trade.
    const reduces = !entry && !!position && position.side !== 'MIXED' && (position.side === 'LONG') === (action === 'SELL');
    // Bracket / Cover chosen but not filled in: refuse, never send a plain order the user thought had exits.
    const spec = reduces ? null : bracketSpec?.() ?? null;
    if (typeof spec === 'string') { toast.error(spec); return false; }
    const entryPrice = live ? live.ce + live.pe : 0;
    const what = `${action} ${n} ${isEquity ? 'sh' : `lot${n > 1 ? 's' : ''}`} ${product}`;
    try {
      if (mode === 'PAPER') {
        const j = await post({ action, lots: n, product });
        if (!j.success) { onSound?.('rejected', reduces); toast.error(`Order failed: ${j.error ?? 'Unknown error'}`); return false; }
        const delta = cur!.legs.map(() => (action === 'BUY' ? n : -n));
        if (!paperFill(delta)) { onSound?.('rejected', reduces); return false; }
        onSound?.('placed', reduces);
        toast.success(`[PAPER] ${what}`);
        marker(action, n, false);
        if (spec) onEntered?.({ action, lots: n, price: entryPrice, mode: 'PAPER', product, spec });
        return true;
      }
      const j = await post({ action, lots: n, product });
      if (!reportReply(j, what, reduces)) return false;
      const id = marker(action, n, true);
      // The bracket is anchored to the TRADED price once the broker reports it (the pre-order quote only if it never does).
      void settleMarker(id, j.legs ?? []).then(px => { if (spec) onEntered?.({ action, lots: n, price: px ?? entryPrice, mode: 'REAL', product, spec }); });
      return true;
    } catch (err) {
      onSound?.('unknown', reduces);
      toast.warning(`Order status unknown - check Orders/Positions before retrying (${(err as Error).message})`, { duration: Infinity });
      return false;
    }
  };

  /** Close the whole position on the chart's contract(s): paper from the ledger, REAL sized by the server from the broker book. */
  const sendSquareOff = async (): Promise<boolean> => {
    if (!position) return false;
    try {
      if (mode === 'PAPER') {
        const delta = paperLegs.map(l => -l.lots);
        if (!paperFill(delta)) { onSound?.('rejected', true); return false; }
        const action: PnfAction = paperLegs[0].lots > 0 ? 'SELL' : 'BUY';
        onSound?.('placed', true);
        toast.success('[PAPER] position squared off');
        marker(action, Math.max(...paperLegs.map(l => Math.abs(l.lots))), false);
        onSquaredOff?.();
        return true;
      }
      const j = await post({ close: true });
      if (!reportReply(j, 'Square off', true)) return false;
      onSquaredOff?.();
      const legs = j.legs ?? [];
      const id = marker(legs[0]?.side ?? 'SELL', positionLots.length ? Math.max(...positionLots.map(Math.abs)) : 0, true);
      void settleMarker(id, legs);
      return true;
    } catch (err) {
      onSound?.('unknown', true);
      toast.warning(`Close status unknown - check Orders/Positions before retrying (${(err as Error).message})`, { duration: Infinity });
      return false;
    }
  };

  const executeOrder = (action: PnfAction) => (isIndex || !ready ? Promise.resolve(false) : exclusive(() => sendOrder(action)));
  const executeSquareOff = () => exclusive(sendSquareOff);
  /** Flip the position: close it (server-sized from the book), then open the same size the other way. The entry goes only
   *  after a confirmed close, so an unclear close never becomes a doubled position. */
  const executeReverse = () => exclusive(async () => {
    if (!ready || !position || position.side === 'MIXED') return false;
    const size = Math.min(cap, Math.max(...positionLots.map(Math.abs)));
    const action: PnfAction = position.side === 'LONG' ? 'SELL' : 'BUY';
    if (!(size > 0) || !(await sendSquareOff())) return false;
    return sendOrder(action, size, true);
  });

  return {
    isIndex, isEquity, isStraddle, cap, lots, lotsDraft, setLotsDraft, commitLots, pickLots, product, setProduct,
    busy, ready, unsupported, position, positionLots, shownPnl, paperAvg, realError, prices,
    /** Units (shares / barrels / contracts) per lot of the first leg, for a "= 20 bbl" hint; null until the lookup answers. */
    unitsPerLot: unitsPerLot.length ? unitsPerLot[0] : null,
    executeOrder, executeSquareOff, executeReverse,
  };
}
