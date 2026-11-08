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
import { targetKey, targetLabel, type Target } from '@/lib/pnfTarget';
import type { PnfExecutionMarker } from '@/lib/straddlePnf';
import type { PnfScope } from '@/lib/pnfScope';
import { dirOf, otherDir, type IndexDir, type IndexMap } from '@/lib/pnfIndexMap';
import type { HeldRow } from '@/lib/pnfIndexHeld';
import type { HeldOps } from './useIndexHeld';

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
  /** The next entry's bracket; `side` / `entry` = the order's side and expected price (a Renko Log % chart measures its boxes from it). */
  bracketSpec?: (side?: PnfAction, entry?: number) => BracketSpec | null | string;
  /** An entry order (not one that reduces the position) went through: the page arms its bracket exits. */
  onEntered?: (e: { action: PnfAction; lots: number; price: number; mode: 'PAPER' | 'REAL'; product: PnfProduct; spec: BracketSpec }) => void;
  /** A manual square off went through: the chart's bracket exits are cancelled. */
  onSquaredOff?: () => void;
  /** A manual order's outcome, for the page's trade chimes (entry / exit / warn, lib/pnfChime.ts). */
  onSound?: (outcome: string | undefined, close: boolean) => void;
  /** The page (P&F or Renko) whose resting ledger the order route checks for this chart's open orders. */
  scope?: PnfScope;
  /**
   * An INDEX chart that trades options (Renko, lib/pnfIndexMap.ts): Buy = the map's bullish leg, Sell = its bearish leg, each resolved
   * ATM +/- N by the server at the click. While a leg is held every order acts on THAT contract (`held.traded`): the same side adds to
   * it, the other side reduces it, Reverse closes it and opens the other side's leg. Without it an index chart cannot be traded.
   */
  index?: IndexTradeOptions;
}

export interface IndexTradeOptions {
  chart: 1 | 2;
  map: IndexMap;
  held: HeldRow | null;
  /** REAL: the held-option ledger is not read yet (nothing may be sent on a guess) or cannot be read. */
  heldLoading: boolean;
  heldError: string | null;
  ops: HeldOps;
  /** The held option's live price (null when flat or not read yet). */
  tradedLtp: number | null;
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
  target: chartTarget, live: chartLive, broker, mode, onPnlChange, onTradeExecuted, onMarkerPrice, onSound, paper, setPaper, onSizing, bracketSpec, onEntered, onSquaredOff, scope = 'pnf',
  index,
}: PnfTradeOptions) {
  // An index chart with a map trades the option it holds: every order, position and P&L below is that contract's.
  const mapped = chartTarget.kind === 'index' && !!index;
  const held = mapped ? index.held : null;
  const target: Target = held ? held.traded : chartTarget;
  const live = mapped ? (held && index.tradedLtp ? { ce: index.tradedLtp, pe: 0 } : null) : chartLive;
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
  // true while there is nothing to trade on this chart (an index without a map, or a mapped index that holds nothing yet)
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
  /** Broker quantity of one lot of the chart's contract: REAL the broker's own lot units, PAPER the exchange lot. */
  const heldPerLot = cur?.legs[0] ? (mode === 'REAL' ? cur.legs[0].lotUnits ?? 0 : cur.legs[0].lot) : 0;
  /** Mapped index chart: lots THIS chart holds of the held option (its ledger's own units), not the broker's net, which may include
   *  another page's or strategy's lots of the same strike. */
  const ownLots = held && held.units > 0 && heldPerLot > 0 ? held.units / heldPerLot : 0;
  const brokerLots: number[] = r && 'lots' in r ? r.lots : [];
  const positionLots: number[] = isIndex ? []
    : mapped ? (ownLots > 0 ? [(held!.action === 'BUY' ? 1 : -1) * ownLots] : [])
    : mode === 'PAPER' ? paperLegs.map(l => l.lots) : brokerLots;
  const position = isIndex ? null : positionLots.length ? describePosition(positionLots, sides, isEquity) : null;
  const brokerPnl = r && 'book' in r ? (r.book.unpriced > 0 ? r.book.total : liveRealPnl(r.book.total, r.lots, r.atPoll, prices, unitsPerLot)) : null;
  // A mapped chart owns only part of the broker's strike when another page / strategy holds lots of it: its P&L is that share
  // (pro rata on lots - the broker's own average is shared), never the whole strike's.
  const brokerAbsLots = brokerLots.reduce((s, l) => s + Math.abs(l), 0);
  const shownPnl = mode === 'PAPER' ? (paperLegs.length ? paperTotal : null)
    : mapped ? (brokerPnl === null || ownLots <= 0 || brokerAbsLots <= 0 ? null : brokerPnl * Math.min(1, ownLots / brokerAbsLots))
    : brokerPnl;
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

  // A failed ledger read does not block: the last read stays valid (a Close must never be refused over a missed poll). The page waits
  // only for the FIRST read (heldLoading) and for an order that is not settled.
  const heldBlock = !mapped ? null : (held && held.state !== 'open'
    ? `The last ${held.dir === 'bull' ? 'bullish' : 'bearish'} order is ${held.state === 'unknown' ? 'UNKNOWN' : 'still being sent'} - check Orders/Positions, then settle it`
    : null);
  const unsupported = heldBlock ?? (mode === 'REAL' ? cur?.unsupported ?? cur?.error ?? null : cur?.error ?? null);
  const ready = !heldBlock && !!cur && !unsupported && cur.legs.length > 0;
  /** A mapped index chart can send: flat (the option is picked at the click) once the held ledger is read, or holding a priced leg. */
  const mappedReady = mapped && !heldBlock && !index.heldLoading && (!held || ready);

  // ── Order dispatch ────────────────────────────────────────────────────────
  const post = async (body: Record<string, unknown>, on: Target = target): Promise<OrderReply> => {
    const res = await fetch('/api/straddle-pnf/order', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ broker, mode, target: on, scope, ...body }),
    });
    return await res.json() as OrderReply;
  };

  const marker = (action: PnfAction, n: number, estimate: boolean, on?: { target: Target; price: number }) => {
    const px = on ? on.price : prices.reduce<number>((s, p) => s + (p ?? 0), 0);
    const m: PnfExecutionMarker = { ...stamp(), action, price: px, lots: n, mode, estimate };
    onTradeExecuted?.(m, on?.target ?? target);
    return m.id;
  };

  /** Looks up the traded price of a REAL send (a straddle's is CE + PE, each leg qty-weighted over its rows) and moves the
   *  marker to it; resolves with that price (null when the broker never reported it). */
  const settleMarker = async (id: string, legs: LegResult[]): Promise<number | null> => {
    const price = await tradedPriceOf(legs);                    // null = never reported: the marker stays an estimate
    if (price) onMarkerPrice?.(id, price);
    return price;
  };

  /** The traded price of a REAL send: each leg qty-weighted over its rows, summed over legs (a straddle's is CE + PE); null when the broker
   *  never reports one. */
  async function tradedPriceOf(legs: LegResult[]): Promise<number | null> {
    const byLeg = new Map<string, { qty: number; value: number }>();
    for (const l of legs) {
      if (l.status !== 'placed' || !l.orderId) return null;
      const px = await fetchSliceTradedPrice(l.orderId, 'open', l.qty, memoRef.current, { broker });
      if (px == null) return null;
      const c = byLeg.get(l.label) ?? { qty: 0, value: 0 };
      byLeg.set(l.label, { qty: c.qty + l.qty, value: c.value + px * l.qty });
    }
    const price = [...byLeg.values()].reduce((sum, v) => sum + v.value / v.qty, 0);
    return price > 0 ? price : null;
  }

  /** `on`: another contract than the chart's (a mapped index entry: the option just resolved, at its quoted price). */
  const paperFill = (deltaLots: number[], on?: { key: string; prices: (number | null)[]; unitsPerLot: number[] }) => {
    const key = on?.key ?? tk, px = on?.prices ?? prices, upl = on?.unitsPerLot ?? unitsPerLot;
    if (px.slice(0, deltaLots.length).some(p => p == null || !(p > 0))) { toast.error('No live price yet - paper order not filled'); return false; }
    setPaper(prev => {
      const legs = prev[key] ?? deltaLots.map(() => FLAT_LEG);
      return { ...prev, [key]: legs.map((l, i) => applyPaperFill(l, deltaLots[i] ?? 0, px[i]!, upl[i] ?? 1)) };
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
    const entryPrice = live ? live.ce + live.pe : 0;
    const spec = reduces ? null : bracketSpec?.(action, entryPrice) ?? null;
    if (typeof spec === 'string') { toast.error(spec); return false; }
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

  // ── Index chart -> option (lib/pnfIndexMap.ts) ──────────────────────────
  // Every mapped order (entry, add, reduce, close) goes reserve -> send -> settle through the held ledger: the row is reserved BEFORE the
  // order goes out (a second tab is refused meanwhile), and an unclear reply is 'unknown', settled by the user, never resent. Reductions
  // and closes are sized by the chart's OWN units (`held.units`, an exitOwn the server clamps to the broker row), never by the broker
  // net: another page or strategy may hold the same strike.
  /** Broker quantity of one lot: REAL the broker's own lot units, PAPER the exchange lot. */
  const perLotOf = (l?: { lot: number; lotUnits?: number | null }) => (l ? (mode === 'REAL' ? l.lotUnits ?? 0 : l.lot) : 0);
  const optSide = (a: PnfAction): PnfAction => (a === 'BUY' ? 'SELL' : 'BUY');

  /**
   * Markers of a mapped order: one on the INDEX chart at the index price (the chart's own direction: a bullish open or a bearish close is
   * a BUY arrow; `axis`, so it is never counted as a paper trade), and one on the option at its fill - PAPER at the quoted premium, REAL
   * at the broker's traded price once it reports it (none at a made-up price).
   */
  const mappedMarkers = (dir: IndexDir, opening: boolean, n: number, opt: { target: Target; action: PnfAction; paperPx?: number; legs?: LegResult[] }) => {
    const spot = chartLive ? chartLive.ce + chartLive.pe : 0;
    if (spot > 0) onTradeExecuted?.({ ...stamp(), action: (dir === 'bull') === opening ? 'BUY' : 'SELL', price: spot, lots: n, mode, axis: true }, chartTarget);
    if (opt.paperPx != null) { marker(opt.action, n, false, { target: opt.target, price: opt.paperPx }); return; }
    void tradedPriceOf(opt.legs ?? []).then(px => { if (px) marker(opt.action, n, false, { target: opt.target, price: px }); });
  };

  /** Sends one REAL order the held ledger has ALREADY reserved (row `id`) and settles the row by the reply. The reply when the order went
   *  through AND the ledger booked it; null otherwise (refused, unclear, or a ledger that could not be updated - all said in a toast). */
  const sendReserved = async (id: string, what: string, close: boolean, send: () => Promise<OrderReply>): Promise<OrderReply | null> => {
    const ix = index!;
    let j: OrderReply;
    try {
      j = await send();
    } catch (err) {
      const msg = (err as Error).message;
      await ix.ops.unknown(id, msg);
      onSound?.('unknown', close);
      toast.warning(`${what}: status unknown - check Orders/Positions, then settle it on the bar (${msg})`, { duration: Infinity });
      return null;
    }
    let settled: HeldRow | null | string;
    if (j.outcome === 'placed') settled = await ix.ops.confirm(id);
    else if (j.outcome === 'flat') {
      // the broker shows none of it in that direction: nothing of this chart's is open there - forget the row
      settled = await ix.ops.confirm(id);
      if (settled && typeof settled !== 'string') settled = await ix.ops.clear(id);
      if (typeof settled !== 'string') { onSound?.('rejected', close); toast.info(`${what}: nothing of this chart's is open at ${BROKER_LABELS[broker]} - nothing was sent, the held option is forgotten`, { duration: 15_000 }); }
      else toast.error(`Held-option ledger: ${settled}`, { duration: Infinity });
      return null;
    } else if (j.outcome === 'rejected' || (!j.success && !j.outcome)) settled = await ix.ops.void(id);
    else settled = await ix.ops.unknown(id, j.message ?? j.error ?? j.outcome);
    const went = reportReply(j, what, close);
    if (typeof settled === 'string') {
      toast.error(`${went ? 'The order went through, but the' : 'The'} held-option ledger could not be updated (${settled}) - check Orders/Positions before the next order`, { duration: Infinity });
      return null;
    }
    return went ? j : null;
  };

  /** Opens the map's `dir` leg from flat: the server picks the option at the click (ATM +/- N from a fresh spot). */
  const enterMapped = async (dir: IndexDir, n: number): Promise<boolean> => {
    const ix = index!;
    const spec = bracketSpec?.() ?? null;
    if (typeof spec === 'string') { toast.error(spec); return false; }
    if (spec) { toast.error('Bracket / Cover is not available on an index chart yet - pick Single'); return false; }
    type Resolved = { success?: boolean; error?: string; traded: Target; action: PnfAction; ids: string; spot: number; premium: number | null;
      unsupported: string | null; legs: { label: string; lot: number; unitsPerLot: number | null; lotUnits: number | null }[] };
    let r: Resolved;
    try {
      const q = new URLSearchParams({ broker, target: JSON.stringify(chartTarget), map: JSON.stringify(ix.map), dir, premium: mode === 'PAPER' ? '1' : '0' });
      r = await (await fetch(`/api/straddle-pnf/index-trade?${q}`)).json() as Resolved;
    } catch (e) { toast.error(`Could not pick the option: ${(e as Error).message}. Nothing was sent.`); return false; }
    if (!r.success) { onSound?.('rejected', false); toast.error(`${r.error ?? 'Could not pick the option'}. Nothing was sent.`); return false; }
    if (mode === 'REAL' && r.unsupported) { onSound?.('rejected', false); toast.error(`${r.unsupported}. Nothing was sent.`); return false; }
    const leg = r.legs[0];
    const units = n * perLotOf(leg);
    if (!(units > 0)) { onSound?.('rejected', false); toast.error('The option\'s lot size is not known - nothing was sent'); return false; }
    const label = leg?.label ?? `${r.traded.strike} ${r.traded.side}`;
    const what = `${dir === 'bull' ? 'Bullish' : 'Bearish'}: ${r.action} ${n} lot${n > 1 ? 's' : ''} ${label} ${product}`;
    const row = { id: `ix-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, chart: ix.chart, indexKey: targetKey(chartTarget), broker,
      dir, traded: r.traded, action: r.action, product: product === 'MARGIN' ? 'MARGIN' as const : 'INTRADAY' as const, ids: r.ids, entryY: r.spot };
    if (mode === 'PAPER' && !(r.premium && r.premium > 0)) { onSound?.('rejected', false); toast.error(`No price for ${label} yet - paper order not filled`); return false; }
    const h = await ix.ops.enter(row, units);
    if (typeof h === 'string' || !h) { onSound?.('rejected', false); toast.error(`${h || 'Held-option ledger gave no row'}. Nothing was sent.`); return false; }
    if (mode === 'PAPER') {
      const j = await post({ action: r.action, lots: n, product: row.product }, r.traded).catch(() => null);   // the server's checks, as for any paper order
      if (!j?.success) { await ix.ops.void(h.id); onSound?.('rejected', false); toast.error(`Order failed: ${j?.error ?? 'no reply'}`); return false; }
      paperFill([r.action === 'BUY' ? n : -n], { key: targetKey(r.traded), prices: [r.premium], unitsPerLot: [leg?.unitsPerLot ?? leg?.lot ?? 1] });
      await ix.ops.confirm(h.id);
      onSound?.('placed', false);
      toast.success(`[PAPER] ${what} @ ${r.premium!.toFixed(2)}`);
      mappedMarkers(dir, true, n, { target: r.traded, action: r.action, paperPx: r.premium! });
      return true;
    }
    const j = await sendReserved(h.id, what, false, () => post({ action: r.action, lots: n, product: row.product }, r.traded));
    if (!j) return false;
    mappedMarkers(dir, true, n, { target: r.traded, action: r.action, legs: j.legs });
    return true;
  };

  /** `deltaUnits` more (+) or fewer (-) of the held option, in broker units: an add to it, or a reduce / close of the chart's OWN units
   *  (a close sends exactly `held.units`, so it never depends on a lot size that might have changed or not loaded). */
  const changeHeld = async (deltaUnits: number): Promise<boolean> => {
    const ix = index!, h = held!;
    const adding = deltaUnits > 0;
    const units = adding ? deltaUnits : Math.min(-deltaUnits, h.units);
    const closing = !adding && units >= h.units;
    // whole lots for the order / the paper book; a REAL close needs none (exitOwn is in units)
    const lotsN = heldPerLot > 0 ? units / heldPerLot : 0;
    const needLots = mode === 'PAPER' || adding;
    if (!(units > 0) || (needLots && !(Number.isInteger(lotsN) && lotsN > 0))) {
      toast.error(`The held option's lot size is not known (or ${units} is not whole lots) - nothing was sent. Check Positions; Forget the held option if it is gone.`, { duration: 15_000 });
      return false;
    }
    const side = adding ? h.action : optSide(h.action);
    const size = lotsN > 0 ? `${lotsN} lot${lotsN > 1 ? 's' : ''}` : `${units} units`;
    const what = `${closing ? 'Close' : adding ? 'Add' : 'Reduce'}: ${side} ${size} ${targetLabel(h.traded)}`;
    const px = prices[0];
    if (mode === 'PAPER' && !(px != null && px > 0)) { toast.error('No live price yet - paper order not filled'); return false; }
    const b = await ix.ops.begin(h.id, adding ? units : -units);
    if (typeof b === 'string' || !b) { onSound?.('rejected', !adding); toast.error(`${b || 'Held-option ledger gave no row'}. Nothing was sent.`); return false; }
    if (mode === 'PAPER') {
      if (adding) {
        const j = await post({ action: side, lots: lotsN, product: h.product }).catch(() => null);
        if (!j?.success) { await ix.ops.void(h.id); onSound?.('rejected', false); toast.error(`Order failed: ${j?.error ?? 'no reply'}`); return false; }
      }
      paperFill([side === 'BUY' ? lotsN : -lotsN]);
      await ix.ops.confirm(h.id);
      onSound?.('placed', !adding);
      toast.success(`[PAPER] ${what}`);
      mappedMarkers(h.dir, adding, lotsN, { target: h.traded, action: side, paperPx: px! });
      return true;
    }
    const j = await sendReserved(h.id, what, !adding, () => (adding
      ? post({ action: side, lots: lotsN, product: h.product })
      : post({ exitOwn: { side, units: [units], product: h.product } })));
    if (!j) return false;
    mappedMarkers(h.dir, adding, lotsN || 1, { target: h.traded, action: side, legs: j.legs });
    return true;
  };

  /** Buy / Sell on a mapped index chart. Flat: open that side's leg. Holding the same side: add lots to the held contract. Holding the
   *  other side: reduce it (the whole leg once the lots cover it) - never flip into the other side's leg (that is Reverse). */
  const mappedOrder = async (chartAction: PnfAction): Promise<boolean> => {
    const dir = dirOf(chartAction);
    if (!held) return enterMapped(dir, lots);
    if (held.state !== 'open') { toast.error('The last order on this chart is not settled - settle it on the bar first'); return false; }
    if (!(heldPerLot > 0)) { toast.error('The held option\'s lot size is not known yet - nothing was sent'); return false; }
    if (held.dir === dir) return changeHeld(lots * heldPerLot);
    return changeHeld(-Math.min(lots * heldPerLot, held.units));
  };
  const mappedClose = async (): Promise<boolean> => {
    if (!held || held.state !== 'open' || !(held.units > 0)) return false;
    return changeHeld(-held.units);
  };

  // PAPER: the paper book IS this chart's own position - flat there means flat, forgotten at once.
  // REAL: the broker nets every page's and strategy's quantity of a strike into one row, so a net below this chart's own units does not
  // prove the leg is gone (another page may be short the same strike). Never forgotten silently: after 30 s past the row's last change
  // (a fill's lag) the bar says what the broker shows and offers Forget. A timer, so it appears even when nothing else re-renders.
  const heldId = held?.state === 'open' ? held.id : null;
  const heldT = held?.t ?? 0;
  const paperFlat = mode === 'PAPER' && paperLegs.length > 0 && paperLegs.every(l => l.lots === 0);
  const clearRef = useRef(index?.ops.clear);
  useEffect(() => { clearRef.current = index?.ops.clear; });
  useEffect(() => {
    if (heldId && paperFlat) void clearRef.current?.(heldId);
  }, [heldId, paperFlat]);
  const brokerHeldLots = held && brokerLots.length ? brokerLots[0] * (held.action === 'BUY' ? 1 : -1) : null;
  const brokerShort = mode === 'REAL' && !!heldId && ownLots > 0 && brokerHeldLots !== null && brokerHeldLots < ownLots - 1e-9;
  const [shortShown, setShortShown] = useState<string | null>(null);
  useEffect(() => {
    if (!brokerShort || !heldId) return;
    const waitMs = Math.max(0, (heldT + 30) * 1000 - Date.now());
    const id = setTimeout(() => setShortShown(heldId), waitMs);
    return () => clearTimeout(id);
  }, [brokerShort, heldId, heldT]);
  const fmtLots = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(2)}L`;
  /** The broker shows less of the held option than this chart opened (for 30 s+): what it shows, for the Forget prompt. */
  const heldMismatch = brokerShort && shortShown === heldId && brokerHeldLots !== null
    ? `${BROKER_LABELS[broker]} shows ${fmtLots(Math.max(0, brokerHeldLots))} ${held!.action === 'BUY' ? 'long' : 'short'} on this option (all pages and products); this chart opened ${fmtLots(ownLots)}`
    : null;
  /** Forget the held option (the user checked Positions: it is gone). Nothing is sent. */
  const forgetHeld = () => { if (heldId) void index?.ops.clear(heldId); };

  const executeOrder = (action: PnfAction) => {
    if (mapped) return mappedReady ? exclusive(() => mappedOrder(action)) : Promise.resolve(false);
    return isIndex || !ready ? Promise.resolve(false) : exclusive(() => sendOrder(action));
  };
  const executeSquareOff = () => exclusive(mapped ? mappedClose : sendSquareOff);
  /** Flip the position: close it (server-sized from the book), then open the same size the other way. The entry goes only
   *  after a confirmed close, so an unclear close never becomes a doubled position. */
  const executeReverse = () => exclusive(async () => {
    if (mapped) {
      // close the held leg (own units), then open the OTHER side's leg (its own option, resolved now) with the same lots - only once the
      // close went through AND the ledger booked it (mappedClose is false otherwise)
      if (!held || held.state !== 'open' || !ready || !(ownLots > 0)) return false;
      const n = Math.min(cap, Math.floor(ownLots)), dir = held.dir;
      if (!(n >= 1)) { toast.error('The held position is under one lot - Close it, then open the other side'); return false; }
      // a close sends every held unit, but the re-entry is whole lots: a partial lot would silently shrink the position, so it is refused up front
      if (Math.abs(ownLots - n) > 1e-6 || n > cap) { toast.error(`The held position is ${fmtLots(ownLots)} (not whole lots, or above the ${cap}-lot cap) - Close it, then open the other side`); return false; }
      if (!(await mappedClose())) return false;
      return enterMapped(otherDir(dir), n);
    }
    if (!ready || !position || position.side === 'MIXED') return false;
    const size = Math.min(cap, Math.max(...positionLots.map(Math.abs)));
    const action: PnfAction = position.side === 'LONG' ? 'SELL' : 'BUY';
    if (!(size > 0) || !(await sendSquareOff())) return false;
    return sendOrder(action, size, true);
  });

  return {
    /** No trading on this chart: an index without a map (a mapped index chart trades, flat or not). */
    isIndex: isIndex && !mapped,
    mapped, held, ownLots, heldMismatch, forgetHeld,
    /** A failed held-ledger read (trading goes on with the last read; said on the bar). */
    heldWarning: mapped ? index.heldError : null,
    /** What Close / Square off does on THIS chart (a mapped index chart closes only its own units), for the buttons' titles. */
    closeTitle: mapped && held
      ? `Closes the ${fmtLots(ownLots)} this chart opened of ${targetLabel(held.traded)} (${held.product === 'MARGIN' ? 'NRML' : 'MIS'} only)${mode === 'REAL' ? ` - any other page's or product's quantity on ${BROKER_LABELS[broker]} stays open` : ''}`
      : null, isEquity, isStraddle, cap, lots, lotsDraft, setLotsDraft, commitLots, pickLots, product, setProduct,
    busy, ready: mapped ? mappedReady : ready, unsupported, position, positionLots, shownPnl, paperAvg, realError, prices,
    /** Units (shares / barrels / contracts) per lot of the first leg, for a "= 20 bbl" hint; null until the lookup answers. */
    unitsPerLot: unitsPerLot.length ? unitsPerLot[0] : null,
    executeOrder, executeSquareOff, executeReverse,
  };
}
