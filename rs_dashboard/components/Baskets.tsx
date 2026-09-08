'use client';

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import NavBar from './NavBar';
import {
  ShoppingBasket, RefreshCw, Wallet, Clock, Layers, SlidersHorizontal,
  TrendingUp
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { formatFundsValue, type ChainOcEntry, type Toast } from './Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector, scalperRoute, BROKER_LABELS, type Broker } from '@/hooks/useBrokerSelector';
import {
  STRATEGY_CATEGORIES, type StrategyCategory, type StrategyTemplate,
  type BasketLeg, type OptionType, type PayoffLeg,
  computePayoff, nearestStrike, strikeStep, daysToExpiry,
} from '@/lib/basketStrategies';
import {
  type SavedBasket, loadSavedBaskets, persistSavedBaskets, legToOffset, offsetToStrike,
} from '@/lib/basketStorage';
import { sortLegsForPlacement, resolveOrderRequest, type StrikeIdentifier } from '@/lib/basketOrders';
import { useCopyTrade, CopyTradeControls } from './CopyTrade';
import BasketPayoffChart from './BasketPayoffChart';
import StrategyCardGrid from './basket/StrategyCardGrid';
import LegsTable from './basket/LegsTable';
import SavedBasketsPanel from './basket/SavedBasketsPanel';
import BasketActivityTabs from './basket/BasketActivityTabs';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX'] as const;
type Underlying = typeof UNDERLYINGS[number];

function fmtMoney(n: number): string {
  return `₹${Math.abs(n).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function TerminalPanel({
  title,
  icon: Icon,
  meta,
  badge,
  action,
  children,
  className = '',
}: {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  meta?: React.ReactNode;
  badge?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={`flex flex-col rounded-xl border border-zinc-800 bg-zinc-900/70 shadow-sm overflow-hidden ${className}`}>
      <header className="flex items-center justify-between gap-3 border-b border-amber-500/25 bg-zinc-950/60 px-3.5 py-2.5 shrink-0">
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-[0.16em] text-amber-400">
            <Icon className="h-3.5 w-3.5 text-amber-400" />
            {title}
          </span>
          {badge}
        </div>
        <div className="flex items-center gap-2">
          {action}
          {meta ? <div className="font-mono text-[11px] text-zinc-400">{meta}</div> : null}
        </div>
      </header>
      <div className="flex-1 min-h-0">{children}</div>
    </section>
  );
}

function StatTile({
  label,
  value,
  sub,
  progress,
  tone = 'neutral',
  tooltip,
}: {
  label: string;
  value: string;
  sub?: string;
  progress?: { percent: number; colorClass?: string };
  tone?: 'neutral' | 'up' | 'down' | 'accent';
  tooltip?: string;
}) {
  const valueClass =
    tone === 'up' ? 'text-emerald-400'
    : tone === 'down' ? 'text-red-400'
    : tone === 'accent' ? 'text-amber-400'
    : 'text-zinc-100';

  return (
    <div
      title={tooltip}
      className="flex flex-col justify-between gap-1.5 rounded-lg border border-zinc-800 bg-zinc-950 px-3 py-2.5 transition-colors hover:border-zinc-700"
    >
      <div className="flex items-center justify-between">
        <span className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">{label}</span>
        {progress && (
          <span className="font-mono text-[9px] font-semibold text-zinc-400">
            {progress.percent.toFixed(1)}%
          </span>
        )}
      </div>

      <div className={`font-mono text-base font-bold leading-none tabular-nums ${valueClass}`}>
        {value}
      </div>

      {progress && (
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-zinc-800">
          <div
            className={`h-full transition-all duration-500 ${progress.colorClass ?? 'bg-amber-400'}`}
            style={{ width: `${Math.min(Math.max(progress.percent, 0), 100)}%` }}
          />
        </div>
      )}

      {sub ? <span className="font-mono text-[10px] text-zinc-500 truncate">{sub}</span> : null}
    </div>
  );
}

function getMarketSessionInfo() {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 3600000);
  const day = ist.getDay(); 
  const hour = ist.getHours();
  const minute = ist.getMinutes();
  const timeNum = hour * 60 + minute;

  const isWeekend = day === 0 || day === 6;
  if (isWeekend) {
    return { status: 'CLOSED', label: 'WEEKEND CLOSED', tone: 'neutral' as const };
  }
  if (timeNum >= 540 && timeNum < 555) {
    return { status: 'PRE-OPEN', label: 'PRE-OPEN SESSION', tone: 'accent' as const };
  }
  if (timeNum >= 555 && timeNum <= 930) {
    return { status: 'OPEN', label: 'MARKET LIVE', tone: 'live' as const };
  }
  if (timeNum > 930 && timeNum <= 940) {
    return { status: 'POST', label: 'POST-CLOSING', tone: 'neutral' as const };
  }
  return { status: 'EOD', label: 'AFTER-HOURS / EOD', tone: 'neutral' as const };
}

function getVixRegime(vix: number | null | undefined) {
  if (!vix || vix <= 0) {
    return { label: 'NORMAL VOL', regime: 'EQUILIBRIUM', tone: 'neutral' as const };
  }
  if (vix < 12.0) {
    return { label: 'LOW VOL', regime: 'THETA HARVEST', tone: 'emerald' as const };
  }
  if (vix <= 16.0) {
    return { label: 'NORMAL VOL', regime: 'BALANCED', tone: 'amber' as const };
  }
  return { label: 'HIGH VOL', regime: 'EXPANSION', tone: 'red' as const };
}

export default function Baskets() {
  const { broker, setBroker, authenticatedBrokers, hasAuthenticatedBroker, authChecked } = useBrokerSelector();
  const [underlying, setUnderlying] = useState<Underlying>('NIFTY');

  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry]     = useState('');
  const [farExpiry, setFarExpiry] = useState('');

  const [allStrikes, setAllStrikes] = useState<number[]>([]);
  const [prevClose, setPrevClose]   = useState<Record<string, { ce: number; pe: number }>>({});
  const [chainSpot, setChainSpot]   = useState(0);
  const [strikeMap, setStrikeMap]   = useState<Record<string, StrikeIdentifier>>({});
  const [farStrikeMap, setFarStrikeMap] = useState<Record<string, StrikeIdentifier>>({});
  const [lotSize, setLotSize]       = useState<number | null>(null);

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

  const [clock, setClock] = useState('');
  useEffect(() => {
    const update = () => {
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const ist = new Date(utc + 5.5 * 3600000);
      setClock(ist.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, []);

  const marketSession = getMarketSessionInfo();

  const [vixData, setVixData] = useState<{ vix: number; prevClose: number } | null>(null);
  useEffect(() => {
    const pollVix = () => {
      fetch('/api/scalper/vix').then(r => r.json()).then((j: { success: boolean; vix?: number; prevClose?: number }) => {
        if (j.success && j.vix !== undefined && j.prevClose !== undefined) setVixData({ vix: j.vix, prevClose: j.prevClose });
      }).catch(() => {});
    };
    pollVix();
    const interval = setInterval(pollVix, 60_000);
    return () => clearInterval(interval);
  }, []);

  const liveVix = liveQuotes?.vix;
  const currentVix = (liveVix && liveVix.ltp > 0) ? liveVix.ltp : (vixData?.vix ?? 0);
  const currentVixPrevClose = (liveVix && (liveVix.prev_close ?? 0) > 0) ? liveVix.prev_close! : (vixData?.prevClose ?? 0);
  const vixChange = (liveVix && liveVix.change !== undefined && liveVix.change !== 0) ? liveVix.change : (currentVix > 0 && currentVixPrevClose > 0 ? currentVix - currentVixPrevClose : 0);
  const vixChangePct = (liveVix && liveVix.change_pct !== undefined && liveVix.change_pct !== 0) ? liveVix.change_pct : (currentVixPrevClose > 0 ? (vixChange / currentVixPrevClose) * 100 : 0);
  const vixRegime = getVixRegime(currentVix);

  const spotChange = liveQuotes?.spot_change ?? 0;
  const spotChangePct = liveQuotes?.spot_change_pct ?? 0;

  const legCounterRef  = useRef(0);
  const placingRef     = useRef(false);
  const expiryRef      = useRef('');
  useEffect(() => { expiryRef.current = expiry; }, [expiry]);
  const farExpiryRef  = useRef('');
  useEffect(() => { farExpiryRef.current = farExpiry; }, [farExpiry]);
  const underlyingRef  = useRef<Underlying>(underlying);
  useEffect(() => { underlyingRef.current = underlying; }, [underlying]);
  const chainReadyForRef = useRef<{ underlying: string; expiry: string } | null>(null);

  const spot = liveQuotes?.spot ?? chainSpot;
  const step = useMemo(() => strikeStep(allStrikes), [allStrikes]);
  const atmStrike = useMemo(() => (spot > 0 ? nearestStrike(allStrikes, spot) : null), [allStrikes, spot]);

  const addToast = useCallback((type: 'success' | 'error', message: string, detail?: string) => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts(prev => [...prev, { id, type, message, detail }]);
    setTimeout(() => setToasts(prev => prev.filter(t => t.id !== id)), type === 'error' ? 7000 : 3000);
  }, []);

  const copyTrade = useCopyTrade(addToast);

  useEffect(() => { loadSavedBaskets().then(setSaved); }, []);

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

  useEffect(() => {
    if (!expiries.length) return;
    setFarExpiry(prev => (prev && prev !== expiry && expiries.includes(prev)) ? prev : (expiries.find(e => e !== expiry) ?? expiry));
  }, [expiries, expiry]);

  useEffect(() => {
    if (!farExpiry || farExpiry === expiry) { setFarStrikeMap({}); return; }
    fetch(`${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${farExpiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { strikes: Record<string, StrikeIdentifier> } }) => {
        if (j.success && j.data) setFarStrikeMap(j.data.strikes);
      })
      .catch(() => {});
  }, [farExpiry, expiry, underlying, broker]);

  useEffect(() => {
    fetch(scalperRoute(broker, 'funds'))
      .then(r => r.json())
      .then((j: { success: boolean; data?: Record<string, number> }) => setFundsData(j.success ? (j.data ?? null) : null))
      .catch(() => setFundsData(null));
  }, [broker]);

  const authenticatedBrokersKey = authenticatedBrokers.join(',');
  useEffect(() => {
    if (!expiry) return;
    chainReadyForRef.current = null;
    setLegs([]); setStrategy(null); setAllStrikes([]); setPrevClose({}); setStrikeMap({}); setChainSpot(0);

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
          pc[String(Number(sk))] = {
            ce: entry.ce?.previous_close_price ?? entry.ce?.previous_close ?? 0,
            pe: entry.pe?.previous_close_price ?? entry.pe?.previous_close ?? 0,
          };
        }
        setPrevClose(pc);
        if ((j.data.spot ?? 0) > 0) setChainSpot(j.data.spot);
        chainReadyForRef.current = { underlying: requestedUnderlying, expiry: requestedExpiryForChain };
      })
      .catch(() => {});

    fetch(`${scalperRoute(broker, 'lookup')}?underlying=${underlying}&expiry=${expiry}`)
      .then(r => r.json())
      .then((j: { success: boolean; data?: { lotSize: number; strikes: Record<string, StrikeIdentifier> } }) => {
        if (j.success && j.data) {
          setStrikeMap(j.data.strikes);
          setLotSize(Number(j.data.lotSize) > 0 ? Number(j.data.lotSize) : null);
        }
      })
      .catch(() => {});

    const brokers = authenticatedBrokersKey.split(',').filter(Boolean);
    for (const b of brokers) {
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
        body: JSON.stringify({ action: 'stop', brokers }),
      }).catch(() => {});
    };
  }, [expiry, underlying, authenticatedBrokersKey, broker]);

  useEffect(() => {
    const farLegs = legs.filter(l => l.expiry && l.expiry !== expiry);
    if (!farLegs.length) return;
    const requests = farLegs.map(l => ({ underlying, expiry: l.expiry, strike: l.strike, side: l.option }));
    fetch('/api/options/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'watchExtra', underlying, requests }),
    }).catch(() => {});
  }, [legs, expiry, underlying]);

  const autoPremium = useCallback((strike: number, option: OptionType, legExpiry?: string): number => {
    const key = String(strike);
    const side = option === 'CE' ? 'ce' : 'pe';
    if (legExpiry != null && legExpiry !== expiry) {
      const extraLtp = liveQuotes?.extra?.[legExpiry]?.[key]?.[side]?.ltp ?? 0;
      return extraLtp > 0 ? extraLtp : 0;
    }
    const live = liveQuotes?.strikes?.[key]?.[side]?.ltp ?? 0;
    return live > 0 ? live : (prevClose[key]?.[side] ?? 0);
  }, [liveQuotes, prevClose, expiry]);

  const effectivePremium = useCallback((leg: BasketLeg): number => {
    const manual = Number(leg.price);
    if (leg.price.trim() !== '' && !isNaN(manual) && manual > 0) return manual;
    return autoPremium(leg.strike, leg.option, leg.expiry);
  }, [autoPremium]);

  const newLegId = () => `leg-${++legCounterRef.current}`;
  const applyTemplate = useCallback((tpl: StrategyTemplate) => {
    if (atmStrike == null || !allStrikes.length) {
      addToast('error', 'Option chain still initializing');
      return;
    }
    if (tpl.legs.some(l => l.expiryRole === 'far') && (!farExpiry || farExpiry === expiry)) {
      addToast('error', 'Secondary expiry required');
      return;
    }
    setStrategy(tpl.key);
    setLegs(tpl.legs.map(l => {
      const target = atmStrike + l.offset * step;
      const strike = nearestStrike(allStrikes, target) ?? atmStrike;
      const legExpiry = l.expiryRole === 'far' ? farExpiry : expiry;
      return { id: newLegId(), side: l.side, option: l.option, strike, lots: l.ratio, type: 'MARKET' as const, price: '', expiry: legExpiry };
    }));
  }, [atmStrike, allStrikes, step, expiry, farExpiry, addToast]);

  const updateLeg = useCallback((id: string, patch: Partial<BasketLeg>) => {
    setLegs(prev => prev.map(l => (l.id === id ? { ...l, ...patch } : l)));
  }, []);

  const nextAvailableStrike = useCallback((
    fromStrike: number, dir: 1 | -1, option: OptionType, side: BasketLeg['side'], excludeId: string | null, currentLegs: BasketLeg[],
  ): number | null => {
    const occupied = new Set(currentLegs.filter(l => l.id !== excludeId && l.option === option && l.side === side).map(l => l.strike));
    const idx = allStrikes.indexOf(fromStrike);
    if (idx < 0) return occupied.has(fromStrike) ? null : fromStrike;
    let nextIdx = idx + dir;
    while (nextIdx >= 0 && nextIdx < allStrikes.length && occupied.has(allStrikes[nextIdx])) nextIdx += dir;
    return (nextIdx < 0 || nextIdx >= allStrikes.length) ? null : allStrikes[nextIdx];
  }, [allStrikes]);

  const stepStrike = useCallback((id: string, dir: 1 | -1) => {
    setLegs(prev => {
      const leg = prev.find(l => l.id === id);
      if (!leg) return prev;
      const nextStrike = nextAvailableStrike(leg.strike, dir, leg.option, leg.side, id, prev);
      return nextStrike == null ? prev : prev.map(l => (l.id === id ? { ...l, strike: nextStrike, price: '' } : l));
    });
  }, [nextAvailableStrike]);

  const addLeg = useCallback(() => {
    if (atmStrike == null) { addToast('error', 'Option chain loading'); return; }
    setLegs(prev => {
      const occupied = new Set(prev.filter(l => l.option === 'CE' && l.side === 'B').map(l => l.strike));
      let strike = atmStrike;
      if (occupied.has(strike)) {
        const atmIdx = allStrikes.indexOf(atmStrike);
        let found: number | null = null;
        for (let d = 1; atmIdx >= 0 && d < allStrikes.length; d++) {
          const up = allStrikes[atmIdx + d];
          const down = allStrikes[atmIdx - d];
          if (up !== undefined && !occupied.has(up)) { found = up; break; }
          if (down !== undefined && !occupied.has(down)) { found = down; break; }
          if (up === undefined && down === undefined) break;
        }
        if (found != null) strike = found;
      }
      return [...prev, { id: newLegId(), side: 'B', option: 'CE', strike, lots: 1, type: 'MARKET', price: '', expiry }];
    });
  }, [atmStrike, allStrikes, expiry, addToast]);

  const removeLeg = useCallback((id: string) => { setLegs(prev => prev.filter(l => l.id !== id)); }, []);

  const addLegFromPosition = useCallback((pos: Record<string, unknown>) => {
    const sym = String(pos.tradingSymbol ?? '');
    let match: { strike: number; option: OptionType } | null = null;
    for (const [strikeStr, entry] of Object.entries(strikeMap)) {
      if (entry.ceSymbol === sym) { match = { strike: Number(strikeStr), option: 'CE' }; break; }
      if (entry.peSymbol === sym) { match = { strike: Number(strikeStr), option: 'PE' }; break; }
    }
    if (!match) { addToast('error', 'Could not resolve position strike', sym); return; }
    const netQty = Number(pos.netQty) || 0;
    const side = netQty < 0 ? 'S' : 'B';
    setLegs(prev => [...prev, { id: newLegId(), side, option: match!.option, strike: match!.strike, lots: 1, type: 'MARKET', price: '', expiry }]);
    addToast('success', `Staged ${side === 'S' ? 'Sell' : 'Buy'} ${match.option} ${match.strike} leg`);
  }, [strikeMap, expiry, addToast]);

  const payoffLegs = useMemo<PayoffLeg[]>(() => (lotSize ? legs.map(l => ({
    side: l.side, option: l.option, strike: l.strike,
    premium: effectivePremium(l), qty: l.lots * multiplier * lotSize,
  })) : []), [legs, multiplier, lotSize, effectivePremium]);

  const hasMixedExpiry = useMemo(() => legs.some(l => l.expiry !== expiry), [legs, expiry]);
  const payoff = useMemo(() => {
    if (hasMixedExpiry || !payoffLegs.length || payoffLegs.some(l => l.premium <= 0)) return null;
    const strikes = payoffLegs.map(l => l.strike);
    const center = spot > 0 ? spot : (Math.min(...strikes) + Math.max(...strikes)) / 2;
    const lo = Math.min(Math.min(...strikes) - 6 * step, center * 0.94);
    const hi = Math.max(Math.max(...strikes) + 6 * step, center * 1.06);
    return computePayoff(payoffLegs, lo, hi);
  }, [payoffLegs, spot, step, hasMixedExpiry]);

  const riskReward = useMemo(() => {
    if (!payoff || payoff.maxProfitUnlimited || payoff.maxLossUnlimited || payoff.maxLoss >= 0) return null;
    return payoff.maxProfit / Math.abs(payoff.maxLoss);
  }, [payoff]);

  const daysLeft = useMemo(() => (expiry ? daysToExpiry(expiry) : null), [expiry]);
  const premiumsUnavailable = legs.length > 0 && legs.every(l => effectivePremium(l) <= 0);

  type PlacedLeg = { label: string; side: 'B' | 'S'; option: OptionType; strike: number; qty: number; expiry: string };
  const rollbackPlacedLegs = useCallback(async (placed: PlacedLeg[]) => {
    if (!placed.length) return;
    for (const p of [...placed].reverse()) {
      const reverseReq = resolveOrderRequest(broker, {
        side: p.side === 'B' ? 'S' : 'B', option: p.option, strike: p.strike, qty: p.qty, type: 'MARKET', underlying,
        productType: 'MARGIN',
      }, p.expiry === farExpiry ? farStrikeMap : strikeMap);
      if (reverseReq) fetch(reverseReq.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(reverseReq.body) }).catch(() => {});
    }
  }, [broker, strikeMap, farStrikeMap, farExpiry, underlying]);

  const placeBasket = useCallback(async () => {
    if (!legs.length || !expiry || !hasAuthenticatedBroker || !lotSize) return;
    if (!confirmPlace) { setConfirmPlace(true); setTimeout(() => setConfirmPlace(false), 4500); return; }
    setConfirmPlace(false);
    if (placingRef.current) return;
    for (const leg of legs) {
      if (leg.type === 'LIMIT' && effectivePremium(leg) <= 0) { addToast('error', 'Invalid limit price'); return; }
    }
    placingRef.current = true; setPlacing(true);
    const ordered = sortLegsForPlacement(legs);
    const placedLegs: PlacedLeg[] = [];
    try {
      for (const leg of ordered) {
        const qty = leg.lots * multiplier * lotSize;
        const req = resolveOrderRequest(broker, { side: leg.side, option: leg.option, strike: leg.strike, qty, type: leg.type, price: leg.type === 'LIMIT' ? effectivePremium(leg) : undefined, underlying, productType: 'MARGIN' }, leg.expiry === farExpiry ? farStrikeMap : strikeMap);
        if (!req) { await rollbackPlacedLegs(placedLegs); return; }
        const res = await fetch(req.url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(req.body) });
        const j = await res.json() as { success: boolean; order_id?: string; error?: string };
        if (j.success) placedLegs.push({ label: `${leg.side} ${leg.strike}`, side: leg.side, option: leg.option, strike: leg.strike, qty, expiry: leg.expiry });
        else { await rollbackPlacedLegs(placedLegs); return; }
      }
      addToast('success', `Basket complete: ${placedLegs.length}/${legs.length} legs transmitted`);
    } finally { placingRef.current = false; setPlacing(false); }
  }, [legs, expiry, farExpiry, confirmPlace, multiplier, lotSize, strikeMap, farStrikeMap, broker, underlying, effectivePremium, addToast, hasAuthenticatedBroker, rollbackPlacedLegs]);

  const persistSaved = (next: SavedBasket[]) => { setSaved(next); persistSavedBaskets(next).catch(() => {}); };
  const saveBasket = () => {
    const name = saveName.trim();
    if (!name || !legs.length || atmStrike == null) return;
    const entry: SavedBasket = {
      name, category, strategy, multiplier, underlying,
      legs: legs.map(({ side, option, strike, lots, type, expiry: legExpiry }) => ({
        side, option, lots, type, offset: legToOffset(strike, atmStrike, step),
        ...(legExpiry === farExpiry && farExpiry !== expiry ? { expiryRole: 'far' as const } : {}),
      })),
    };
    persistSaved([...saved.filter(s => s.name !== name), entry]);
    setSaveName(name);
    addToast('success', `Preset "${name}" saved`);
  };

  const pendingLoadRef = useRef<SavedBasket | null>(null);
  const applyLoadedBasket = useCallback((b: SavedBasket, atm: number, strikes: number[]) => {
    setCategory(b.category); setStrategy(b.strategy); setMultiplier(b.multiplier);
    setLegs(b.legs.map(l => ({
      id: newLegId(), side: l.side, option: l.option, lots: l.lots, type: l.type,
      strike: offsetToStrike(l.offset, atm, strikes, step), price: '',
      expiry: l.expiryRole === 'far' ? (farExpiryRef.current || expiryRef.current) : expiryRef.current,
    })));
    setSaveOpen(false); setSaveName(b.name);
  }, [step]);

  const loadBasket = (b: SavedBasket) => {
    if (b.underlying !== underlying) { pendingLoadRef.current = b; setUnderlying(b.underlying as Underlying); return; }
    if (atmStrike == null || !allStrikes.length) return;
    applyLoadedBasket(b, atmStrike, allStrikes);
  };

  useEffect(() => {
    const pending = pendingLoadRef.current;
    if (pending && pending.underlying === underlying && atmStrike != null && allStrikes.length && chainReadyForRef.current?.underlying === underlying) {
      pendingLoadRef.current = null; applyLoadedBasket(pending, atmStrike, allStrikes);
    }
  }, [underlying, expiry, atmStrike, allStrikes, applyLoadedBasket]);

  const totalQty = legs.reduce((s, l) => s + l.lots, 0) * multiplier;

  return (
    <div className="flex flex-col min-h-screen bg-zinc-950 text-white selection:bg-amber-500/20 selection:text-amber-300 font-sans">
      <div className="fixed top-4 right-4 z-50 flex flex-col gap-2 pointer-events-none">
        {toasts.map(t => (
          <div key={t.id} className={`pointer-events-auto px-3.5 py-2.5 rounded-xl border text-xs font-mono shadow-2xl max-w-sm backdrop-blur transition-all ${t.type === 'success' ? 'bg-zinc-950/95 border-emerald-500/40 text-emerald-300' : 'bg-zinc-950/95 border-red-500/40 text-red-300'}`}>
            <div className="flex items-center gap-2"><span className={`w-2 h-2 rounded-full shrink-0 ${t.type === 'success' ? 'bg-emerald-400' : 'bg-red-400'}`} /><p className="font-bold leading-tight">{t.message}</p></div>
          </div>
        ))}
      </div>

      {authChecked && !hasAuthenticatedBroker && (
        <div className="z-30 bg-amber-950/90 border-b border-amber-500/30 px-4 py-2 text-center">
          <p className="text-xs font-mono font-bold text-amber-300">
            NO BROKER LOGGED IN — Log in to Dhan or Zerodha to stream real-time ticks and execute orders.
          </p>
        </div>
      )}

      {/* ─── Sticky Bloomberg Terminal Header ────────────────────────── */}
      <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-3 border-b border-amber-500/20 bg-zinc-950/95 px-4 lg:px-6 py-2.5 backdrop-blur shadow-md">
        {/* Title Block */}
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-amber-500/30 bg-amber-500/10 shadow-inner">
            <ShoppingBasket className="h-5 w-5 text-amber-400" />
          </div>
          <div>
            <div className="flex items-center gap-2 mb-0.5">
              <span className="text-[10px] font-bold uppercase tracking-[0.2em] text-amber-400">
                BLOOMBERG TERMINAL · OPTIONS DESK
              </span>
              <span className="text-[10px] text-zinc-600">/</span>
              <span className="font-mono text-[9px] text-zinc-400">BASKET ARCHITECT v2.4</span>
            </div>
            <h1 className="text-sm lg:text-base font-bold leading-none tracking-tight text-white">
              Institutional Multi-Leg Basket Terminal
            </h1>
          </div>
        </div>

        {/* Telemetry Strip & Quick Controls */}
        <div className="flex flex-wrap items-center gap-2.5">
          {/* Market Session Status */}
          <div className="flex items-center gap-1.5 rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 font-mono text-[10px] font-semibold">
            <span
              className={`h-2 w-2 rounded-full ${
                marketSession.tone === 'live'
                  ? 'bg-emerald-400 animate-pulse'
                  : marketSession.tone === 'accent'
                  ? 'bg-amber-400'
                  : 'bg-zinc-500'
              }`}
            />
            <span className={marketSession.tone === 'live' ? 'text-emerald-400' : 'text-zinc-300'}>
              {marketSession.label}
            </span>
          </div>

          {/* Live IST Clock */}
          <span className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 px-2.5 py-1 font-mono text-[10px] font-bold text-amber-400 shadow-sm">
            <Clock className="h-3 w-3 text-amber-400" />
            {clock || '--:--:--'} IST
          </span>

          {/* Broker Selector */}
          {authenticatedBrokers.length > 1 && (
            <select
              value={broker}
              onChange={e => setBroker(e.target.value as Broker)}
              className="h-7 bg-zinc-900 border border-zinc-700 text-zinc-200 text-xs font-mono font-semibold rounded-md px-2 focus:outline-none focus:border-amber-500/60"
            >
              {authenticatedBrokers.map(b => (
                <option key={b} value={b}>{BROKER_LABELS[b]}</option>
              ))}
            </select>
          )}

          {/* Copy-trade controls */}
          <CopyTradeControls copyTrade={copyTrade} />

          {/* Live WebSocket / HTTP status */}
          <div className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-zinc-800 bg-zinc-900 font-mono text-[10px]">
            <span className={`w-2 h-2 rounded-full ${
              bridgeStatus.status === 'RUNNING'  ? 'bg-emerald-400 animate-pulse' :
              bridgeStatus.status === 'STARTING' ? 'bg-amber-400 animate-pulse'  :
              bridgeStatus.status === 'ERROR'    ? 'bg-red-400'                  : 'bg-zinc-600'
            }`} />
            <span className={transport === 'ws' ? 'text-emerald-400 font-bold' : 'text-zinc-400'}>
              {transport === 'ws' ? 'WS LIVE' : 'HTTP'}
            </span>
            {lastUpdated && <span className="text-zinc-500 hidden sm:inline">{lastUpdated}</span>}
          </div>

          {/* Spot Quote Chip */}
          {spot > 0 && (
            <div
              className="h-7 flex items-baseline gap-2 px-2.5 rounded-md bg-zinc-900 border border-zinc-700 font-mono tabular-nums text-xs"
              title={`${underlying} Spot from ${liveQuotes?.spot ? 'WebSocket Stream' : 'Option Chain Snapshot'}`}
            >
              <span className="text-[10px] font-bold text-amber-400 uppercase">{underlying}</span>
              <span className="font-bold text-white">
                {spot.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </span>
              {spotChange !== 0 && (
                <span className={`text-[10px] font-semibold flex items-center gap-0.5 ${spotChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  <span>{spotChange >= 0 ? '▲' : '▼'}</span>
                  <span>{Math.abs(spotChange).toFixed(1)}</span>
                  <span>({spotChange >= 0 ? '+' : ''}{spotChangePct.toFixed(2)}%)</span>
                </span>
              )}
            </div>
          )}

          {/* VIX Chip */}
          {currentVix > 0 && (
            <div
              className="h-7 flex items-center gap-1.5 px-2.5 rounded-md bg-zinc-900 border border-zinc-700 font-mono tabular-nums text-xs"
              title={`India VIX · Previous Close: ${currentVixPrevClose > 0 ? currentVixPrevClose.toFixed(2) : '—'}`}
            >
              <span className="text-[10px] font-bold text-zinc-400">VIX</span>
              <span className="font-bold text-white">{currentVix.toFixed(2)}</span>
              {vixChange !== 0 && (
                <span className={`text-[10px] font-semibold ${vixChange >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  ({vixChange >= 0 ? '+' : ''}{vixChangePct.toFixed(1)}%)
                </span>
              )}
              <span className={`rounded px-1 py-0.2 text-[8px] font-bold border uppercase ${
                vixRegime.tone === 'emerald'
                  ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-400'
                  : vixRegime.tone === 'amber'
                  ? 'border-amber-500/40 bg-amber-500/10 text-amber-400'
                  : 'border-red-500/40 bg-red-500/10 text-red-400'
              }`}>
                {vixRegime.regime}
              </span>
            </div>
          )}

          {/* Available Margin Balance */}
          {fundsData && Number.isFinite(Number(fundsData.availabelBalance)) && (
            <span className="h-7 flex items-center gap-1.5 px-2.5 rounded-md text-xs font-mono font-bold tabular-nums bg-zinc-900 border border-zinc-700 text-zinc-200">
              <Wallet className="w-3 h-3 text-sky-400" />
              <span>₹{formatFundsValue(Number(fundsData.availabelBalance))}</span>
            </span>
          )}

          {/* Global Navigation Bar */}
          <div className="flex items-center pl-1 border-l border-zinc-800">
            <NavBar />
          </div>
        </div>
      </div>

      {/* ─── Command Ribbon: Underlying, Expiries & Multipliers ────────── */}
      <div className="border-b border-zinc-800 bg-zinc-950/80 px-4 lg:px-6 py-2 flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          {/* Underlying Segmented Buttons */}
          <div className="flex items-center gap-1 p-0.5 rounded-lg border border-zinc-800 bg-zinc-950">
            {UNDERLYINGS.map(u => {
              const isSelected = underlying === u;
              return (
                <button
                  key={u}
                  type="button"
                  onClick={() => setUnderlying(u)}
                  className={`px-3 py-1 text-xs font-mono font-bold rounded-md transition-all cursor-pointer ${
                    isSelected
                      ? 'border border-amber-500/50 bg-amber-500/15 text-amber-300 shadow-sm'
                      : 'text-zinc-400 hover:text-zinc-200 border border-transparent'
                  }`}
                >
                  {u}
                </button>
              );
            })}
          </div>

          {/* Front Expiry Dropdown */}
          <div className="flex items-center gap-1.5 h-8 bg-zinc-900 border border-zinc-700 rounded-lg px-2 shadow-inner">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">EXPIRY</span>
            <select
              value={expiry}
              onChange={e => setExpiry(e.target.value)}
              className="bg-transparent text-zinc-100 text-xs font-mono font-bold rounded focus:outline-none cursor-pointer"
            >
              {expiries.map(ex => (
                <option key={ex} value={ex} className="bg-zinc-900 text-zinc-100">{ex}</option>
              ))}
            </select>
          </div>

          {/* Far Expiry Selector (shown for Calendar strategies or multi-expiry legs) */}
          {(category === 'Calendar' || hasMixedExpiry) && (
            <div className="flex items-center gap-1.5 h-8 bg-zinc-900 border border-fuchsia-500/40 rounded-lg px-2 shadow-inner">
              <span className="text-[10px] font-bold text-fuchsia-400 uppercase tracking-wider font-mono">FAR EXPIRY</span>
              <select
                value={farExpiry}
                onChange={e => setFarExpiry(e.target.value)}
                className="bg-transparent text-zinc-100 text-xs font-mono font-bold rounded focus:outline-none cursor-pointer"
              >
                {expiries.filter(ex => ex !== expiry).map(ex => (
                  <option key={ex} value={ex} className="bg-zinc-900 text-zinc-100">{ex}</option>
                ))}
              </select>
            </div>
          )}

          {/* Multiplier Stepper */}
          <div className="flex items-center gap-2 h-8 bg-zinc-900 border border-zinc-700 rounded-lg px-2 shadow-inner">
            <span className="text-[10px] font-bold text-zinc-400 uppercase tracking-wider font-mono">MULTIPLIER</span>
            <div className="inline-flex items-center rounded-md border border-zinc-800 bg-zinc-950 overflow-hidden">
              <button
                type="button"
                onClick={() => setMultiplier(m => Math.max(1, m - 1))}
                className="w-6 h-6 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              >
                <span className="text-xs font-bold font-mono">−</span>
              </button>
              <span className="font-mono font-bold text-xs tabular-nums text-center px-2 text-amber-400 min-w-[28px] inline-block">
                {multiplier}×
              </span>
              <button
                type="button"
                onClick={() => setMultiplier(m => Math.min(20, m + 1))}
                className="w-6 h-6 flex items-center justify-center text-zinc-400 hover:text-white hover:bg-zinc-800 transition-colors"
              >
                <span className="text-xs font-bold font-mono">+</span>
              </button>
            </div>
          </div>
        </div>

        {/* Quick Staging Status */}
        <div className="font-mono text-xs text-zinc-400 hidden md:flex items-center gap-3">
          <span>Staged Legs: <strong className="text-zinc-100">{legs.length}</strong></span>
          <span className="text-zinc-700">|</span>
          <span>Total Lots: <strong className="text-zinc-100">{totalQty}</strong></span>
          <span className="text-zinc-700">|</span>
          <span>Contracts: <strong className="text-zinc-100">{lotSize ? totalQty * lotSize : '—'}</strong></span>
        </div>
      </div>

      {/* ─── Main Content Canvas ──────────────────────────────────────── */}
      <div className="flex-1 flex flex-col gap-4 p-4 lg:p-6">
        {/* Panel 1: Strategy Templates Catalog */}
        <TerminalPanel
          title="STRATEGY TEMPLATES & PAYOFF ARCHITECT"
          icon={Layers}
          meta={`ATM: ${atmStrike ?? '—'} · STEP: ${step ?? '—'}`}
          badge={
            <span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold border border-zinc-700 bg-zinc-800 text-zinc-400">
              {STRATEGY_CATEGORIES[category].length} TEMPLATES
            </span>
          }
        >
          <div className="p-3.5">
            <StrategyCardGrid
              category={category}
              onCategoryChange={setCategory}
              selectedKey={strategy}
              onSelectTemplate={applyTemplate}
              disabled={atmStrike == null}
              atmStrike={atmStrike}
              step={step}
              allStrikes={allStrikes}
              autoPremium={autoPremium}
              frontExpiry={expiry}
              farExpiry={farExpiry}
            />
          </div>
        </TerminalPanel>

        {/* Panel 2 & 3: Two-Column Workspace (Legs Builder + Payoff Analytics) */}
        <div className="grid grid-cols-1 xl:grid-cols-12 gap-4 items-start">
          {/* Left Column: Basket Legs Builder */}
          <div className="xl:col-span-6 flex flex-col gap-4">
            <TerminalPanel
              title="BASKET LEGS BUILDER & STAGING DOCK"
              icon={SlidersHorizontal}
              meta={`${legs.length} LEGS · ${totalQty} LOTS · ${lotSize ? totalQty * lotSize : 0} QTY`}
              badge={
                strategy ? (
                  <span className="rounded px-1.5 py-0.5 font-mono text-[9px] font-bold border border-amber-500/30 bg-amber-500/10 text-amber-400">
                    {strategy.toUpperCase()}
                  </span>
                ) : null
              }
            >
              {/* Legs Table Component */}
              <LegsTable
                legs={legs}
                atmStrike={atmStrike}
                allStrikes={allStrikes}
                autoPremium={autoPremium}
                frontExpiry={expiry}
                farExpiry={farExpiry}
                onUpdateLeg={updateLeg}
                onStepStrike={stepStrike}
                onAddLeg={addLeg}
                onRemoveLeg={removeLeg}
                onClearAll={() => { setLegs([]); setStrategy(null); }}
              />

              {/* Saved Presets Dock */}
              <div className="px-3.5 py-2.5 border-t border-zinc-800 bg-zinc-950/50">
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

              {/* Execution Action Dock */}
              {legs.length > 0 && (
                <div className="flex items-center justify-between gap-3 px-3.5 py-3 border-t border-zinc-800 bg-zinc-950/80 flex-wrap">
                  <div className="flex items-center gap-2 flex-wrap">
                    <button
                      type="button"
                      onClick={placeBasket}
                      disabled={placing || !hasAuthenticatedBroker}
                      className={`flex items-center gap-2 px-5 py-2 rounded-lg font-mono text-xs font-bold transition-all shadow-md cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed ${
                        confirmPlace
                          ? 'bg-emerald-500 hover:bg-emerald-400 text-zinc-950 animate-pulse'
                          : 'bg-amber-500 hover:bg-amber-400 text-zinc-950 shadow-amber-500/20 active:scale-[0.98]'
                      }`}
                    >
                      {placing ? (
                        <RefreshCw className="w-3.5 h-3.5 animate-spin" />
                      ) : (
                        <ShoppingBasket className="w-3.5 h-3.5" />
                      )}
                      <span>
                        {placing
                          ? 'TRANSMITTING BASKET...'
                          : !hasAuthenticatedBroker
                          ? 'NO BROKER LOGGED IN'
                          : confirmPlace
                          ? `CONFIRM TRANSMIT: ${legs.length} LEGS ×${multiplier}?`
                          : 'TRANSMIT BASKET ORDERS'}
                      </span>
                    </button>

                    <button
                      type="button"
                      disabled={placing}
                      onClick={() => { setLegs([]); setStrategy(null); setConfirmPlace(false); }}
                      className="px-3 py-2 text-[11px] font-mono font-bold rounded-lg border border-zinc-700 text-zinc-400 hover:text-red-400 hover:border-red-500/40 hover:bg-red-500/10 transition-all cursor-pointer"
                    >
                      CLEAR ALL
                    </button>
                  </div>

                  <div className="text-[11px] font-mono text-zinc-500 leading-snug text-right">
                    <p className="font-bold text-zinc-300">
                      {totalQty} lots{lotSize ? ` · ${totalQty * lotSize} total quantity` : ''}
                    </p>
                    <p className="text-[10px] text-zinc-500">
                      Buys sequenced ahead of sells for margin relief · {lotSize ? `${lotSize} qty/lot` : 'resolving lot...'}
                    </p>
                    {premiumsUnavailable && (
                      <p className="text-amber-400 font-semibold text-[10px] mt-0.5">
                        Warning: No live quotes from broker (market closed). Enter prices manually to preview payoff.
                      </p>
                    )}
                  </div>
                </div>
              )}
            </TerminalPanel>
          </div>

          {/* Right Column: Payoff Analytics & Risk Profile */}
          <div className="xl:col-span-6 flex flex-col gap-4">
            <TerminalPanel
              title="EXPIRY PAYOFF ANALYTICS & RISK PROFILE"
              icon={TrendingUp}
              meta={payoff ? (payoff.netPremium >= 0 ? 'NET CREDIT' : 'NET DEBIT') : 'EXPIRY MODEL'}
            >
              <div className="flex flex-col">
                {/* 3x2 StatTile Grid */}
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 p-3.5 border-b border-zinc-800 bg-zinc-950/40">
                  <StatTile
                    label="Net Premium"
                    tone={!payoff ? 'neutral' : payoff.netPremium >= 0 ? 'up' : 'down'}
                    value={payoff ? `${payoff.netPremium >= 0 ? 'Credit' : 'Debit'} ${fmtMoney(payoff.netPremium)}` : '—'}
                    sub={payoff && lotSize ? `₹${(Math.abs(payoff.netPremium) / (totalQty * lotSize)).toFixed(2)} / unit` : undefined}
                    tooltip="Net premium received (Credit) or paid (Debit) for the staged basket"
                  />
                  <StatTile
                    label="Max Profit"
                    tone="up"
                    value={!payoff ? '—' : payoff.maxProfitUnlimited ? 'Unlimited' : fmtMoney(payoff.maxProfit)}
                    sub={payoff?.maxProfitUnlimited ? 'Uncapped upside' : payoff ? 'Capped at target' : undefined}
                    tooltip="Theoretical maximum gain at contract expiry"
                  />
                  <StatTile
                    label="Max Loss"
                    tone="down"
                    value={!payoff ? '—' : payoff.maxLossUnlimited ? 'Unlimited' : fmtMoney(payoff.maxLoss)}
                    sub={payoff?.maxLossUnlimited ? 'Defined-risk hedge advised' : payoff ? 'Defined downside' : undefined}
                    tooltip="Theoretical maximum risk at contract expiry"
                  />
                  <StatTile
                    label="Breakeven Corridor"
                    tone="accent"
                    value={payoff && payoff.breakevens.length
                      ? payoff.breakevens.map(b => b.toLocaleString('en-IN', { maximumFractionDigits: 0 })).join(' / ')
                      : '—'}
                    sub={payoff && payoff.breakevens.length === 2
                      ? `${Math.abs(payoff.breakevens[1] - payoff.breakevens[0]).toFixed(0)} pts corridor`
                      : payoff && payoff.breakevens.length === 1 && spot > 0
                      ? `${(((payoff.breakevens[0] - spot) / spot) * 100).toFixed(1)}% from spot`
                      : undefined}
                    tooltip="Points where the strategy breaks even at expiry"
                  />
                  <StatTile
                    label="Risk : Reward"
                    tone="neutral"
                    value={riskReward != null ? `1 : ${riskReward.toFixed(2)}` : '—'}
                    sub={riskReward != null ? (riskReward >= 1 ? 'Positive expectancy' : 'Debit profile') : undefined}
                    tooltip="Ratio of maximum risk to maximum profit"
                  />
                  <StatTile
                    label="Expiry & Days Left"
                    tone="neutral"
                    value={daysLeft != null ? `${daysLeft} DAYS` : '—'}
                    sub={`${expiry || 'Front'} · VIX ${currentVix.toFixed(2)}`}
                    tooltip="Calendar days remaining until contract expiry"
                  />
                </div>

                {/* Payoff Chart Canvas */}
                <div className="p-3.5">
                  <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/80 p-2 shadow-inner">
                    <BasketPayoffChart
                      points={payoff?.points ?? []}
                      breakevens={payoff?.breakevens ?? []}
                      spot={spot}
                      rightWing={payoff?.rightWing ?? null}
                      leftWing={payoff?.leftWing ?? null}
                      emptyReason={
                        hasMixedExpiry
                          ? 'Calendar/Diagonal legs expire on different dates — no single expiry payoff to chart. Track P&L from the Positions tab instead.'
                          : premiumsUnavailable
                          ? 'No premium data from broker — market may be closed. Enter prices manually in the Price column to preview payoff.'
                          : undefined
                      }
                    />
                  </div>
                  <div className="flex items-center justify-between text-[10px] font-mono text-zinc-500 mt-2 px-1">
                    <span>Expiry intrinsic settlement model</span>
                    <span>Live LTP quotes with manual override</span>
                  </div>
                </div>
              </div>
            </TerminalPanel>
          </div>
        </div>

        {/* Panel 4: Activity Blotter (Positions / Orders / Trades) */}
        <BasketActivityTabs broker={broker} onAddLeg={addLegFromPosition} />
      </div>
    </div>
  );
}
