'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import NavBar from './NavBar';
import { type Toast, FOCUS_RING } from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate, nearestStrike, strikeStep,
} from '@/lib/basketStrategies';
import { sortLegsForPlacement, resolveOrderRequest, type StrikeIdentifier } from '@/lib/basketOrders';
import StrategyCardGrid from './basket/StrategyCardGrid';
import MultiLegLegRow from './multiLegFocus/MultiLegLegRow';
import {
  resolveTemplateLegs, reconcileLegFillDown, legPnl, basketTotalPnl, sortLegsForExit, findLegPosition,
  positionProduct, type MultiLegLeg, type MultiLegBasket,
} from '@/lib/multiLegFocus';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
type Underlying = typeof UNDERLYINGS[number];

function fmtMoney(n: number): string {
  return `${n < 0 ? '-' : ''}₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

export default function MultiLegFocus() {
  const { broker, setBroker, authenticatedBrokers, hasAuthenticatedBroker } = useBrokerSelector();
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');

  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState('');
  const [allStrikes, setAllStrikes] = useState<number[]>([]);
  const [chainSpot, setChainSpot] = useState(0);
  const [strikeMap, setStrikeMap] = useState<Record<string, StrikeIdentifier>>({});
  const [lotSize, setLotSize] = useState<number | null>(null);

  const { liveQuotes } = useLiveOptionsWS(expiry, broker, authenticatedBrokers, underlying);
  const spot = liveQuotes?.spot ?? chainSpot;
  const step = useMemo(() => strikeStep(allStrikes), [allStrikes]);
  const atmStrike = useMemo(() => (spot > 0 ? nearestStrike(allStrikes, spot) : null), [allStrikes, spot]);

  const ltpFor = useCallback((leg: MultiLegLeg): number => {
    const entry = liveQuotes?.strikes?.[String(leg.strike)];
    return (leg.option === 'CE' ? entry?.ce?.ltp : entry?.pe?.ltp) ?? 0;
  }, [liveQuotes]);

  const [category, setCategory] = useState<StrategyCategory>('Range Bound');
  const [presetKey, setPresetKey] = useState<string | null>(null);
  const [legs, setLegs] = useState<MultiLegLeg[]>([]);
  const [basketId, setBasketId] = useState<string | null>(null);

  const [toasts, setToasts] = useState<Toast[]>([]);
  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  const expiryRef = useRef(''); useEffect(() => { expiryRef.current = expiry; }, [expiry]);
  const underlyingRef = useRef<Underlying>(underlying); useEffect(() => { underlyingRef.current = underlying; }, [underlying]);

  // Any leg already placed (has an orderRef) locks the whole editor — a basket
  // is placed once, then only monitored/exited, never edited mid-flight.
  const hasPlacedLeg = legs.some(l => l.status !== 'DRAFT');

  // ── Expiries: reload on broker/underlying change ────────────────
  useEffect(() => {
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (j.success && j.data?.length) {
          setExpiries(j.data);
          setExpiry(prev => j.data!.includes(prev) ? prev : j.data![0]);
        }
      })
      .catch(() => {});
  }, [broker, underlying]);

  // ── Option chain: strikes + spot ─────────────────────────────────
  useEffect(() => {
    if (!expiry) return;
    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { strikes?: number[]; spot?: number } }) => {
        if (j.success && j.data) {
          setAllStrikes(j.data.strikes ?? []);
          setChainSpot(j.data.spot ?? 0);
        }
      })
      .catch(() => {});
  }, [broker, underlying, expiry]);

  // ── Strike -> order-identifier lookup ────────────────────────────
  useEffect(() => {
    if (!expiry) { setStrikeMap({}); return; }
    const lookupUrl = `${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${expiry}`;
    fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize?: number; strikes?: Record<string, StrikeIdentifier> } }) => {
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes ?? {});
          setLotSize(j.data.lotSize ?? null);
        }
      })
      .catch(() => {});
  }, [broker, underlying, expiry]);

  // ── Preset -> legs ────────────────────────────────────────────────
  const applyTemplate = useCallback((tpl: StrategyTemplate) => {
    if (hasPlacedLeg) return;
    if (tpl.legs.some(l => l.expiryRole === 'far')) {
      addToast('error', 'Not supported here', `${tpl.name} needs a second expiry — use the Baskets page for calendar/diagonal spreads`);
      return;
    }
    if (atmStrike == null) {
      addToast('error', 'Cannot apply template', 'Option chain not loaded yet — retry in a moment');
      return;
    }
    setPresetKey(tpl.key);
    setLegs(resolveTemplateLegs(tpl, atmStrike, allStrikes, step));
    setBasketId(null);
  }, [hasPlacedLeg, atmStrike, allStrikes, step, addToast]);

  const addBlankLeg = useCallback(() => {
    if (hasPlacedLeg) return;
    if (atmStrike == null) {
      addToast('error', 'Cannot add leg', 'Option chain not loaded yet — retry in a moment');
      return;
    }
    setPresetKey(null);
    setLegs(prev => [...prev, ...resolveTemplateLegs(
      { key: 'manual', name: 'Manual', legs: [{ side: 'B', option: 'CE', offset: 0, ratio: 1 }] },
      atmStrike, allStrikes, step,
    )]);
  }, [hasPlacedLeg, atmStrike, allStrikes, step, addToast]);

  const removeLeg = useCallback((id: string) => {
    if (hasPlacedLeg) return;
    setLegs(prev => prev.filter(l => l.id !== id));
  }, [hasPlacedLeg]);

  const updateLeg = useCallback((id: string, patch: Partial<MultiLegLeg>) => {
    if (hasPlacedLeg) return;
    setLegs(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  }, [hasPlacedLeg]);

  const clearBasket = useCallback(() => {
    if (hasPlacedLeg) return;
    setLegs([]); setPresetKey(null); setBasketId(null);
  }, [hasPlacedLeg]);

  const [placing, setPlacing] = useState(false);
  const [confirmPlace, setConfirmPlace] = useState(false);
  const placingRef = useRef(false);

  const persistBasket = useCallback((nextLegs: MultiLegLeg[], id: string | null) => {
    const body: Partial<MultiLegBasket> & { id?: string } = {
      id: id ?? undefined, underlying, expiry, broker, presetKey: presetKey ?? undefined, legs: nextLegs,
    };
    fetch('/api/multi-leg-focus/baskets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
      .then(r => r.json())
      .then((j: { success: boolean; data?: MultiLegBasket[] }) => {
        if (j.success && j.data && !id) {
          const created = j.data[j.data.length - 1];
          if (created) setBasketId(created.id);
        }
      })
      .catch(() => {});
  }, [underlying, expiry, broker, presetKey]);

  // Best-effort flatten of already-placed legs when a basket stops mid-way —
  // ported from Baskets.tsx's rollbackPlacedLegs, adapted to MultiLegLeg.
  const rollbackPlacedLegs = useCallback(async (placedIds: string[], currentLegs: MultiLegLeg[]) => {
    if (!placedIds.length) return;
    addToast('error', `Auto-flattening ${placedIds.length} placed leg(s)`, 'Reversing with market orders — verify in Orders/Positions after');
    for (const id of [...placedIds].reverse()) {
      const leg = currentLegs.find(l => l.id === id);
      if (!leg?.fill) continue;
      const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
      const reverseReq = resolveOrderRequest(broker, {
        side: leg.side === 'B' ? 'S' : 'B', option: leg.option, strike: leg.strike, qty: leg.fill.qty, type: 'MARKET', underlying,
        productType: 'MARGIN',
      }, strikeMap);
      if (!reverseReq) {
        addToast('error', `Could not auto-reverse ${label}`, 'No order identifier — close manually from Orders/Positions');
        continue;
      }
      try {
        const res = await fetch(reverseReq.url, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reverseReq.body),
        });
        const j = await res.json() as { success: boolean; order_id?: string; error?: string };
        if (j.success) addToast('success', `Reversed ${label}`, `ID: ${j.order_id}`);
        else addToast('error', `Reverse failed for ${label}`, `${j.error ?? 'Unknown error'} — close manually from Orders/Positions`);
      } catch (e) {
        addToast('error', `Reverse UNCONFIRMED for ${label}`, `Close manually from Orders/Positions: ${String(e)}`);
      }
    }
  }, [broker, underlying, strikeMap, addToast]);

  const placeBasket = useCallback(async () => {
    if (!legs.length || !expiry) return;
    if (!hasAuthenticatedBroker) {
      addToast('error', 'No broker logged in', 'Log in before placing a basket');
      return;
    }
    if (!lotSize || lotSize <= 0) {
      addToast('error', 'Cannot place basket', `Lot size for ${underlying} not resolved yet — retry in a moment`);
      return;
    }
    for (const leg of legs) {
      if (leg.type === 'LIMIT' && (!leg.price || leg.price <= 0)) {
        addToast('error', 'Invalid limit price', `${leg.side === 'B' ? 'Buy' : 'Sell'} ${leg.strike} ${leg.option}`);
        return;
      }
    }
    if (!confirmPlace) {
      setConfirmPlace(true);
      setTimeout(() => setConfirmPlace(false), 4000);
      return;
    }
    setConfirmPlace(false);
    if (placingRef.current) return;
    placingRef.current = true;
    setPlacing(true);

    const ordered = sortLegsForPlacement(legs);
    let working: MultiLegLeg[] = legs.map(l => ({ ...l, status: 'PLACING' as const }));
    const placedIds: string[] = [];

    try {
      for (const leg of ordered) {
        const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
        const qty = leg.lots * lotSize;
        const req = resolveOrderRequest(broker, {
          side: leg.side, option: leg.option, strike: leg.strike, qty, type: leg.type,
          price: leg.type === 'LIMIT' ? leg.price : undefined, underlying, productType: 'MARGIN',
        }, strikeMap);
        if (!req) {
          addToast('error', `${label} — no order identifier resolved`, 'Strike lookup not ready yet — basket stopped');
          working = working.map(l => (placedIds.includes(l.id) ? l : { ...l, status: 'FAILED' as const }));
          setLegs(working); persistBasket(working, basketId);
          await rollbackPlacedLegs(placedIds, working);
          return;
        }
        try {
          const res = await fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
          const j = await res.json() as { success: boolean; order_id?: string; error?: string };
          if (j.success) {
            const orderRef = broker === 'dhan' ? { securityId: String(req.body.securityId) } : { symbol: String(req.body.tradingsymbol) };
            // The order routes only return order_id, never a fill price — a MARKET
            // order's ack isn't its fill (see dhan-terminal-position-ownership).
            // Use the live LTP at send-time as the entry estimate, same convention
            // FocusRowFill.ceEntry/peEntry documents for FocusTool.
            const avgPrice = leg.type === 'LIMIT' ? (leg.price ?? ltpFor(leg)) : ltpFor(leg);
            working = working.map(l => (l.id === leg.id
              ? { ...l, status: 'OPEN' as const, fill: { qty, avgPrice }, orderRef }
              : l));
            placedIds.push(leg.id);
            addToast('success', `${label} placed`, `ID: ${j.order_id}`);
          } else {
            // Mark the failing leg AND every leg not yet attempted as FAILED —
            // leaving them at 'PLACING' would strand them there forever, since
            // the loop returns immediately and never revisits them.
            working = working.map(l => (placedIds.includes(l.id) ? l : { ...l, status: 'FAILED' as const }));
            addToast('error', `${label} failed — basket stopped`, j.error ?? 'Unknown error');
            setLegs(working); persistBasket(working, basketId);
            await rollbackPlacedLegs(placedIds, working);
            return;
          }
        } catch (e) {
          working = working.map(l => (placedIds.includes(l.id) ? l : { ...l, status: 'FAILED' as const }));
          addToast('error', `${label} UNCONFIRMED — basket stopped`, `Check Orders before retrying: ${String(e)}`);
          setLegs(working); persistBasket(working, basketId);
          await rollbackPlacedLegs(placedIds, working);
          return;
        }
      }
      setLegs(working);
      persistBasket(working, basketId);
      addToast('success', `Basket complete: ${placedIds.length}/${legs.length} legs placed`);
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  }, [legs, expiry, hasAuthenticatedBroker, lotSize, underlying, confirmPlace, broker, strikeMap, basketId, addToast, persistBasket, rollbackPlacedLegs, ltpFor]);

  const legsRef = useRef(legs); useEffect(() => { legsRef.current = legs; }, [legs]);

  useEffect(() => {
    if (!legs.some(l => l.status === 'OPEN')) return;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await fetch(scalperRoute(broker, 'positions'));
        const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
        if (cancelled || !j.success || !j.data) return;
        const rows = j.data;
        setLegs(prev => prev.map(leg => {
          if (leg.status !== 'OPEN') return leg;
          const match = findLegPosition(broker, leg, rows);
          const absQty = match.kind === 'match' ? Math.abs(Number(match.row.netQty) || 0) : (match.kind === 'flat' ? 0 : null);
          return reconcileLegFillDown(leg, absQty);
        }));
      } catch {
        // transient network/broker error — leave the ledger untouched this tick
      }
    };

    poll();
    const id = setInterval(poll, 3000);
    return () => { cancelled = true; clearInterval(id); };
  }, [broker, legs.some(l => l.status === 'OPEN')]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Restore the most recently updated open basket on mount ───────
  useEffect(() => {
    fetch('/api/multi-leg-focus/baskets')
      .then(r => r.json())
      .then((j: { success: boolean; data?: MultiLegBasket[] }) => {
        if (!j.success || !j.data?.length) return;
        const open = [...j.data].filter(b => b.legs.some(l => l.status === 'OPEN' || l.status === 'PLACING'))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
        if (!open) return;
        setBasketId(open.id);
        setUnderlying(open.underlying as Underlying);
        setExpiry(open.expiry);
        setBroker(open.broker as Broker);
        setPresetKey(open.presetKey ?? null);
        setLegs(open.legs);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const totalPnl = useMemo(() => basketTotalPnl(legs, ltpFor), [legs, ltpFor]);

  const [exiting, setExiting] = useState<Set<string>>(new Set());
  const exitingRef = useRef<Set<string>>(new Set());

  const exitOneLeg = useCallback(async (leg: MultiLegLeg): Promise<boolean> => {
    if (leg.status !== 'OPEN') return true;
    // Synchronous re-entry guard: React state updates are async, so two rapid
    // calls could both observe `exiting` as "not yet exiting" before either
    // write lands. A ref mutation is visible to the very next call immediately.
    if (exitingRef.current.has(leg.id)) return false;
    exitingRef.current.add(leg.id);
    setExiting(prev => new Set([...prev, leg.id]));
    setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'CLOSING' as const } : l)));
    const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;

    try {
      const res = await fetch(scalperRoute(broker, 'positions'));
      const j = await res.json() as { success: boolean; data?: Record<string, unknown>[] };
      if (!j.success || !j.data) {
        addToast('error', `Cannot exit ${label}`, 'Failed to fetch live positions — try again');
        setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'OPEN' as const } : l)));
        return false;
      }
      const match = findLegPosition(broker, leg, j.data);
      if (match.kind !== 'match') {
        // Never fall back to the local ledger qty once the broker match fails —
        // guessing the exit size here is exactly what the ownership rule forbids.
        addToast('error', `Cannot exit ${label}`, match.kind === 'ambiguous' ? `${match.count} rows share this symbol — close manually from Orders/Positions` : 'No matching broker position found — it may already be closed');
        setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: match.kind === 'flat' ? 'CLOSED' as const : 'OPEN' as const } : l)));
        return match.kind === 'flat';
      }
      const netQty = Number(match.row.netQty) || 0;
      if (netQty === 0) {
        addToast('success', `${label} already flat`);
        setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'CLOSED' as const, fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 } } : l)));
        return true;
      }
      const product = positionProduct(match.row);
      const closeFields = broker === 'dhan' ? { productType: product } : { product };
      const side = netQty > 0 ? 'SELL' : 'BUY';
      const qty = Math.abs(netQty);
      const orderUrl = broker === 'dhan' ? '/api/scalper/fast-order' : scalperRoute(broker, 'order');
      const body = broker === 'dhan'
        ? { securityId: leg.orderRef?.securityId, quantity: qty, side, orderType: 'MARKET', exchangeSegment: match.row.exchangeSegment ?? 'NSE_FNO', ...closeFields }
        : { tradingsymbol: leg.orderRef?.symbol, quantity: qty, side, orderType: 'MARKET', exchange: match.row.exchange ?? 'NFO', ...closeFields };

      const res2 = await fetch(orderUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const j2 = await res2.json() as { success: boolean; order_id?: string; error?: string };
      if (j2.success) {
        addToast('success', `Exited ${label}`, `ID: ${j2.order_id}`);
        setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'CLOSED' as const, fill: { qty: 0, avgPrice: l.fill?.avgPrice ?? 0 } } : l)));
        return true;
      }
      addToast('error', `Exit failed for ${label}`, j2.error ?? 'Unknown error');
      setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'OPEN' as const } : l)));
      return false;
    } catch (e) {
      addToast('error', `Exit UNCONFIRMED for ${label}`, `Check Orders/Positions manually: ${String(e)}`);
      setLegs(prev => prev.map(l => (l.id === leg.id ? { ...l, status: 'OPEN' as const } : l)));
      return false;
    } finally {
      exitingRef.current.delete(leg.id);
      setExiting(prev => { const next = new Set(prev); next.delete(leg.id); return next; });
    }
  }, [broker, addToast]);

  const exitLeg = useCallback((id: string) => {
    const leg = legsRef.current.find(l => l.id === id);
    if (leg) exitOneLeg(leg).then(() => persistBasket(legsRef.current, basketId));
  }, [exitOneLeg, persistBasket, basketId]);

  const exitBasket = useCallback(async () => {
    const ordered = sortLegsForExit(legsRef.current.filter(l => l.status === 'OPEN'));
    for (const leg of ordered) {
      await exitOneLeg(leg);
    }
    persistBasket(legsRef.current, basketId);
  }, [exitOneLeg, persistBasket, basketId]);

  return (
    <div className="min-h-screen bg-zinc-950">
      <NavBar />

      <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold shadow-2xl max-w-xs ${
            t.type === 'success' ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200' : 'bg-rose-900/95 border-rose-500/40 text-rose-200'
          }`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-80 mt-0.5">{t.detail}</p>}
          </div>
        ))}
      </div>

      {!hasAuthenticatedBroker && (
        <div className="z-20 bg-amber-900/95 border-b border-amber-500/40 px-4 py-2 text-center">
          <p className="text-xs font-bold text-amber-200">No broker logged in — log in to fetch live data and place orders.</p>
        </div>
      )}

      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
        <div className="flex items-center gap-2 flex-wrap">
          <select value={broker} onChange={e => setBroker(e.target.value as Broker)}
            className={`h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500 ${FOCUS_RING}`}>
            {(Object.keys(BROKER_LABELS) as Broker[]).map(b => <option key={b} value={b}>{BROKER_LABELS[b]}</option>)}
          </select>
          <select value={underlying} onChange={e => setUnderlying(e.target.value as Underlying)} disabled={hasPlacedLeg}
            className={`h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING}`}>
            {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
          </select>
          <select value={expiry} onChange={e => setExpiry(e.target.value)} disabled={hasPlacedLeg}
            className={`h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500 disabled:opacity-50 ${FOCUS_RING}`}>
            {expiries.map(e => <option key={e} value={e}>{e}</option>)}
          </select>
          <span className="h-8 flex items-center px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200">
            Spot {spot > 0 ? spot.toLocaleString('en-IN', { maximumFractionDigits: 1 }) : '—'}
          </span>
        </div>

        <div className="mt-2 pt-2 border-t border-zinc-800">
          <StrategyCardGrid
            category={category}
            onCategoryChange={setCategory}
            selectedKey={presetKey}
            onSelectTemplate={applyTemplate}
            disabled={hasPlacedLeg}
          />
        </div>
      </div>

      <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/40">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-bold text-zinc-300 uppercase tracking-widest">
            Legs{legs.length > 0 ? ` · ${legs.length}` : ''}
          </span>
          <button onClick={addBlankLeg} disabled={hasPlacedLeg}
            className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-zinc-700 text-zinc-200 hover:bg-zinc-800 disabled:opacity-40 ${FOCUS_RING}`}>
            <Plus className="w-3 h-3" /> Add Leg
          </button>
          {legs.length > 0 && !hasPlacedLeg && (
            <button onClick={clearBasket}
              className={`h-7 px-2.5 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border border-zinc-700 text-zinc-400 hover:text-rose-300 hover:bg-zinc-800 ${FOCUS_RING}`}>
              <X className="w-3 h-3" /> Clear
            </button>
          )}
          {legs.length > 0 && !hasPlacedLeg && (
            <button onClick={placeBasket} disabled={placing}
              className={`h-7 ml-auto px-3 inline-flex items-center gap-1 text-[11px] font-bold rounded-lg border transition-all disabled:opacity-50 ${
                confirmPlace ? 'bg-amber-500/20 border-amber-500/50 text-amber-200' : 'bg-emerald-500/10 border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/20'
              } ${FOCUS_RING}`}>
              {placing ? 'Placing…' : confirmPlace ? 'Click again to confirm' : 'Place Basket'}
            </button>
          )}
          {legs.some(l => l.status === 'OPEN' || l.status === 'CLOSING') && (
            <>
              <span className={`h-7 flex items-center px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums border ${
                totalPnl >= 0 ? 'text-emerald-400 border-emerald-500/30 bg-emerald-500/5' : 'text-rose-400 border-rose-500/30 bg-rose-500/5'
              }`}>
                {totalPnl >= 0 ? '+' : ''}{fmtMoney(totalPnl)}
              </span>
              <button onClick={exitBasket}
                className={`h-7 px-3 text-[11px] font-bold rounded-lg border border-rose-500/40 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 ${FOCUS_RING}`}>
                Exit Basket
              </button>
            </>
          )}
        </div>
      </div>

      {legs.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-20 gap-1.5">
          <p className="text-sm font-semibold text-zinc-400">No legs yet</p>
          <p className="text-xs text-zinc-500">Pick a predefined strategy above or add legs manually</p>
        </div>
      ) : (
        <table className="w-full table-fixed text-xs">
          <colgroup>
            <col className="w-[10%]" /><col className="w-[8%]" /><col className="w-[14%]" />
            <col className="w-[8%]" /><col className="w-[12%]" /><col className="w-[12%]" />
            <col className="w-[14%]" /><col className="w-[12%]" /><col className="w-[10%]" />
          </colgroup>
          <thead>
            <tr className="text-xs font-bold text-white border-b border-zinc-800 bg-zinc-800">
              <th className="px-3 py-2.5 text-left">Side</th>
              <th className="px-2 py-2.5 text-left">CE/PE</th>
              <th className="px-2 py-2.5 text-left">Strike</th>
              <th className="px-2 py-2.5 text-left">Lots</th>
              <th className="px-2 py-2.5 text-left">Type</th>
              <th className="px-2 py-2.5 text-right">LTP</th>
              <th className="px-2 py-2.5 text-right">P&L</th>
              <th className="px-2 py-2.5 text-center">Status</th>
              <th className="px-2 py-2.5 text-center"></th>
            </tr>
          </thead>
          <tbody>
            {legs.map(leg => (
              <MultiLegLegRow
                key={leg.id}
                leg={leg}
                allStrikes={allStrikes}
                ltp={ltpFor(leg)}
                editable={!hasPlacedLeg}
                exiting={exiting.has(leg.id)}
                onChange={patch => updateLeg(leg.id, patch)}
                onRemove={() => removeLeg(leg.id)}
                onExit={() => exitLeg(leg.id)}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
