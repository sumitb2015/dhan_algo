'use client';

import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { BarChart3, RefreshCw, ArrowLeft, Layers } from 'lucide-react';
import NavBar from '../NavBar';
import { FOCUS_RING } from '../Scalper';
import { useLiveOptionsWS } from '@/lib/useLiveOptionsWS';
import { useBrokerSelector } from '@/hooks/useBrokerSelector';
import PositionVisualizer from './PositionVisualizer';
import {
  type MultiLegBasket, type MultiLegLeg, fallbackLotSize, crudeQtyMultiplier,
} from '@/lib/multiLegFocus';
import { cn } from '@/lib/utils';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'SENSEX', 'CRUDEOIL', 'CRUDEOILM'] as const;
type Underlying = typeof UNDERLYINGS[number];

const STRIKE_STEPS: Record<Underlying, number> = {
  NIFTY: 50, BANKNIFTY: 100, SENSEX: 100, CRUDEOIL: 50, CRUDEOILM: 50,
};

const POLL_MS = 15_000;
const ACTIVE_STATUSES = new Set(['OPEN', 'CLOSING', 'DRAFT', 'PLACING']);

const pill = (on: boolean) => cn(
  'inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors cursor-pointer',
  on ? 'border-indigo-500 bg-indigo-600 text-oncolor' : 'border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800',
  FOCUS_RING,
);

export default function PositionVisualizerPage() {
  const searchParams = useSearchParams();
  const queryBasketId = searchParams.get('basketId') || '';
  const queryUnderlying = searchParams.get('underlying') as Underlying | null;

  const [activeUnderlying, setActiveUnderlying] = useState<Underlying>(
    queryUnderlying && UNDERLYINGS.includes(queryUnderlying) ? queryUnderlying : 'NIFTY',
  );
  const [baskets, setBaskets] = useState<MultiLegBasket[]>([]);
  const [selectedBasketId, setSelectedBasketId] = useState<string>(queryBasketId || 'ALL');
  const [expiryChoice, setExpiryChoice] = useState<string>('');
  const [loaded, setLoaded] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const inFlight = useRef(false);

  const { broker, authenticatedBrokers } = useBrokerSelector();

  const fetchBaskets = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    setRefreshing(true);
    try {
      const res = await fetch('/api/multi-leg-focus/baskets', { cache: 'no-store' });
      const json = res.ok ? await res.json() : null;
      if (json?.success && Array.isArray(json.data)) {
        setBaskets(json.data);
        setError('');
      } else {
        setError('Could not load strategies. Showing the last data received.');
      }
    } catch {
      setError('Could not load strategies. Showing the last data received.');
    } finally {
      inFlight.current = false;
      setLoaded(true);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(fetchBaskets, 0);
    const t = setInterval(() => { if (document.visibilityState === 'visible') fetchBaskets(); }, POLL_MS);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [fetchBaskets]);

  const underlyingBaskets = useMemo(
    () => baskets.filter(b => b.underlying === activeUnderlying && b.legs.some(l => ACTIVE_STATUSES.has(l.status))),
    [baskets, activeUnderlying],
  );

  // A basketId from the URL that belongs to another underlying falls back to the combined view.
  const activeBasket = useMemo(
    () => (selectedBasketId === 'ALL' ? null : underlyingBaskets.find(b => b.id === selectedBasketId) ?? null),
    [selectedBasketId, underlyingBaskets],
  );
  const combined = !activeBasket;

  // One live feed carries one expiry, so the combined view shows one expiry at a time
  // rather than pricing legs of another expiry off the wrong chain.
  const expiries = useMemo(
    () => [...new Set(underlyingBaskets.flatMap(b => b.legs.map(l => l.expiry || b.expiry)).filter(Boolean))].sort(),
    [underlyingBaskets],
  );
  const activeExpiry = activeBasket
    ? activeBasket.expiry
    : (expiries.includes(expiryChoice) ? expiryChoice : expiries[0] || '');

  const { liveQuotes, bridgeStatus } = useLiveOptionsWS(activeExpiry, broker, authenticatedBrokers, activeUnderlying);
  const wsLive = bridgeStatus?.status === 'RUNNING' && !!liveQuotes;
  // REST option chain: last price + IV per strike for the active expiry. This is what Multi-Leg Focus
  // falls back to, so the page prices legs even when the tick bridge is not running.
  type ChainQuote = { ce: number; pe: number; ceIv?: number; peIv?: number };
  const [chain, setChain] = useState<{ key: string; spot: number; quotes: Record<string, ChainQuote> }>({ key: '', spot: 0, quotes: {} });
  const chainKey = `${activeUnderlying}:${activeExpiry}`;
  useEffect(() => {
    if (!activeExpiry) return;
    let dead = false;
    const pull = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch(`/api/options/chain?underlying=${activeUnderlying}&expiry=${activeExpiry}&broker=${broker}`, { cache: 'no-store' });
        const j = res.ok ? await res.json() : null;
        if (dead || !j?.success || !j.data) return;
        const oc = j.data.chain?.oc ?? j.data.chain;
        const quotes: Record<string, ChainQuote> = {};
        if (oc && typeof oc === 'object') {
          for (const [sk, e] of Object.entries(oc as Record<string, any>)) { // eslint-disable-line @typescript-eslint/no-explicit-any
            const k = Math.round(parseFloat(sk));
            if (isNaN(k)) continue;
            quotes[String(k)] = {
              ce: Number(e?.ce?.last_price || e?.ce?.ltp || 0),
              pe: Number(e?.pe?.last_price || e?.pe?.ltp || 0),
              ceIv: Number(e?.ce?.implied_volatility) || undefined,
              peIv: Number(e?.pe?.implied_volatility) || undefined,
            };
          }
        }
        setChain({ key: `${activeUnderlying}:${activeExpiry}`, spot: Number(j.data.spot) || 0, quotes });
      } catch { /* keep the last snapshot */ }
    };
    const first = setTimeout(pull, 0);
    const t = setInterval(pull, 5000);
    return () => { dead = true; clearTimeout(first); clearInterval(t); };
  }, [activeUnderlying, activeExpiry, broker]);
  const chainQuotes = useMemo(() => (chain.key === chainKey ? chain.quotes : {}), [chain, chainKey]);

  // The tick bridge only runs while Multi-Leg Focus has started it. Fall back to the shared index
  // snapshot (same source as the Top Indices strip) so the spot line still shows with the feed off.
  const [fallbackSpot, setFallbackSpot] = useState(0);
  useEffect(() => {
    let dead = false;
    const pull = async () => {
      if (document.visibilityState !== 'visible') return;
      try {
        const res = await fetch('/api/scalper/top-indices', { cache: 'no-store' });
        const json = res.ok ? await res.json() : null;
        const ltp = json?.quotes?.[activeUnderlying]?.ltp;
        if (!dead) setFallbackSpot(typeof ltp === 'number' && ltp > 0 ? ltp : 0);
      } catch { /* keep the last value */ }
    };
    const first = setTimeout(pull, 0);
    const t = setInterval(pull, 5000);
    return () => { dead = true; clearTimeout(first); clearInterval(t); };
  }, [activeUnderlying]);
  const spot = liveQuotes?.spot && liveQuotes.spot > 0 ? liveQuotes.spot : (fallbackSpot || (chain.key === chainKey ? chain.spot : 0));

  const activeLegs = useMemo<MultiLegLeg[]>(() => {
    const source = activeBasket ? [activeBasket] : underlyingBaskets;
    return source
      .flatMap(b => b.legs.map(l => ({ ...l, expiry: l.expiry || b.expiry })))
      .filter(l => combined ? l.expiry === activeExpiry : true);
  }, [activeBasket, underlyingBaskets, combined, activeExpiry]);

  const step = STRIKE_STEPS[activeUnderlying];
  const lotSize = fallbackLotSize(activeUnderlying, broker);
  const qtyMultiplier = crudeQtyMultiplier(activeUnderlying, broker);

  // Live tick first, then the REST chain. Never the entry price: a leg with no price must read as
  // "no price", not as a flat P&L.
  const ltpFor = useCallback((leg: MultiLegLeg) => {
    const key = String(leg.strike);
    const side = leg.option === 'CE' ? 'ce' : 'pe';
    const exp = leg.expiry || activeExpiry;
    if (exp !== activeExpiry) return 0;
    return liveQuotes?.strikes?.[key]?.[side]?.ltp || chainQuotes[key]?.[side] || 0;
  }, [liveQuotes, chainQuotes, activeExpiry]);

  const ivForStrike = useCallback((strike: number, option: 'CE' | 'PE', expiry?: string) => {
    if (expiry && expiry !== activeExpiry) return 0;
    const q = chainQuotes[String(strike)];
    const iv = option === 'CE' ? q?.ceIv : q?.peIv;
    return iv && iv > 0 ? iv / 100 : 0;
  }, [chainQuotes, activeExpiry]);

  const strategyTitle = activeBasket
    ? (activeBasket.name || activeBasket.presetKey || 'Strategy')
    : `All strategies (${underlyingBaskets.length})`;

  return (
    <div className="flex min-h-screen flex-col bg-zinc-950 font-sans text-white">
      <header className="sticky top-0 z-30 flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-950 px-6 py-3">
        <div className="flex items-center gap-3">
          <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-indigo-500/25 bg-indigo-500/10">
            <BarChart3 className="h-4 w-4 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-sm font-bold leading-none text-white">Position map</h1>
            <p className="mt-1 text-xs text-zinc-500">Open exposure by strike, against live spot</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <Link
            href="/multi-leg-focus"
            className={`inline-flex h-8 items-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-2.5 text-xs font-bold text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white ${FOCUS_RING}`}
          >
            <ArrowLeft className="h-3.5 w-3.5" /> Multi-Leg Focus
          </Link>

          <div role="group" aria-label="Underlying" className="flex rounded-lg border border-zinc-800 bg-zinc-900 p-0.5">
            {UNDERLYINGS.map(u => (
              <button
                key={u}
                type="button"
                aria-pressed={activeUnderlying === u}
                onClick={() => { setActiveUnderlying(u); setSelectedBasketId('ALL'); setExpiryChoice(''); }}
                className={cn(
                  'rounded-md px-2.5 py-1 text-xs font-semibold transition-colors cursor-pointer',
                  activeUnderlying === u ? 'bg-indigo-600 text-oncolor' : 'text-zinc-400 hover:text-zinc-200',
                )}
              >
                {u}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={fetchBaskets}
            disabled={refreshing}
            aria-label="Refresh strategies"
            title="Refresh strategies"
            className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-900 text-zinc-300 transition-colors hover:bg-zinc-800 hover:text-white ${FOCUS_RING}`}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', refreshing && 'animate-spin')} />
          </button>

          <span className="flex items-center gap-1.5 rounded-lg border border-zinc-800 bg-zinc-900 px-2.5 py-1.5 text-xs font-semibold text-zinc-400">
            <span className={cn('h-2 w-2 rounded-full', wsLive ? 'bg-emerald-500' : 'bg-zinc-600')} />
            {wsLive ? 'Live feed' : 'Polling quotes'}
          </span>
          <NavBar />
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-[1680px] flex-1 flex-col gap-4 px-6 py-5">
        {error && (
          <div role="alert" className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">{error}</div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setSelectedBasketId('ALL')} className={pill(combined)}>
            <Layers className="h-3.5 w-3.5" /> All strategies ({underlyingBaskets.length})
          </button>
          {underlyingBaskets.map(b => (
            <button key={b.id} type="button" onClick={() => setSelectedBasketId(b.id)} className={pill(selectedBasketId === b.id)}>
              <span className="max-w-[180px] truncate">{b.name || b.presetKey || 'Strategy'}</span>
              <span className="font-mono text-zinc-500">{b.legs.length}</span>
            </button>
          ))}

          {combined && expiries.length > 1 && (
            <label className="ml-auto flex items-center gap-2 text-xs text-zinc-400">
              Expiry
              <select
                value={activeExpiry}
                onChange={e => setExpiryChoice(e.target.value)}
                className={`rounded-lg border border-zinc-700 bg-zinc-900 px-2 py-1.5 font-mono text-xs text-zinc-200 ${FOCUS_RING}`}
              >
                {expiries.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
          )}
        </div>

        {!loaded ? (
          <div className="flex items-center justify-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900 p-16 text-sm text-zinc-400">
            <RefreshCw className="h-4 w-4 animate-spin" /> Loading strategies
          </div>
        ) : activeLegs.length === 0 ? (
          <div className="flex flex-col items-center rounded-xl border border-zinc-800 bg-zinc-900 p-16 text-center">
            <BarChart3 className="mb-3 h-8 w-8 text-zinc-600" />
            <h2 className="text-sm font-bold text-zinc-200">No open positions on {activeUnderlying}</h2>
            <p className="mt-1 max-w-sm text-xs text-zinc-500">
              Place a strategy in Multi-Leg Focus and it will appear here.
            </p>
            <Link href="/multi-leg-focus" className={`mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-oncolor transition-colors hover:bg-indigo-500 ${FOCUS_RING}`}>
              Open Multi-Leg Focus
            </Link>
          </div>
        ) : (
          <PositionVisualizer
            strategyLabel={strategyTitle}
            underlying={activeUnderlying}
            basketExpiry={activeExpiry}
            legs={activeLegs}
            spot={spot}
            step={step}
            lotSize={lotSize}
            qtyMultiplier={qtyMultiplier}
            ltpFor={ltpFor}
            ivForStrike={ivForStrike}
            showTable
          />
        )}
      </main>
    </div>
  );
}
