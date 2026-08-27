'use client';

/**
 * Compact inline control for opening a brand-new strike from the positions
 * page, instead of leaving for the Scalper terminal. Deliberately a plain
 * strike dropdown (like Scalper's own strikeMap-driven selects), not a
 * greeks/OI-aware chain view — see the plan's "Not doing" section.
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Broker } from '@/hooks/useBrokerSelector';
import { fetchStrikeMap } from '@/lib/strikeLookup';
import { placeOptionOrder } from '@/lib/optionOrder';
import { fmtExpiryShort } from '@/components/crudeoil/format';

type OptType = 'CE' | 'PE';
type Side = 'BUY' | 'SELL';

interface Props {
  broker: Broker;
  underlying: string;
  strikeStep: number;
  spot: number;
  lotSize: number | null;
  onPlaced: (label: string, orderId?: string) => void;
  onError: (label: string, error?: string) => void;
}

/** ATM ± this many strikes, same window Scalper's visibleStrikes uses. */
const STRIKE_WINDOW = 10;

export default function AddStrikePicker({ broker, underlying, strikeStep, spot, lotSize, onPlaced, onError }: Props) {
  const [expiries, setExpiries] = useState<string[]>([]);
  const [expiry, setExpiry] = useState<string>('');
  const [strikeMap, setStrikeMap] = useState<Record<string, { ceId?: string; peId?: string; ceSymbol?: string; peSymbol?: string }>>({});
  const [mapLoading, setMapLoading] = useState(false);
  const [strike, setStrike] = useState<number | null>(null);
  const [optType, setOptType] = useState<OptType>('CE');
  const [lots, setLots] = useState(1);
  const [armed, setArmed] = useState<Side | null>(null);
  const [placing, setPlacing] = useState(false);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/options/expiries?underlying=${underlying}&broker=${broker}`)
      .then((r) => r.json())
      .then((j: { success: boolean; data?: string[] }) => {
        if (cancelled) return;
        const data = j.data ?? [];
        if (j.success && data.length) {
          setExpiries(data);
          setExpiry((prev) => (data.includes(prev) ? prev : data[0]));
        }
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [broker, underlying]);

  useEffect(() => {
    if (!expiry) return;
    let cancelled = false;
    setMapLoading(true);
    fetchStrikeMap(broker, underlying, expiry)
      .then((data) => { if (!cancelled) setStrikeMap(data?.strikes ?? {}); })
      .finally(() => { if (!cancelled) setMapLoading(false); });
    return () => { cancelled = true; };
  }, [broker, underlying, expiry]);

  const visibleStrikes = useMemo(() => {
    const all = Object.keys(strikeMap).map(Number).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (!all.length || !spot || !strikeStep) return all;
    const atm = Math.round(spot / strikeStep) * strikeStep;
    return all.filter((s) => Math.abs(s - atm) <= strikeStep * STRIKE_WINDOW);
  }, [strikeMap, spot, strikeStep]);

  // Keep the selected strike valid as the expiry (and its strike list) changes;
  // default to the closest-to-ATM strike rather than the first one alphabetically.
  useEffect(() => {
    if (strike !== null && visibleStrikes.includes(strike)) return;
    if (!visibleStrikes.length) { setStrike(null); return; }
    const atm = spot && strikeStep ? Math.round(spot / strikeStep) * strikeStep : visibleStrikes[0];
    const nearest = visibleStrikes.reduce((best, s) => (Math.abs(s - atm) < Math.abs(best - atm) ? s : best), visibleStrikes[0]);
    setStrike(nearest);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `strike` is read but intentionally not a dep: this effect only reacts to the list changing under it.
  }, [visibleStrikes, spot, strikeStep]);

  const entry = strike !== null ? strikeMap[String(strike)] : undefined;
  const ready = !mapLoading && !!entry && !!lotSize && strike !== null;

  const place = async (side: Side) => {
    if (!ready || !entry || !lotSize || strike === null) return;
    if (armed !== side) {
      setArmed(side);
      setTimeout(() => setArmed((a) => (a === side ? null : a)), 3000);
      return;
    }
    setArmed(null);
    setPlacing(true);
    const label = `${side === 'BUY' ? 'B' : 'S'} ${strike} ${optType} × ${lots}L`;
    try {
      const res = await placeOptionOrder({
        broker, underlying, side, quantity: lots * lotSize,
        dhanSecurityId: optType === 'CE' ? entry.ceId : entry.peId,
        tradingSymbol: optType === 'CE' ? entry.ceSymbol : entry.peSymbol,
      });
      if (res.ok) onPlaced(label, res.orderId);
      else onError(label, res.error);
    } finally {
      setPlacing(false);
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-900 px-2 py-1.5">
      <span className="text-[10px] font-bold uppercase tracking-widest text-zinc-400">Add Strike</span>

      <select value={expiry} onChange={(e) => setExpiry(e.target.value)}
        className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-xs text-zinc-200">
        {expiries.map((e) => <option key={e} value={e}>{fmtExpiryShort(e)}</option>)}
      </select>

      <select value={strike ?? ''} onChange={(e) => setStrike(Number(e.target.value))}
        disabled={!visibleStrikes.length}
        className="rounded border border-zinc-700 bg-zinc-950 px-1.5 py-1 font-mono text-xs text-zinc-200 disabled:opacity-40">
        {visibleStrikes.map((s) => <option key={s} value={s}>{s.toLocaleString('en-IN')}</option>)}
      </select>

      <div className="flex overflow-hidden rounded border border-zinc-700">
        {(['CE', 'PE'] as const).map((t) => (
          <button key={t} type="button" onClick={() => setOptType(t)}
            className={cn('px-2 py-1 font-mono text-[10px] font-bold transition-colors',
              optType === t ? 'bg-sky-500/20 text-sky-300 hover:bg-sky-500/30' : 'bg-zinc-950 text-zinc-500 hover:text-zinc-300')}>
            {t}
          </button>
        ))}
      </div>

      <div className="flex items-center gap-1">
        <button type="button" onClick={() => setLots((l) => Math.max(1, l - 1))}
          className="h-6 w-6 rounded border border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:text-zinc-100">−</button>
        <span className="w-6 text-center font-mono text-xs text-zinc-200">{lots}</span>
        <button type="button" onClick={() => setLots((l) => l + 1)}
          className="h-6 w-6 rounded border border-zinc-700 bg-zinc-950 text-xs text-zinc-300 hover:text-zinc-100">+</button>
      </div>

      {placing ? (
        <span className="inline-flex items-center gap-1 text-[10px] text-zinc-400">
          <Loader2 className="h-3 w-3 animate-spin" /> Placing…
        </span>
      ) : (
        <div className="flex gap-1">
          <button type="button" disabled={!ready} onClick={() => place('BUY')}
            className={cn('rounded border px-2 py-1 font-mono text-[10px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-30',
              armed === 'BUY' ? 'border-sky-400 bg-sky-500/25 text-sky-100 hover:bg-sky-500/35' : 'border-sky-800 bg-sky-950 text-sky-300 hover:bg-sky-900')}>
            {armed === 'BUY' ? 'Confirm?' : 'Buy'}
          </button>
          <button type="button" disabled={!ready} onClick={() => place('SELL')}
            className={cn('rounded border px-2 py-1 font-mono text-[10px] font-bold transition-colors disabled:cursor-not-allowed disabled:opacity-30',
              armed === 'SELL' ? 'border-rose-500 bg-rose-500/20 text-rose-200 hover:bg-rose-500/30' : 'border-rose-800 bg-rose-950 text-rose-300 hover:bg-rose-900')}>
            {armed === 'SELL' ? 'Confirm?' : 'Sell'}
          </button>
        </div>
      )}

      {!mapLoading && expiry && !visibleStrikes.length && (
        <span className="text-[10px] text-amber-400">No strikes loaded for this expiry</span>
      )}
    </div>
  );
}
