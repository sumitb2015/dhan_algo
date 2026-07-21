'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import NavBar from './NavBar';
import { ShoppingBasket, RefreshCw, Wallet } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatFundsValue, type ChainOcEntry, type Toast } from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector } from '@/hooks/useBrokerSelector';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate,
  type BasketLeg, type OptionType, type PayoffLeg,
  computePayoff, nearestStrike, strikeStep, daysToExpiry,
} from '@/lib/basketStrategies';
import {
  type SavedBasket, loadSavedBaskets, persistSavedBaskets, legToOffset, offsetToStrike,
} from '@/lib/basketStorage';
import { sortLegsForPlacement, resolveOrderRequest, type StrikeIdentifier } from '@/lib/basketOrders';
import BasketPayoffChart from './BasketPayoffChart';
import StrategyCardGrid from './basket/StrategyCardGrid';
import LegsTable from './basket/LegsTable';
import SavedBasketsPanel from './basket/SavedBasketsPanel';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
type Underlying = typeof UNDERLYINGS[number];

function fmtMoney(n: number): string {
  return `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function MetricTile({ label, value, tone = 'neutral' }: {
  label: string; value: React.ReactNode; tone?: 'neutral' | 'profit' | 'loss';
}) {
  const color = tone === 'profit' ? 'text-emerald-400' : tone === 'loss' ? 'text-rose-400' : 'text-zinc-100';
  return (
    <div className="px-4 py-3">
      <p className="text-[10px] uppercase tracking-widest text-zinc-500 font-bold">{label}</p>
      <p className={`text-sm font-bold font-mono tabular-nums mt-1 leading-tight ${color}`}>{value}</p>
    </div>
  );
}

export default function Baskets() {
  const { broker, setBroker, authenticatedBrokers } = useBrokerSelector();
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');

  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry]     = useState('');

  const [allStrikes, setAllStrikes] = useState<number[]>([]);
  const [prevClose, setPrevClose]   = useState<Record<string, { ce: number; pe: number }>>({});
  const [chainSpot, setChainSpot]   = useState(0);
  const [strikeMap, setStrikeMap]   = useState<Record<string, StrikeIdentifier>>({});
  const [lotSize, setLotSize]       = useState(75);

  const { liveQuotes, bridgeStatus, lastUpdated, transport } = useLiveOptionsWS(expiry, broker, authenticatedBrokers, underlying);

  const [category, setCategory]   = useState<StrategyCategory>('Bullish');
  const [strategy, setStrategy]   = useState<string | null>(null);
  const [legs, setLegs]           = useState<BasketLeg[]>([]);
  const [multiplier, setMultiplier] = useState(1);

  const [toasts, setToasts]           = useState<Toast[]>([]);
  const [placing, setPlacing]         = useState(false);
  const [confirmPlace, setConfirmPlace] = useState(false);

  const [saveOpen, setSaveOpen]   = useState(false);
  const [saveName, setSaveName]   = useState('');
  const [saved, setSaved]         = useState<SavedBasket[]>([]);

  const [fundsData, setFundsData] = useState<Record<string, number> | null>(null);

  const legCounterRef  = useRef(0);
  const placingRef     = useRef(false);
  const expiryRef      = useRef('');
  useEffect(() => { expiryRef.current = expiry; }, [expiry]);
  const underlyingRef  = useRef<Underlying>(underlying);
  useEffect(() => { underlyingRef.current = underlying; }, [underlying]);

  // Tags which (underlying, expiry) the current allStrikes/atmStrike actually
  // belong to. Needed because on the render where `underlying` flips, the
  // per-expiry effect's setAllStrikes([]) reset and this component's other
  // effects (e.g. the cross-underlying load completion effect below) all fire
  // in the same commit but read pre-reset closure values — without this tag,
  // a load-basket triggered underlying switch can momentarily see the OLD
  // underlying's still-non-null atmStrike/allStrikes and wrongly re-anchor a
  // saved basket to the previous underlying's strikes.
  const chainReadyForRef = useRef<{ underlying: string; expiry: string } | null>(null);

  const spot = liveQuotes?.spot ?? chainSpot;
  const step = useMemo(() => strikeStep(allStrikes), [allStrikes]);
  const atmStrike = useMemo(
    () => (spot > 0 ? nearestStrike(allStrikes, spot) : null),
    [allStrikes, spot]);

  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  // ── Bootstrap: saved baskets ────────────────────────────────────
  useEffect(() => {
    setSaved(loadSavedBaskets());
  }, []);

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

  // ── Funds tile: reload on broker change ──────────────────────────
  useEffect(() => {
    const url = broker === 'zerodha' ? '/api/scalper/zerodha/funds' : '/api/scalper/funds';
    fetch(url)
      .then(r => r.json())
      .then((j: { success: boolean; data?: Record<string, number> }) => {
        setFundsData(j.success ? (j.data ?? null) : null);
      })
      .catch(() => setFundsData(null));
  }, [broker]);

  // ── Per-expiry: chain + lookup + live feed ──────────────────────
  useEffect(() => {
    if (!expiry) return;

    chainReadyForRef.current = null;
    setLegs([]);
    setStrategy(null);
    setAllStrikes([]);
    setPrevClose({});
    setStrikeMap({});
    setChainSpot(0);

    const requestedUnderlying = underlying;
    const requestedExpiryForChain = expiry;
    fetch(`/api/options/chain?underlying=${underlying}&expiry=${expiry}&broker=${broker}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { chain: { oc?: Record<string, ChainOcEntry> }; spot: number } }) => {
        if (requestedUnderlying !== underlyingRef.current || requestedExpiryForChain !== expiryRef.current) return;
        if (!j.success || !j.data?.chain?.oc) return;
        const oc = j.data.chain.oc;
        const strikes = Object.keys(oc).map(Number).filter(n => !isNaN(n)).sort((a, b) => a - b);
        setAllStrikes(strikes);

        const pc: Record<string, { ce: number; pe: number }> = {};
        for (const [sk, entry] of Object.entries(oc)) {
          pc[sk] = { ce: entry.ce?.previous_close ?? 0, pe: entry.pe?.previous_close ?? 0 };
        }
        setPrevClose(pc);
        if ((j.data.spot ?? 0) > 0) setChainSpot(j.data.spot);
        chainReadyForRef.current = { underlying: requestedUnderlying, expiry: requestedExpiryForChain };
      })
      .catch(() => {});

    const requestedUnderlyingForLookup = underlying;
    const requestedExpiry = expiry;
    const lookupUrl = broker === 'zerodha'
      ? `/api/scalper/zerodha/lookup?underlying=${underlying}&expiry=${expiry}`
      : `/api/scalper/lookup?underlying=${underlying}&expiry=${expiry}`;
    fetch(lookupUrl)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, StrikeIdentifier> } }) => {
        if (requestedUnderlyingForLookup !== underlyingRef.current || requestedExpiry !== expiryRef.current) return;
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          setLotSize(j.data.lotSize);
        }
      })
      .catch(() => {});

    for (const b of authenticatedBrokers) {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'start', underlying, expiry, numStrikes: 30, broker: b }),
      }).catch(() => {});
    }

    return () => {
      fetch('/api/options/live', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'stop', brokers: authenticatedBrokers }),
      }).catch(() => {});
    };
  }, [expiry, underlying, broker, authenticatedBrokers]);

  // ── Pricing helpers ─────────────────────────────────────────────
  const autoPremium = useCallback((strike: number, option: OptionType): number => {
    const key = String(strike);
    const live = liveQuotes?.strikes?.[key]?.[option === 'CE' ? 'ce' : 'pe']?.ltp ?? 0;
    if (live > 0) return live;
    return prevClose[key]?.[option === 'CE' ? 'ce' : 'pe'] ?? 0;
  }, [liveQuotes, prevClose]);

  const effectivePremium = useCallback((leg: BasketLeg): number => {
    const manual = Number(leg.price);
    if (leg.price.trim() !== '' && !isNaN(manual) && manual > 0) return manual;
    return autoPremium(leg.strike, leg.option);
  }, [autoPremium]);

  // ── Leg operations ──────────────────────────────────────────────
  const newLegId = () => `leg-${++legCounterRef.current}`;

  const applyTemplate = useCallback((tpl: StrategyTemplate) => {
    if (atmStrike == null || !allStrikes.length) {
      addToast('error', 'Strikes still loading', 'Wait for the option chain, then pick a strategy');
      return;
    }
    setStrategy(tpl.key);
    setLegs(tpl.legs.map(l => {
      const target = atmStrike + l.offset * step;
      const strike = nearestStrike(allStrikes, target) ?? atmStrike;
      return { id: newLegId(), side: l.side, option: l.option, strike, lots: l.ratio, type: 'MARKET' as const, price: '' };
    }));
  }, [atmStrike, allStrikes, step, addToast]);

  const updateLeg = useCallback((id: string, patch: Partial<BasketLeg>) => {
    setLegs(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  const stepStrike = useCallback((id: string, dir: 1 | -1) => {
    setLegs(prev => prev.map(l => {
      if (l.id !== id) return l;
      const idx = allStrikes.indexOf(l.strike);
      const nextIdx = idx < 0 ? -1 : idx + dir;
      if (nextIdx < 0 || nextIdx >= allStrikes.length) return l;
      return { ...l, strike: allStrikes[nextIdx], price: '' };
    }));
  }, [allStrikes]);

  const addLeg = useCallback(() => {
    if (atmStrike == null) {
      addToast('error', 'Strikes still loading');
      return;
    }
    setLegs(prev => [...prev, {
      id: newLegId(), side: 'B', option: 'CE', strike: atmStrike, lots: 1, type: 'MARKET', price: '',
    }]);
  }, [atmStrike, addToast]);

  const removeLeg = useCallback((id: string) => {
    setLegs(prev => prev.filter(l => l.id !== id));
  }, []);

  // ── Payoff + metrics ────────────────────────────────────────────
  const payoffLegs = useMemo<PayoffLeg[]>(() => legs.map(l => ({
    side: l.side, option: l.option, strike: l.strike,
    premium: effectivePremium(l), qty: l.lots * multiplier * lotSize,
  })), [legs, multiplier, lotSize, effectivePremium]);

  const payoff = useMemo(() => {
    if (!payoffLegs.length || payoffLegs.some(l => l.premium <= 0)) return null;
    const strikes = payoffLegs.map(l => l.strike);
    const center = spot > 0 ? spot : (Math.min(...strikes) + Math.max(...strikes)) / 2;
    const lo = Math.min(Math.min(...strikes) - 6 * step, center * 0.94);
    const hi = Math.max(Math.max(...strikes) + 6 * step, center * 1.06);
    return computePayoff(payoffLegs, lo, hi);
  }, [payoffLegs, spot, step]);

  const riskReward = useMemo(() => {
    if (!payoff || payoff.maxProfitUnlimited || payoff.maxLossUnlimited) return null;
    if (payoff.maxLoss >= 0) return null;
    return payoff.maxProfit / Math.abs(payoff.maxLoss);
  }, [payoff]);

  const daysLeft = useMemo(() => (expiry ? daysToExpiry(expiry) : null), [expiry]);

  // ── Order placement ─────────────────────────────────────────────
  const placeBasket = useCallback(async () => {
    if (!legs.length || !expiry) return;
    if (!confirmPlace) {
      setConfirmPlace(true);
      setTimeout(() => setConfirmPlace(false), 4000);
      return;
    }
    setConfirmPlace(false);
    if (placingRef.current) return;

    for (const leg of legs) {
      if (leg.type === 'LIMIT' && effectivePremium(leg) <= 0) {
        addToast('error', 'Invalid limit price', `${leg.side === 'B' ? 'Buy' : 'Sell'} ${leg.strike} ${leg.option}`);
        return;
      }
    }

    placingRef.current = true;
    setPlacing(true);

    const ordered = sortLegsForPlacement(legs);
    let placedCount = 0;
    try {
      for (const leg of ordered) {
        const label = `${leg.side === 'B' ? 'BUY' : 'SELL'} ${leg.strike} ${leg.option}`;
        const qty = leg.lots * multiplier * lotSize;
        const price = leg.type === 'LIMIT' ? effectivePremium(leg) : undefined;

        const req = resolveOrderRequest(broker, { side: leg.side, option: leg.option, strike: leg.strike, qty, type: leg.type, price, underlying }, strikeMap);
        if (!req) {
          addToast('error', `${label} — no order identifier resolved`, 'Strike lookup not ready yet — basket stopped');
          return;
        }

        try {
          const res = await fetch(req.url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(req.body),
          });
          const j = await res.json() as { success: boolean; order_id?: string; error?: string };
          if (j.success) {
            placedCount += 1;
            addToast('success', `${label} placed`, `ID: ${j.order_id}`);
          } else {
            addToast('error', `${label} failed — basket stopped`, j.error ?? 'Unknown error');
            return;
          }
        } catch (e) {
          addToast('error', `${label} UNCONFIRMED — basket stopped`, `Check Orders before retrying: ${String(e)}`);
          return;
        }
      }
      addToast('success', `Basket complete: ${placedCount}/${legs.length} legs placed`);
    } finally {
      placingRef.current = false;
      setPlacing(false);
    }
  }, [legs, expiry, confirmPlace, multiplier, lotSize, strikeMap, broker, effectivePremium, addToast]);

  // ── Save / load ───────────────────────────────────────────────
  const persistSaved = (next: SavedBasket[]) => {
    setSaved(next);
    persistSavedBaskets(next);
  };

  const saveBasket = () => {
    const name = saveName.trim();
    if (!name || !legs.length) {
      addToast('error', !legs.length ? 'Nothing to save — add legs first' : 'Enter a basket name');
      return;
    }
    if (atmStrike == null) {
      addToast('error', 'Cannot save yet', 'Wait for the option chain to load so ATM is known');
      return;
    }
    const isUpdate = saved.some(s => s.name === name);
    const entry: SavedBasket = {
      name, category, strategy, multiplier, underlying,
      legs: legs.map(({ side, option, strike, lots, type }) => ({
        side, option, lots, type, offset: legToOffset(strike, atmStrike, step),
      })),
    };
    persistSaved([...saved.filter(s => s.name !== name), entry]);
    setSaveName('');
    addToast('success', isUpdate ? `Basket "${name}" updated` : `Basket "${name}" saved`);
  };

  // Holds a basket whose underlying didn't match the current selection at the
  // moment Load was clicked. The effect below finishes applying it once the
  // newly-selected underlying's chain (atmStrike/allStrikes) is ready — the
  // user clicks Load once, even across an underlying switch.
  const pendingLoadRef = useRef<SavedBasket | null>(null);

  const applyLoadedBasket = useCallback((b: SavedBasket, atm: number, strikes: number[]) => {
    setCategory(b.category);
    setStrategy(b.strategy);
    setMultiplier(b.multiplier);
    setLegs(b.legs.map(l => ({
      id: newLegId(),
      side: l.side, option: l.option, lots: l.lots, type: l.type,
      strike: offsetToStrike(l.offset, atm, strikes, step),
      price: '',
    })));
    setSaveOpen(false);
    addToast('success', `Basket "${b.name}" loaded`, `Re-anchored to current ATM ${atm}`);
  }, [step, addToast]);

  const loadBasket = (b: SavedBasket) => {
    if (b.underlying !== underlying) {
      pendingLoadRef.current = b;
      setUnderlying(b.underlying as Underlying);
      addToast('success', `Switched underlying to ${b.underlying}`, `Loading basket "${b.name}" once its chain is ready`);
      return;
    }
    if (atmStrike == null || !allStrikes.length) {
      addToast('error', 'Chain not loaded yet', 'Wait for strikes to load, then load the basket');
      return;
    }
    applyLoadedBasket(b, atmStrike, allStrikes);
  };

  // Completes a cross-underlying load once the new underlying's chain settles.
  // Gated on chainReadyForRef (not just atmStrike/allStrikes being non-empty):
  // on the render where `underlying` flips, allStrikes/atmStrike can still
  // hold the PREVIOUS underlying's non-null values (the per-expiry effect's
  // reset only lands on the next render), so a null-check alone would
  // re-anchor the basket to the wrong underlying's strikes. chainReadyForRef
  // is a ref (mutates synchronously, no extra render needed) that's cleared
  // at the top of that same effect and only re-armed once the chain fetch
  // for the *current* underlying+expiry has actually resolved.
  useEffect(() => {
    const pending = pendingLoadRef.current;
    if (!pending || pending.underlying !== underlying) return;
    if (atmStrike == null || !allStrikes.length) return;
    const ready = chainReadyForRef.current;
    if (!ready || ready.underlying !== underlying || ready.expiry !== expiry) return;
    pendingLoadRef.current = null;
    applyLoadedBasket(pending, atmStrike, allStrikes);
  }, [underlying, expiry, atmStrike, allStrikes, applyLoadedBasket]);

  const totalQty = legs.reduce((s, l) => s + l.lots, 0) * multiplier;

  // ── Render ──────────────────────────────────────────────────────
  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white">
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-4 py-3 rounded-xl border text-sm font-semibold shadow-2xl max-w-xs ${
            t.type === 'success' ? 'bg-emerald-900/95 border-emerald-500/40 text-emerald-200' : 'bg-rose-900/95 border-rose-500/40 text-rose-200'
          }`}>
            <p>{t.message}</p>
            {t.detail && <p className="text-xs opacity-70 mt-0.5 font-mono">{t.detail}</p>}
          </div>
        ))}
      </div>

      <div className="sticky top-0 z-10 border-b border-zinc-800 bg-zinc-950/95 backdrop-blur px-4 py-2">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-3">
            <h1 className="text-sm font-bold text-white tracking-tight flex items-center gap-1.5">
              <ShoppingBasket className="w-3.5 h-3.5 text-emerald-400" />
              BASKETS
            </h1>
            <NavBar />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <select value={underlying} onChange={e => setUnderlying(e.target.value as Underlying)}
              className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500">
              {UNDERLYINGS.map(u => <option key={u} value={u}>{u}</option>)}
            </select>

            {authenticatedBrokers.length > 1 && (
              <select value={broker} onChange={e => setBroker(e.target.value as 'dhan' | 'zerodha')}
                className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500">
                {authenticatedBrokers.map(b => <option key={b} value={b}>{b === 'dhan' ? 'Dhan' : 'Zerodha'}</option>)}
              </select>
            )}

            <select value={expiry} onChange={e => setExpiry(e.target.value)}
              className="h-8 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-semibold rounded-lg px-2.5 focus:outline-none focus:border-emerald-500">
              {expiries.map(ex => <option key={ex} value={ex}>{ex}</option>)}
            </select>

            <div className="flex items-center gap-2 h-8 bg-zinc-900 border border-zinc-700 rounded-lg px-2">
              <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider">Multiplier</span>
              <div className="inline-flex items-center rounded-lg border border-zinc-800 bg-zinc-950/60 overflow-hidden">
                <button onClick={() => setMultiplier(m => Math.max(1, m - 1))}
                  className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                  <span className="text-xs font-bold">−</span>
                </button>
                <span className="font-mono font-bold text-xs tabular-nums text-center px-1 w-5 inline-block">{multiplier}</span>
                <button onClick={() => setMultiplier(m => Math.min(20, m + 1))}
                  className="w-7 h-7 flex items-center justify-center text-zinc-500 hover:text-zinc-200 hover:bg-zinc-800 transition-colors">
                  <span className="text-xs font-bold">+</span>
                </button>
              </div>
            </div>

            <div className="flex items-center gap-1.5">
              <span className={`w-2 h-2 rounded-full ${
                bridgeStatus.status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
                bridgeStatus.status === 'STARTING' ? 'bg-yellow-400 animate-pulse'  :
                bridgeStatus.status === 'ERROR'    ? 'bg-rose-400'                  : 'bg-zinc-600'
              }`} />
              <span className={`text-[9px] font-bold px-1 py-0.5 rounded border ${
                transport === 'ws' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20' : 'bg-zinc-800 text-zinc-500 border-zinc-700'
              }`}>
                {transport === 'ws' ? 'WS' : 'HTTP'}
              </span>
              {lastUpdated && <span className="text-[10px] text-zinc-500 font-mono">{lastUpdated}</span>}
            </div>

            {spot > 0 && (
              <span className="h-8 flex items-center px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200">
                {underlying}&nbsp;{spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
            )}

            {fundsData && Number.isFinite(Number(fundsData.availabelBalance)) && (
              <span className="h-8 flex items-center gap-1.5 px-2.5 rounded-lg text-xs font-bold font-mono tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200">
                <Wallet className="w-3 h-3 text-sky-400" />
                Rs. {formatFundsValue(Number(fundsData.availabelBalance))}
              </span>
            )}
          </div>
        </div>

        <div className="mt-2 pt-2 border-t border-zinc-800">
          <StrategyCardGrid
            category={category}
            onCategoryChange={setCategory}
            selectedKey={strategy}
            onSelectTemplate={applyTemplate}
            disabled={atmStrike == null}
          />
        </div>
      </div>

      <div className="flex-1 grid grid-cols-1 xl:grid-cols-2 gap-4 p-4 items-start">
        <Card className="overflow-hidden">
          <LegsTable
            legs={legs}
            atmStrike={atmStrike}
            allStrikes={allStrikes}
            autoPremium={autoPremium}
            onUpdateLeg={updateLeg}
            onStepStrike={stepStrike}
            onAddLeg={addLeg}
            onRemoveLeg={removeLeg}
            onClearAll={() => { setLegs([]); setStrategy(null); }}
          />

          <div className="flex items-center gap-2 px-4 py-2 border-t border-zinc-800 bg-zinc-900/40 flex-wrap">
            <SavedBasketsPanel
              saveName={saveName}
              onSaveNameChange={setSaveName}
              onSave={saveBasket}
              saved={saved}
              open={saveOpen}
              onToggleOpen={() => setSaveOpen(o => !o)}
              onLoad={loadBasket}
              onDelete={name => persistSaved(saved.filter(s => s.name !== name))}
            />
          </div>

          {legs.length > 0 && (
            <div className="flex items-center gap-3 px-4 py-3 border-t border-zinc-800 bg-zinc-950/30 flex-wrap">
              <Button onClick={placeBasket} disabled={placing}
                className={`${confirmPlace ? 'animate-pulse' : ''}`}>
                {placing ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <ShoppingBasket className="w-3.5 h-3.5" />}
                {placing ? 'Placing…' : confirmPlace ? `Confirm ${legs.length} legs ×${multiplier}?` : 'Place Basket'}
              </Button>
              <Button size="sm" variant="outline" disabled={placing}
                onClick={() => { setLegs([]); setStrategy(null); setConfirmPlace(false); }}
                className="h-9 px-3 text-[11px] border-rose-500/40 text-rose-400 hover:bg-rose-500/10 hover:text-rose-300 hover:border-rose-400/60 transition-all">
                Clear All
              </Button>
              <div className="ml-auto text-[11px] text-zinc-500 leading-snug text-right">
                <p className="font-semibold text-zinc-400">{totalQty} lots · {totalQty * lotSize} qty total</p>
                <p>Buys placed before sells · {lotSize} qty per lot</p>
              </div>
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="px-4 py-3 border-b border-zinc-800 bg-zinc-900/40 flex items-baseline justify-between">
            <span className="text-xs font-bold text-zinc-300 uppercase tracking-widest">Payoff at Expiry</span>
            <span className="text-[10px] text-zinc-500">premiums from live LTP — override in the Price column</span>
          </div>

          <div className="grid grid-cols-3 divide-x divide-zinc-800 border-b border-zinc-800">
            <MetricTile label="Net Premium"
              tone={!payoff ? 'neutral' : payoff.netPremium >= 0 ? 'profit' : 'loss'}
              value={payoff ? `${payoff.netPremium >= 0 ? 'Credit' : 'Debit'} ${fmtMoney(payoff.netPremium)}` : '—'} />
            <MetricTile label="Max Profit" tone="profit"
              value={!payoff ? '—' : payoff.maxProfitUnlimited ? 'Unlimited' : fmtMoney(payoff.maxProfit)} />
            <MetricTile label="Max Loss" tone="loss"
              value={!payoff ? '—' : payoff.maxLossUnlimited ? 'Unlimited' : fmtMoney(payoff.maxLoss)} />
          </div>
          <div className="grid grid-cols-3 divide-x divide-zinc-800 border-b border-zinc-800">
            <MetricTile label="Breakeven"
              value={payoff && payoff.breakevens.length
                ? payoff.breakevens.map(b => b.toLocaleString('en-IN', { maximumFractionDigits: 1 })).join(' / ')
                : '—'} />
            <MetricTile label="Risk : Reward"
              value={riskReward != null ? `1 : ${riskReward.toFixed(2)}` : '—'} />
            <MetricTile label="Days Left" value={daysLeft ?? '—'} />
          </div>

          <div className="p-4">
            <BasketPayoffChart
              points={payoff?.points ?? []}
              breakevens={payoff?.breakevens ?? []}
              spot={spot}
            />
            <p className="text-[10px] text-zinc-600 mt-2">
              Expiry payoff only (no T+0 curve) · margin calculation not available from broker
            </p>
          </div>
        </Card>
      </div>
    </div>
  );
}
