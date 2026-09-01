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
                onChange={patch => updateLeg(leg.id, patch)}
                onRemove={() => removeLeg(leg.id)}
                onExit={() => {}}
              />
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
