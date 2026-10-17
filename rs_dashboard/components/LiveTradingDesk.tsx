'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, Layers, ListOrdered, Receipt, Loader2, Ban, Pencil, Check, XCircle } from 'lucide-react';
import { scaleBrokerPnl, contractMultiplier } from '@/lib/positionPnl';
import { buildPositionLegs, type PositionLeg } from '@/lib/positionLegs';
import { aggregateLegs, classifyStructure } from '@/lib/positionStructure';
import type { ScalperPosition } from '@/lib/zerodhaShape';
import { scalperRoute, BROKER_LABELS } from '@/hooks/useBrokerSelector';
import { withKotakContracts, kotakOpenUnderlyings, kotakUnderlyingOf, type KotakSymbolMap } from '@/lib/kotakPositionContracts';
import { UNKNOWN_ORDER_HINT } from '@/lib/orderOutcome';
import { sendSingleLegOrder } from '@/lib/optionsMonitorOrders';
import {
  type LedgerBasket,
  type LedgerBroker,
  type BrokerPositionRow,
  basketBroker,
  legIdent,
  rowIdent,
  normProduct,
  priceRowsFromChain,
  rowPnlUnknown,
  findBrokerRow,
  legUnrealizedPnl,
  legEntryPrice,
  legEntryIsOwn,
  stampOwnEntries,
  allocateLiveQty,
  ledgerLegKey,
  reconcileBasket,
  basketIsFlat,
} from '@/lib/liveChartsLedger';

const POSITIONS_POLL_MS = 3000;
const ORDERS_POLL_MS = 3000;
const TRADES_POLL_MS = 5000;

const TERMINAL_ORDER_STATUSES = new Set(['COMPLETE', 'TRADED', 'REJECTED', 'CANCELLED', 'CANCELED', 'EXPIRED']);
const TRADE_ROW_LIMIT = 100;

interface OrderRow {
  orderId: string;
  securityId: string;
  tradingSymbol: string;
  orderStatus: string;
  transactionType: string;
  quantity: number;
  price: number;
  orderType: string;
  createTime: string;
}

interface TradeRow {
  securityId: string;
  tradingSymbol: string;
  transactionType: string;
  tradedQuantity: number;
  tradedPrice: number;
  createTime: string;
}

function fmtRupee(n: number): string {
  const sign = n < 0 ? '-' : '';
  return `${sign}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function fmtPrice(n: number): string {
  return n > 0 ? n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—';
}

type DeskTab = 'positions' | 'orders' | 'trades';

/** How long further exits on a leg wait after an exit whose outcome is UNKNOWN (it may have filled). */
const UNKNOWN_EXIT_HOLD_MS = 60_000;
/** Kotak legs are priced from Dhan's option chain (a ~30 s server snapshot) — see priceRowsFromChain. */
const KOTAK_CHAIN_POLL_MS = 5_000;

interface LiveTradingDeskProps {
  /** The account this desk reads and trades: positions, orders, trades and exits all follow it. Its baskets are the
   *  ones placed on it (the page locks its picker while a basket is open). */
  broker: LedgerBroker;
  /** False until the page knows its broker (usePageBroker's first render is always Dhan): no account is read before. */
  ready?: boolean;
  baskets: LedgerBasket[];
  onBasketsChange: (baskets: LedgerBasket[]) => void;
  open: boolean;
  onToggle: () => void;
}

/** Docked right-side trading desk for the Live Options Charts page - positions, order book and
 * trade book as tabs, with the running unrealized P&L always visible in the header. Collapses to
 * a slim always-present rail (rather than only appearing after a trade, like the previous
 * bottom-right overlay) so the desk is reachable before a basket exists too. */
export default function LiveTradingDesk({ broker, ready = true, baskets, onBasketsChange, open, onToggle }: LiveTradingDeskProps) {
  const [tab, setTab] = useState<DeskTab>('positions');
  const [positions, setPositions] = useState<BrokerPositionRow[]>([]);
  // Another account's book must never be shown (or sized off) as this one's: dropped the moment the broker changes
  // (adjusted during render; the positions poll restarts on `broker`).
  const [positionsFor, setPositionsFor] = useState(broker);
  if (positionsFor !== broker) { setPositionsFor(broker); setPositions([]); }
  const [orders, setOrders] = useState<OrderRow[]>([]);
  const [trades, setTrades] = useState<TradeRow[]>([]);
  const [exitingLegKey, setExitingLegKey] = useState<string | null>(null);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);
  const [draftPrice, setDraftPrice] = useState('');
  const [draftQty, setDraftQty] = useState('');
  const [cancelConfirmId, setCancelConfirmId] = useState<string | null>(null);
  // A refused / UNKNOWN exit or order action used to fail silently here; it is said in one line at the top.
  const [notice, setNotice] = useState<{ tone: 'error' | 'warn'; text: string } | null>(null);
  // Leg key -> when its last exit came back UNKNOWN (see UNKNOWN_EXIT_HOLD_MS).
  const exitUnknownRef = useRef<Map<string, number>>(new Map());
  const basketsRef = useRef(baskets);
  useEffect(() => {
    basketsRef.current = baskets;
  }, [baskets]);

  // The desk is now always mounted (so the collapsed rail can show live P&L), so collapsing it
  // no longer unmounts - and therefore no longer resets - any in-progress edit. Without this, a
  // draft price typed into an order's Edit row, or a pending cancel confirmation, survives a
  // collapse/reopen and can be submitted later against a stale value the user never re-checked.
  useEffect(() => {
    if (!open) {
      setEditingOrderId(null);
      setCancelConfirmId(null);
      setExitingLegKey(null);
    }
  }, [open]);

  // Every security ID the broker currently reports a non-zero position for - lets the Orders
  // and Trades polls below stay scoped to "things this book actually has exposure to" (not
  // every unrelated Scalper/strategy order in the account) without being limited to only what
  // this page's own in-memory ledger happens to know about, same reasoning as the Positions tab.
  const bookSecIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    bookSecIdsRef.current = new Set(
      positions
        .filter((r) => Number(r.netQty ?? r.net_qty ?? 0) !== 0)
        .map((r) => rowIdent(r, broker)),
    );
  }, [positions, broker]);

  /** Contracts the order / trade books are filtered to: this broker's own baskets' legs plus everything in its book. */
  function trackedIdents(): Set<string> {
    return new Set([
      ...basketsRef.current.filter((b) => basketBroker(b) === broker).flatMap((b) => b.legs.map((l) => legIdent(l, broker))),
      ...bookSecIdsRef.current,
    ].filter(Boolean));
  }

  /** The reply of /api/options/order for one leg: placed, rejected, or UNKNOWN (may be live) — on this desk's broker. */
  function sendExit(leg: { ident: string; exchange: string }, qty: number, side: 'BUY' | 'SELL', productType: string) {
    return sendSingleLegOrder(broker, leg, qty, side, productType);
  }

  /** A leg whose last exit came back UNKNOWN within the hold: refuse (and say why) instead of sending a second close. */
  function exitHeld(key: string, label: string): boolean {
    const at = exitUnknownRef.current.get(key);
    if (at == null || Date.now() - at >= UNKNOWN_EXIT_HOLD_MS) return false;
    setNotice({ tone: 'warn', text: `${label}: the previous exit's status is UNKNOWN — not sending another for ${Math.ceil((UNKNOWN_EXIT_HOLD_MS - (Date.now() - at)) / 1000)} s. ${UNKNOWN_ORDER_HINT}` });
    return true;
  }

  // Positions poll - clamps every ledger leg's qty down to what the broker actually still
  // shows (never up, per dhan-terminal-position-ownership). Deliberately raw (not the shared
  // brokerPositionsCache) because the Exit button below sizes real orders off this same read.
  const seqRef = useRef(0);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    async function poll() {
      const seq = ++seqRef.current;
      try {
        const res = await fetch(scalperRoute(broker, 'positions'));
        const json = await res.json();
        if (cancelled || seq !== seqRef.current) return;
        if (json.success && Array.isArray(json.data)) {
          const scaled = (json.data as BrokerPositionRow[]).map((row) => scaleBrokerPnl(row, contractMultiplier(row)));
          setPositions(scaled);
          const current = basketsRef.current;
          if (current.length > 0) {
            const reconciled = current.map((b) => reconcileBasket(b, scaled, Date.now(), broker));
            const changed = reconciled.some((b, i) => JSON.stringify(b) !== JSON.stringify(current[i]));
            if (changed) onBasketsChange(reconciled);
          }
        }
      } catch {
        // Transient network/broker error - leave positions/ledger as last known.
      }
    }
    poll();
    const id = setInterval(poll, POSITIONS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [broker, ready]);

  // Order book poll - filters down to orders for security IDs this page's own baskets track,
  // so the panel doesn't show unrelated orders from Scalper/strategies/manual trades. Gated on
  // `open`: the desk is now always mounted (so the collapsed rail can show live P&L off the
  // Positions poll above), but the Orders tab has nothing to show while collapsed, so polling it
  // in the background would just be extra load against Dhan's shared rate limit for no visible
  // benefit - see dhan-polling-guards.
  useEffect(() => {
    if (!open || !ready) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(scalperRoute(broker, 'orders'));
        const json = await res.json();
        if (cancelled) return;
        if (json.success && Array.isArray(json.data)) {
          const trackedSecIds = trackedIdents();
          const rows: OrderRow[] = (json.data as Record<string, unknown>[])
            .filter((o) => trackedSecIds.has(rowIdent(o, broker)))
            .map((o) => ({
              orderId: String(o.orderId ?? ''),
              securityId: rowIdent(o, broker),
              tradingSymbol: String(o.tradingSymbol ?? ''),
              orderStatus: String(o.orderStatus ?? ''),
              transactionType: String(o.transactionType ?? ''),
              quantity: Number(o.quantity ?? 0),
              price: Number(o.price ?? 0),
              orderType: String(o.orderType ?? ''),
              createTime: String(o.createTime ?? ''),
            }));
          setOrders(rows);
        }
      } catch {
        // Transient error - keep showing the last known order book.
      }
    }
    poll();
    const id = setInterval(poll, ORDERS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, broker, ready]);

  // Trade book poll - same tracked-security-id filter as the order book, so a manual/strategy
  // fill on an unrelated contract never shows up here. Gated on `open`, same reasoning as the
  // Orders poll above.
  useEffect(() => {
    if (!open || !ready) return;
    let cancelled = false;
    async function poll() {
      try {
        const res = await fetch(scalperRoute(broker, 'trades'));
        const json = await res.json();
        if (cancelled) return;
        if (json.success && Array.isArray(json.data)) {
          const trackedSecIds = trackedIdents();
          const relevant = (json.data as Record<string, unknown>[])
            .filter((t) => trackedSecIds.has(rowIdent(t, broker)));
          // Each ledger leg's own entry price from its own orders' fills — the
          // positions row's average is pooled across every basket on the contract.
          const stamped = stampOwnEntries(basketsRef.current, relevant.map((t) => ({
            orderId: String(t.orderId ?? ''),
            securityId: String(t.securityId ?? ''),
            tradingSymbol: String(t.tradingSymbol ?? ''),
            tradedQuantity: Number(t.tradedQuantity ?? 0),
            tradedPrice: Number(t.tradedPrice ?? 0),
          })), broker);
          if (stamped !== basketsRef.current) onBasketsChange(stamped);
          const rows: TradeRow[] = relevant
            .map((t) => ({
              securityId: rowIdent(t, broker),
              tradingSymbol: String(t.tradingSymbol ?? ''),
              transactionType: String(t.transactionType ?? ''),
              tradedQuantity: Number(t.tradedQuantity ?? 0),
              tradedPrice: Number(t.tradedPrice ?? 0),
              createTime: String(t.createTime ?? t.exchangeTime ?? ''),
            }))
            .sort((a, b) => (a.createTime < b.createTime ? 1 : -1))
            .slice(0, TRADE_ROW_LIMIT);
          setTrades(rows);
        }
      } catch {
        // Transient error - keep showing the last known trade book.
      }
    }
    poll();
    const id = setInterval(poll, TRADES_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, broker, ready]);

  // Kotak only: contracts for its symbol-only rows (the instrument cache, per underlying) and Dhan chain quotes to
  // price them — Kotak's payload has no price (see priceRowsFromChain). Dhan rows carry their own P&L.
  const [kotakSymbols, setKotakSymbols] = useState<KotakSymbolMap>({});
  const [chainQuotes, setChainQuotes] = useState<Record<string, Record<string, { ce?: number; pe?: number }>>>({});
  const kotakUnderlyingsKey = broker === 'kotak' ? kotakOpenUnderlyings(positions as { tradingSymbol?: unknown; netQty?: unknown }[]).join(',') : '';
  useEffect(() => {
    if (!kotakUnderlyingsKey) return;
    let cancelled = false;
    for (const u of kotakUnderlyingsKey.split(',')) {
      fetch(`/api/scalper/kotak/symbol-lookup?underlying=${encodeURIComponent(u)}`)
        .then((r) => r.json())
        .then((j: { success?: boolean; data?: KotakSymbolMap }) => {
          if (!cancelled && j.success && j.data) setKotakSymbols((prev) => ({ ...prev, ...j.data }));
        })
        .catch(() => { /* unpriced: shown as — */ });
    }
    return () => { cancelled = true; };
  }, [kotakUnderlyingsKey]);
  const contractRows = useMemo(
    () => (broker === 'kotak' ? withKotakContracts(positions, kotakSymbols) : positions),
    [broker, positions, kotakSymbols],
  );
  const chainKeys = useMemo(() => {
    if (broker !== 'kotak') return '';
    const keys = new Set<string>();
    for (const r of contractRows) {
      if (!Number(r.netQty)) continue;
      const u = kotakUnderlyingOf(String(r.tradingSymbol ?? ''));
      if (u && r.drvExpiryDate) keys.add(`${u}|${r.drvExpiryDate}`);
    }
    return [...keys].sort().join(',');
  }, [broker, contractRows]);
  useEffect(() => {
    if (!chainKeys) return;
    let cancelled = false;
    const load = () => {
      for (const key of chainKeys.split(',')) {
        const [u, exp] = key.split('|');
        fetch(`/api/options/chain?underlying=${encodeURIComponent(u)}&expiry=${encodeURIComponent(exp)}`)
          .then((r) => r.json())
          .then((j: { data?: { chain?: { oc?: Record<string, { ce?: { last_price?: number }; pe?: { last_price?: number } }> } } }) => {
            const oc = j?.data?.chain?.oc;
            if (cancelled || !oc) return;
            const byStrike: Record<string, { ce?: number; pe?: number }> = {};
            for (const [k, v] of Object.entries(oc)) byStrike[String(Number(k))] = { ce: v?.ce?.last_price, pe: v?.pe?.last_price };
            setChainQuotes((prev) => ({ ...prev, [key]: byStrike }));
          })
          .catch(() => { /* keep the last quotes */ });
      }
    };
    load();
    const id = setInterval(load, KOTAK_CHAIN_POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [chainKeys]);
  // What every P&L figure below reads: Dhan's rows as they are, Kotak's priced from the chain (an estimate).
  const pricedPositions = useMemo(
    () => (broker === 'kotak'
      ? priceRowsFromChain(contractRows, (u, exp, k, opt) => {
          const q = chainQuotes[`${u}|${exp}`]?.[String(k)];
          const v = opt === 'CE' ? q?.ce : q?.pe;
          return v != null && v > 0 ? v : null;
        }, kotakUnderlyingOf)
      : positions),
    [broker, contractRows, chainQuotes, positions],
  );





  const handleExitLeg = useCallback(
    async (basket: LedgerBasket, legIdx: number) => {
      const leg = basket.legs[legIdx];
      const key = `${basket.id}:${legIdx}`;
      const label = `${leg.action} ${leg.strike} ${leg.optionType}`;
      if (basketBroker(basket) !== broker) {
        setNotice({ tone: 'error', text: `${label} was placed on ${BROKER_LABELS[basketBroker(basket)]}; this desk is on ${BROKER_LABELS[broker]}. Exit it from that account.` });
        return;
      }
      if (exitHeld(key, label)) return;
      setExitingLegKey(key);
      try {
        // Fetch live positions right here rather than trusting the background poll's
        // `positions` state (up to POSITIONS_POLL_MS stale) - the same reasoning as
        // Scalper.tsx's closePosition ("avoids acting on stale data"). Sizing an exit off
        // a stale snapshot that's since shrunk would place too large an order and flip the
        // leg to the opposite side instead of just closing it, since these are plain orders
        // with no reduce-only flag.
        let freshRows: BrokerPositionRow[] | null = null;
        try {
          const posRes = await fetch(scalperRoute(broker, 'positions'));
          const posJson = await posRes.json();
          if (posJson.success && Array.isArray(posJson.data)) {
            freshRows = (posJson.data as BrokerPositionRow[]).map((r) => scaleBrokerPnl(r, contractMultiplier(r)));
          }
        } catch {
          // Fall back to the last polled snapshot below rather than refusing to exit outright.
        }
        // This leg's share of the contract's position — shared out across every
        // basket on it, so two baskets can't each exit the whole position.
        const exitQty = allocateLiveQty(basketsRef.current, freshRows ?? positions, broker).get(ledgerLegKey(basket.id, legIdx)) ?? 0;
        if (exitQty <= 0) {
          setNotice({ tone: 'warn', text: `${label}: ${BROKER_LABELS[broker]} shows nothing of this leg open — nothing sent.` });
          return;
        }

        const out = await sendExit({ ident: legIdent(leg, broker), exchange: leg.exchangeSegment }, exitQty, leg.action === 'BUY' ? 'SELL' : 'BUY', leg.productType);
        if (out.kind === 'unknown') {
          exitUnknownRef.current.set(key, Date.now());
          setNotice({ tone: 'warn', text: `${label}: exit status UNKNOWN (${out.error}). The leg stays open here; no further exit on it for a minute. ${UNKNOWN_ORDER_HINT}` });
          return;
        }
        if (out.kind === 'rejected') {
          setNotice({ tone: 'error', text: `${label}: exit rejected — ${out.error}` });
          return;
        }
        exitUnknownRef.current.delete(key);
        const orderId = out.orderId;
        {
          const updated = basketsRef.current.map((b) => {
            if (b.id !== basket.id) return b;
            return {
              ...b,
              legs: b.legs.map((l, i) =>
                i === legIdx
                  ? {
                      ...l,
                      qty: Math.max(0, l.qty - exitQty),
                      exitOrderIds: [...l.exitOrderIds, String(orderId)],
                      lastOrderAt: Date.now(),
                    }
                  : l
              ),
            };
          });
          onBasketsChange(updated);
        }
      } finally {
        setExitingLegKey(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positions, onBasketsChange, broker]
  );

  const handleExitBasket = useCallback(
    async (basket: LedgerBasket) => {
      for (let i = 0; i < basket.legs.length; i++) {
        if (basket.legs[i].qty > 0) {
          await handleExitLeg(basket, i);
        }
      }
    },
    [handleExitLeg]
  );

  // Closes a leg that shows up in the broker's own position book but isn't in this page's
  // ledger (opened in an earlier session, another tab, or before this page ever loaded) - sizes
  // directly off the broker's live netQty rather than a ledger quantity, the same way
  // Scalper/AdvancedScalper close a position: there is no "ownership" question here, the leg
  // isn't split across multiple rows/instances, so the full displayed quantity IS what should
  // close.
  const handleExitBrokerLeg = useCallback(
    async (leg: PositionLeg) => {
      const ident = broker === 'kotak' ? leg.display.tradingSymbol : String(leg.securityId ?? '');
      const key = `book:${ident}:${leg.display.productType}`;
      const label = `${leg.side} ${leg.strike} ${leg.type}`;
      if (exitHeld(key, label)) return;
      setExitingLegKey(key);
      try {
        const matchesLeg = (row: BrokerPositionRow) =>
          rowIdent(row, broker) === ident &&
          normProduct(row.productType ?? row.product) === normProduct(leg.display.productType);

        let freshRow: BrokerPositionRow | null = null;
        try {
          const posRes = await fetch(scalperRoute(broker, 'positions'));
          const posJson = await posRes.json();
          if (posJson.success && Array.isArray(posJson.data)) {
            freshRow = (posJson.data as BrokerPositionRow[]).find(matchesLeg) ?? null;
          }
        } catch {
          // Fall back to the last polled snapshot below rather than refusing to exit outright.
        }
        const row = freshRow ?? positions.find(matchesLeg) ?? null;
        const netQty = Number(row?.netQty ?? 0);
        if (!row || !Number.isFinite(netQty) || netQty === 0) return;

        const exitQty = Math.abs(netQty);
        const side: 'BUY' | 'SELL' = netQty > 0 ? 'SELL' : 'BUY';
        const exchangeSegment = String(row.exchangeSegment ?? row.exchange ?? (broker === 'kotak' ? 'nse_fo' : 'NSE_FNO'));

        const out = await sendExit({ ident, exchange: exchangeSegment }, exitQty, side, leg.display.productType);
        // No ledger to update - the positions poll picks up the closed/reduced quantity on its own next tick.
        if (out.kind === 'unknown') {
          exitUnknownRef.current.set(key, Date.now());
          setNotice({ tone: 'warn', text: `${label}: exit status UNKNOWN (${out.error}). No further exit on it for a minute. ${UNKNOWN_ORDER_HINT}` });
        } else if (out.kind === 'rejected') {
          setNotice({ tone: 'error', text: `${label}: exit rejected — ${out.error}` });
        } else {
          exitUnknownRef.current.delete(key);
        }
      } finally {
        setExitingLegKey(null);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [positions, broker]
  );

  const handleExitBrokerGroup = useCallback(
    async (legs: PositionLeg[]) => {
      for (const leg of legs) {
        await handleExitBrokerLeg(leg);
      }
    },
    [handleExitBrokerLeg]
  );

  const handleCancelOrder = useCallback(async (orderId: string) => {
    setCancelConfirmId(null);
    try {
      await fetch('/api/scalper/orders', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ orderId, broker }),
      });
    } catch {
      // Order book poll will reflect the real state on its next tick regardless.
    }
  }, [broker]);

  const startEditOrder = (row: OrderRow) => {
    setEditingOrderId(row.orderId);
    setDraftPrice(String(row.price));
    setDraftQty(String(row.quantity));
  };

  const saveEditOrder = async (row: OrderRow) => {
    const price = parseFloat(draftPrice);
    const qty = parseInt(draftQty, 10);
    if (!(price > 0) || !(qty > 0)) return;
    try {
      await fetch('/api/scalper/orders', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          orderId: row.orderId,
          price,
          quantity: qty,
          orderType: row.orderType,
          broker,
        }),
      });
    } finally {
      setEditingOrderId(null);
    }
  };

  const activeBaskets = baskets.filter((b) => !basketIsFlat(b));
  const liveOrders = orders.filter((o) => !TERMINAL_ORDER_STATUSES.has(o.orderStatus.toUpperCase()));

  // Every open option leg the broker currently reports, parsed via the same strike/type/expiry
  // resolver PositionsAnalysis uses (drv* fields first, so it never depends on this page's own
  // ledger). This is what makes Positions a complete book rather than only what this page's own
  // session happened to trade - a position opened before this page loaded, in another tab, or in
  // an earlier session is otherwise invisible to the in-memory ledger.
  const bookLegs = useMemo(
    // Kotak rows go in with their contract (drv fields) and chain-priced P&L; Dhan's as they are. Kotak rows are not
    // passed as `raw`: that flag means "a genuine Dhan row" (trust its own unrealizedProfit).
    () => buildPositionLegs(pricedPositions as unknown as ScalperPosition[], broker === 'dhan' ? { raw: positions } : {}).legs,
    [pricedPositions, positions, broker],
  );

  // Legs already covered by an active ledger basket keep the nicer "Basket" / "Exit All"
  // grouped rendering below; every other live leg is rendered from the broker book directly.
  const ledgerSecIds = useMemo(
    () => new Set(activeBaskets.filter((b) => basketBroker(b) === broker).flatMap((b) => b.legs.filter((l) => l.qty > 0).map((l) => legIdent(l, broker)))),
    [activeBaskets, broker],
  );
  const bookIdent = useCallback((leg: PositionLeg) => (broker === 'kotak' ? leg.display.tradingSymbol : String(leg.securityId ?? '')), [broker]);
  const unledgeredLegs = useMemo(
    () => bookLegs.filter((leg) => !bookIdent(leg) || !ledgerSecIds.has(bookIdent(leg))),
    [bookLegs, ledgerSecIds, bookIdent],
  );
  // A book leg's P&L could not be priced (Kotak row with no chain quote): shown as —, and the total says so.
  const bookLegUnpriced = useCallback(
    (leg: PositionLeg) => broker === 'kotak' && rowPnlUnknown(pricedPositions.find((r) => rowIdent(r, broker) === bookIdent(leg)
      && normProduct(r.productType ?? r.product) === normProduct(leg.display.productType)) ?? null),
    [broker, pricedPositions, bookIdent],
  );
  // Grouped by (underlying, expiry, product) only - NOT by strike, so a multi-strike structure
  // (strangle, spread, condor) groups as one row instead of each leg showing up separately as a
  // mislabeled "naked" leg. Labeled via the same aggregateLegs()+classifyStructure() pair
  // Multi-Leg Focus's findUntrackedGroups() uses for exactly this "orphan broker leg -> readable
  // structure name" problem, rather than a narrower hand-rolled straddle-only check.
  const unledgeredGroups = useMemo(() => {
    const groups = new Map<string, PositionLeg[]>();
    for (const leg of unledgeredLegs) {
      const underlying = leg.display.tradingSymbol.split('-')[0] || leg.display.tradingSymbol;
      const key = `${underlying}|${leg.expiry ?? ''}|${leg.display.productType}`;
      const arr = groups.get(key);
      if (arr) arr.push(leg);
      else groups.set(key, [leg]);
    }
    return [...groups.entries()]
      .map(([key, legs]) => {
        const underlying = legs[0].display.tradingSymbol.split('-')[0] || legs[0].display.tradingSymbol;
        const { structure } = classifyStructure(aggregateLegs(legs));
        const strikes = [...new Set(legs.map((l) => l.strike))].sort((a, b) => a - b);
        const strikeLabel = strikes.length === 1 ? String(strikes[0]) : `${strikes[0]}-${strikes[strikes.length - 1]}`;
        return { key, title: `${underlying} ${strikeLabel} ${structure}`, legs };
      })
      .sort((a, b) => a.title.localeCompare(b.title));
  }, [unledgeredLegs]);

  const allocated = allocateLiveQty(baskets, pricedPositions, broker);
  let totalPnl = 0;
  let totalUnpriced = false;
  for (const basket of activeBaskets) {
    basket.legs.forEach((leg, legIdx) => {
      if (leg.qty <= 0) return;
      const row = findBrokerRow(pricedPositions, leg, broker);
      if (rowPnlUnknown(row)) totalUnpriced = true;
      totalPnl += legUnrealizedPnl(row, allocated.get(ledgerLegKey(basket.id, legIdx)) ?? 0);
    });
  }
  for (const leg of unledgeredLegs) {
    if (bookLegUnpriced(leg)) totalUnpriced = true;
    else totalPnl += leg.display.unrealizedProfit;
  }
  // Kotak P&L is an estimate off Dhan's chain snapshot; an unpriced leg makes the total unknown, never a partial sum.
  const pnlText = totalUnpriced ? '—' : `${fmtRupee(totalPnl)}${broker === 'kotak' ? ' est.' : ''}`;
  const pnlTitle = broker === 'kotak'
    ? (totalUnpriced ? 'A Kotak leg has no price yet (Kotak sends none; it is priced from Dhan\'s chain)' : 'Estimated from Dhan\'s option chain (a snapshot up to ~30 s old) — Kotak sends no price')
    : 'Unrealized P&L';

  const hasAnyPosition = activeBaskets.length > 0 || unledgeredGroups.length > 0;
  const pnlChip = hasAnyPosition && (
    <span className={`ltd-pnl-chip ${totalPnl >= 0 ? 'ltd-pnl-pos' : 'ltd-pnl-neg'}`} title={pnlTitle}>{pnlText}</span>
  );

  if (!open) {
    return (
      <button type="button" onClick={onToggle} className="ltd-rail" title="Show trading desk">
        <Layers className="h-4 w-4" />
        <span className="ltd-rail-label">TRADE</span>
        {hasAnyPosition && (
          <span className={`ltd-rail-pnl ${totalPnl >= 0 ? 'ltd-pnl-pos' : 'ltd-pnl-neg'}`} title={pnlTitle}>{pnlText}</span>
        )}
        <style>{`
          .ltd-rail {
            flex-shrink: 0;
            width: 40px;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: flex-start;
            gap: 10px;
            padding: 14px 0;
            background: rgba(10, 14, 26, 0.95);
            border-left: 1px solid rgba(99, 102, 241, 0.15);
            color: #a5b4fc;
            cursor: pointer;
          }
          :root:not(.dark) .ltd-rail { background: #ffffff; border-left-color: #e2e8f0; color: #4338ca; }
          .ltd-rail:hover { background: rgba(99, 102, 241, 0.1); }
          .ltd-rail-label {
            writing-mode: vertical-rl;
            transform: rotate(180deg);
            font-size: 10px;
            font-weight: 700;
            letter-spacing: 0.12em;
          }
          .ltd-rail-pnl {
            writing-mode: vertical-rl;
            transform: rotate(180deg);
            font-size: 10px;
            font-weight: 700;
            font-family: monospace;
            padding: 4px 3px;
            border-radius: 6px;
          }
          .ltd-pnl-pos { background: rgba(16,185,129,0.15); color: #34d399; }
          .ltd-pnl-neg { background: rgba(244,63,94,0.15); color: #fb7185; }
        `}</style>
      </button>
    );
  }

  return (
    <div className="ltd-dock">
      <div className="ltd-header">
        <div className="flex items-center gap-2 min-w-0">
          <Layers className="h-3.5 w-3.5 text-sky-400 flex-shrink-0" />
          <span className="ltd-title">Trading Desk</span>
          {pnlChip}
        </div>
        <button type="button" onClick={onToggle} className="ltd-close-btn" title="Collapse trading desk">
          <ChevronRight className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="ltd-tabs">
        <button type="button" onClick={() => setTab('positions')} className={`ltd-tab${tab === 'positions' ? ' ltd-tab--active' : ''}`}>
          <Layers className="h-3 w-3" />
          Positions
          {hasAnyPosition && <span className="ltd-count">{activeBaskets.length + unledgeredGroups.length}</span>}
        </button>
        <button type="button" onClick={() => setTab('orders')} className={`ltd-tab${tab === 'orders' ? ' ltd-tab--active' : ''}`}>
          <ListOrdered className="h-3 w-3" />
          Orders
          {liveOrders.length > 0 && <span className="ltd-count">{liveOrders.length}</span>}
        </button>
        <button type="button" onClick={() => setTab('trades')} className={`ltd-tab${tab === 'trades' ? ' ltd-tab--active' : ''}`}>
          <Receipt className="h-3 w-3" />
          Trades
          {trades.length > 0 && <span className="ltd-count">{trades.length}</span>}
        </button>
      </div>

      {notice && (
        <div role="alert" className={`ltd-notice ltd-notice--${notice.tone}`}>
          <span>{notice.text}</span>
          <button type="button" onClick={() => setNotice(null)} aria-label="Dismiss" className="ltd-notice-x">×</button>
        </div>
      )}
      {broker === 'kotak' && (
        <div className="ltd-broker-note" title="Orders, positions and exits on this desk go to Kotak. Prices still come from Dhan.">
          {BROKER_LABELS.kotak} account · P&amp;L estimated from Dhan&apos;s chain
        </div>
      )}

      <div className="ltd-body">
        {tab === 'positions' && (
          !hasAnyPosition ? (
            <div className="ltd-empty">No open option positions right now — use Trade / Trade ATM on a panel.</div>
          ) : (
            <div className="ltd-table-wrap">
              <table className="ltd-table">
                <thead>
                  <tr>
                    <th>Basket</th>
                    <th>Leg</th>
                    <th className="text-right">Entry</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">P&amp;L</th>
                    <th className="text-right">Action</th>
                  </tr>
                </thead>
                <tbody>
                  {activeBaskets.map((basket) => {
                    const liveLegs = basket.legs.filter((l) => l.qty > 0);
                    return liveLegs.map((leg, i) => {
                      const legIdx = basket.legs.indexOf(leg);
                      const row = findBrokerRow(pricedPositions, leg, broker);
                      const ownQty = allocated.get(ledgerLegKey(basket.id, legIdx)) ?? 0;
                      const pnl = legUnrealizedPnl(row, ownQty);
                      const unpriced = rowPnlUnknown(row);
                      const key = `${basket.id}:${legIdx}`;
                      const isExiting = exitingLegKey === key;
                      return (
                        <tr key={key}>
                          {i === 0 && (
                            <td rowSpan={liveLegs.length} className="ltd-basket-cell">
                              <div className="ltd-basket-title">{basket.title}</div>
                              {liveLegs.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleExitBasket(basket)}
                                  className="ltd-exit-all-btn"
                                >
                                  Exit All
                                </button>
                              )}
                            </td>
                          )}
                          <td>
                            <span className={`ltd-badge ${leg.action === 'BUY' ? 'ltd-badge-buy' : 'ltd-badge-sell'}`}>
                              {leg.action}
                            </span>{' '}
                            {leg.strike} {leg.optionType}
                          </td>
                          <td
                            className="text-right tabular-nums"
                            title={legEntryIsOwn(leg) ? 'This leg\'s own fill price' : 'Contract average from the broker (own fill not in the trade book yet) — includes anything else on this strike'}
                          >
                            {fmtPrice(legEntryPrice(row, leg))}{!legEntryIsOwn(leg) && legEntryPrice(row, leg) > 0 ? '*' : ''}
                          </td>
                          <td className="text-right tabular-nums">{ownQty}</td>
                          <td className={`text-right tabular-nums font-bold ${pnl >= 0 ? 'ltd-text-pos' : 'ltd-text-neg'}`} title={pnlTitle}>
                            {unpriced ? '—' : fmtRupee(pnl)}
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => handleExitLeg(basket, legIdx)}
                              disabled={isExiting || ownQty <= 0}
                              className="ltd-exit-btn"
                            >
                              {isExiting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Exit'}
                            </button>
                          </td>
                        </tr>
                      );
                    });
                  })}

                  {/* Live broker legs not tracked by this page's own ledger - a position opened
                      before this session (another tab, an earlier login, or before this page's
                      state existed at all). Grouped the same way so a pre-existing straddle
                      reads identically to one traded from this page. */}
                  {unledgeredGroups.map((group) => (
                    group.legs.map((leg, i) => {
                      const key = `book:${bookIdent(leg)}:${leg.display.productType}`;
                      const isExiting = exitingLegKey === key;
                      const pnl = leg.display.unrealizedProfit;
                      const unpriced = bookLegUnpriced(leg);
                      return (
                        <tr key={key}>
                          {i === 0 && (
                            <td rowSpan={group.legs.length} className="ltd-basket-cell">
                              <div className="ltd-basket-title">{group.title}</div>
                              <div className="ltd-basket-subtitle">{leg.display.productType}</div>
                              {group.legs.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => handleExitBrokerGroup(group.legs)}
                                  className="ltd-exit-all-btn"
                                >
                                  Exit All
                                </button>
                              )}
                            </td>
                          )}
                          <td>
                            <span className={`ltd-badge ${leg.side === 'BUY' ? 'ltd-badge-buy' : 'ltd-badge-sell'}`}>
                              {leg.side}
                            </span>{' '}
                            {leg.strike} {leg.type}
                          </td>
                          <td className="text-right tabular-nums">{fmtPrice(leg.price)}</td>
                          <td className="text-right tabular-nums">{leg.qtyLots}</td>
                          <td className={`text-right tabular-nums font-bold ${pnl >= 0 ? 'ltd-text-pos' : 'ltd-text-neg'}`}>
                            {unpriced ? '—' : fmtRupee(pnl)}
                          </td>
                          <td className="text-right">
                            <button
                              type="button"
                              onClick={() => handleExitBrokerLeg(leg)}
                              disabled={isExiting}
                              className="ltd-exit-btn"
                            >
                              {isExiting ? <Loader2 className="h-3 w-3 animate-spin" /> : 'Exit'}
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === 'orders' && (
          liveOrders.length === 0 ? (
            <div className="ltd-empty">No pending orders from this page.</div>
          ) : (
            <div className="ltd-table-wrap">
              <table className="ltd-table">
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Side</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Price</th>
                    <th>Type</th>
                    <th>Status</th>
                    <th className="text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {liveOrders.map((row) => {
                    const isEditing = editingOrderId === row.orderId;
                    const isLimit = row.orderType.toUpperCase().includes('LIMIT') && !row.orderType.toUpperCase().includes('MARKET');
                    return (
                      <tr key={row.orderId}>
                        <td className="ltd-symbol">{row.tradingSymbol}</td>
                        <td>
                          <span className={`ltd-badge ${row.transactionType === 'BUY' ? 'ltd-badge-buy' : 'ltd-badge-sell'}`}>
                            {row.transactionType}
                          </span>
                        </td>
                        <td className="text-right tabular-nums">
                          {isEditing ? (
                            <input
                              type="number"
                              value={draftQty}
                              onChange={(e) => setDraftQty(e.target.value)}
                              className="ltd-input"
                            />
                          ) : row.quantity}
                        </td>
                        <td className="text-right tabular-nums">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.05"
                              value={draftPrice}
                              onChange={(e) => setDraftPrice(e.target.value)}
                              className="ltd-input"
                            />
                          ) : `₹${row.price.toFixed(2)}`}
                        </td>
                        <td>{row.orderType}</td>
                        <td>
                          <span className="ltd-status">{row.orderStatus}</span>
                        </td>
                        <td className="text-right whitespace-nowrap">
                          {isEditing ? (
                            <div className="flex items-center justify-end gap-1">
                              <button type="button" onClick={() => saveEditOrder(row)} className="ltd-icon-btn ltd-icon-save" title="Save">
                                <Check className="h-3 w-3" />
                              </button>
                              <button type="button" onClick={() => setEditingOrderId(null)} className="ltd-icon-btn" title="Discard">
                                <XCircle className="h-3 w-3" />
                              </button>
                            </div>
                          ) : cancelConfirmId === row.orderId ? (
                            <div className="flex items-center justify-end gap-1">
                              <button type="button" onClick={() => handleCancelOrder(row.orderId)} className="ltd-confirm-yes">Yes</button>
                              <button type="button" onClick={() => setCancelConfirmId(null)} className="ltd-confirm-no">No</button>
                            </div>
                          ) : (
                            <div className="flex items-center justify-end gap-1">
                              {isLimit && (
                                <button type="button" onClick={() => startEditOrder(row)} className="ltd-icon-btn" title="Edit">
                                  <Pencil className="h-3 w-3" />
                                </button>
                              )}
                              <button type="button" onClick={() => setCancelConfirmId(row.orderId)} className="ltd-icon-btn ltd-icon-cancel" title="Cancel">
                                <Ban className="h-3 w-3" />
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )
        )}

        {tab === 'trades' && (
          trades.length === 0 ? (
            <div className="ltd-empty">No trades from this page&apos;s baskets yet.</div>
          ) : (
            <div className="ltd-table-wrap">
              <table className="ltd-table">
                <thead>
                  <tr>
                    <th>Contract</th>
                    <th>Side</th>
                    <th className="text-right">Qty</th>
                    <th className="text-right">Price</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((row, i) => (
                    <tr key={`${row.securityId}-${row.createTime}-${i}`}>
                      <td className="ltd-symbol">{row.tradingSymbol}</td>
                      <td>
                        <span className={`ltd-badge ${row.transactionType === 'BUY' ? 'ltd-badge-buy' : 'ltd-badge-sell'}`}>
                          {row.transactionType}
                        </span>
                      </td>
                      <td className="text-right tabular-nums">{row.tradedQuantity}</td>
                      <td className="text-right tabular-nums">₹{row.tradedPrice.toFixed(2)}</td>
                      <td className="ltd-time">{row.createTime.replace('T', ' ').slice(0, 19)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )
        )}
      </div>

      <style>{`
        .ltd-dock {
          flex-shrink: 0;
          width: min(400px, 34vw);
          min-width: 320px;
          height: 100%;
          display: flex;
          flex-direction: column;
          background: rgba(10, 14, 26, 0.97);
          border-left: 1px solid rgba(99, 102, 241, 0.2);
          color: #e2e8f0;
          font-family: 'Inter', system-ui, sans-serif;
          overflow: hidden;
        }
        :root:not(.dark) .ltd-dock {
          background: #ffffff;
          border-left-color: #e2e8f0;
          color: #0f172a;
        }
        .ltd-header {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          padding: 10px 12px;
          border-bottom: 1px solid rgba(99, 102, 241, 0.15);
        }
        :root:not(.dark) .ltd-header { border-bottom-color: #e2e8f0; }
        .ltd-title { font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
        .ltd-pnl-chip { font-size: 10px; font-family: monospace; font-weight: 700; padding: 2px 6px; border-radius: 6px; white-space: nowrap; }
        .ltd-pnl-pos { background: rgba(16,185,129,0.15); color: #34d399; }
        .ltd-pnl-neg { background: rgba(244,63,94,0.15); color: #fb7185; }
        .ltd-close-btn { color: rgba(255,255,255,0.5); background: transparent; border: none; cursor: pointer; padding: 4px; border-radius: 6px; flex-shrink: 0; }
        .ltd-close-btn:hover { color: #fff; background: rgba(255,255,255,0.08); }
        :root:not(.dark) .ltd-close-btn { color: #64748b; }
        :root:not(.dark) .ltd-close-btn:hover { color: #0f172a; background: #f1f5f9; }
        .ltd-tabs { flex-shrink: 0; display: flex; gap: 2px; padding: 8px 12px 0; border-bottom: 1px solid rgba(99, 102, 241, 0.15); }
        :root:not(.dark) .ltd-tabs { border-bottom-color: #e2e8f0; }
        .ltd-tab {
          display: flex; align-items: center; gap: 5px;
          font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em;
          padding: 6px 10px; border-radius: 8px 8px 0 0;
          background: transparent; border: 1px solid transparent; border-bottom: none;
          color: rgba(255,255,255,0.5); cursor: pointer;
        }
        :root:not(.dark) .ltd-tab { color: #64748b; }
        .ltd-tab:hover { color: rgba(255,255,255,0.8); }
        :root:not(.dark) .ltd-tab:hover { color: #1e293b; }
        .ltd-tab--active {
          background: rgba(99, 102, 241, 0.12);
          border-color: rgba(99, 102, 241, 0.25);
          color: #a5b4fc;
        }
        :root:not(.dark) .ltd-tab--active { background: #e0e7ff; border-color: #c7d2fe; color: #3730a3; }
        .ltd-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px 12px 12px; }
        .ltd-count { background: rgba(99,102,241,0.2); color: #a5b4fc; padding: 0 5px; border-radius: 999px; font-size: 9px; }
        .ltd-empty { font-size: 11px; color: rgba(255,255,255,0.4); padding: 8px 0; }
        .ltd-notice { display: flex; align-items: flex-start; gap: 8px; margin: 6px 10px 0; padding: 6px 8px; border-radius: 6px; font-size: 10.5px; line-height: 1.35; }
        .ltd-notice--warn { background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.35); color: #fcd34d; }
        .ltd-notice--error { background: rgba(244,63,94,0.12); border: 1px solid rgba(244,63,94,0.35); color: #fda4af; }
        :root:not(.dark) .ltd-notice--warn { color: #92400e; }
        :root:not(.dark) .ltd-notice--error { color: #9f1239; }
        .ltd-notice-x { margin-left: auto; background: none; border: none; color: inherit; cursor: pointer; font-size: 13px; line-height: 1; }
        .ltd-broker-note { margin: 6px 10px 0; font-size: 10px; font-weight: 700; color: #a5b4fc; }
        :root:not(.dark) .ltd-broker-note { color: #4338ca; }
        :root:not(.dark) .ltd-empty { color: #94a3b8; }
        .ltd-table-wrap { overflow-x: auto; }
        .ltd-table { width: 100%; font-size: 11px; font-family: monospace; border-collapse: collapse; }
        .ltd-table thead th { text-align: left; font-size: 9px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.04em; color: #fff; background: #27272a; padding: 5px 6px; }
        :root:not(.dark) .ltd-table thead th { background: #1e293b; }
        .ltd-table tbody td { padding: 5px 6px; border-bottom: 1px solid rgba(255,255,255,0.06); vertical-align: middle; }
        :root:not(.dark) .ltd-table tbody td { border-bottom-color: #e2e8f0; }
        .ltd-basket-cell { vertical-align: top; }
        .ltd-basket-title { font-weight: 700; font-size: 10px; white-space: nowrap; }
        .ltd-basket-subtitle { font-size: 9px; color: rgba(255,255,255,0.4); white-space: nowrap; }
        :root:not(.dark) .ltd-basket-subtitle { color: #94a3b8; }
        .ltd-exit-all-btn { margin-top: 3px; font-size: 9px; font-weight: 700; padding: 2px 6px; border-radius: 6px; background: rgba(244,63,94,0.15); color: #fb7185; border: 1px solid rgba(244,63,94,0.3); cursor: pointer; }
        .ltd-exit-all-btn:hover { background: rgba(244,63,94,0.25); }
        .ltd-badge { padding: 1px 5px; border-radius: 4px; font-size: 9px; font-weight: 700; }
        .ltd-badge-buy { background: rgba(16,185,129,0.15); color: #34d399; border: 1px solid rgba(16,185,129,0.3); }
        .ltd-badge-sell { background: rgba(244,63,94,0.15); color: #fb7185; border: 1px solid rgba(244,63,94,0.3); }
        .ltd-text-pos { color: #34d399; }
        .ltd-text-neg { color: #fb7185; }
        .ltd-exit-btn { font-size: 9px; font-weight: 700; padding: 3px 8px; border-radius: 6px; background: rgba(99,102,241,0.15); color: #a5b4fc; border: 1px solid rgba(99,102,241,0.3); cursor: pointer; }
        .ltd-exit-btn:hover:not(:disabled) { background: rgba(99,102,241,0.25); }
        .ltd-exit-btn:disabled { opacity: 0.4; cursor: not-allowed; }
        .ltd-symbol { font-weight: 700; white-space: nowrap; }
        .ltd-time { white-space: nowrap; color: rgba(255,255,255,0.5); }
        :root:not(.dark) .ltd-time { color: #64748b; }
        .ltd-status { font-size: 9px; font-weight: 700; padding: 1px 5px; border-radius: 4px; background: rgba(56,189,248,0.15); color: #7dd3fc; border: 1px solid rgba(56,189,248,0.3); }
        .ltd-input { width: 60px; text-align: center; background: #09090b; border: 1px solid rgba(56,189,248,0.5); border-radius: 4px; color: #fff; font-size: 11px; padding: 2px; }
        .ltd-icon-btn { padding: 4px; border-radius: 6px; background: #27272a; border: 1px solid #3f3f46; color: #a1a1aa; cursor: pointer; }
        .ltd-icon-btn:hover { color: #fff; }
        .ltd-icon-save { background: #059669; color: #fff; border-color: #059669; }
        .ltd-icon-cancel:hover { background: rgba(244,63,94,0.2); color: #fb7185; border-color: rgba(244,63,94,0.4); }
        .ltd-confirm-yes { font-size: 9px; font-weight: 700; padding: 3px 7px; border-radius: 6px; background: #e11d48; color: #fff; border: none; cursor: pointer; }
        .ltd-confirm-no { font-size: 9px; font-weight: 700; padding: 3px 7px; border-radius: 6px; background: #27272a; color: #d4d4d8; border: none; cursor: pointer; }
      `}</style>
    </div>
  );
}
