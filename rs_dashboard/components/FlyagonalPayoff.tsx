'use client';

import React, { useMemo, useState } from 'react';
import PayoffDiagram from '@/components/strategy/PayoffDiagram';
import {
  buildMultiExpiryCurve, findBreakevens, impliedVolFromPrice, legsMissingIv,
  type ResolvedLeg,
} from '@/lib/optionsStrategy';

// Payoff diagram for a live/paper Flyagonal book, built from the strategy's state file.
// The five legs sit on two expiries (front fly + short put, back long put), so this uses the
// multi-expiry engine: at the front expiry the back put still carries time value (Black-Scholes at
// an IV inverted from its last price), everything else settles intrinsically. "Today" prices all
// legs pre-expiry. P&L is the open book only, gross of charges and excluding realized_pnl.

interface StateLeg {
  side: 'BUY' | 'SELL';
  type: 'CE' | 'PE';
  strike: number;
  expiry: string;
  mult: number;
  entry_price: number;
  last_price?: number;
}

export interface FlyagonalPayoffState {
  spot?: number;
  lots?: number;
  lot_size?: number;
  front_expiry?: string | null;
  legs?: Record<string, StateLeg | null>;
}

const isoToday = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function FlyagonalPayoff({ state }: { state: FlyagonalPayoffState }) {
  const [view, setView] = useState<'expiry' | 'today'>('expiry');

  const legs = useMemo<StateLeg[]>(
    () => Object.values(state.legs ?? {}).filter((l): l is StateLeg => !!l && l.entry_price > 0),
    [state.legs],
  );
  const spot = state.spot ?? 0;
  const lotSize = state.lot_size ?? 0;
  const lots = state.lots ?? 1;
  const today = isoToday();
  const target = view === 'expiry' && state.front_expiry ? state.front_expiry : today;

  const resolved = useMemo<ResolvedLeg[]>(() => legs.map((l) => {
    const days = Math.max(0, (new Date(l.expiry).getTime() - new Date(today).getTime()) / 86_400_000);
    const mark = l.last_price && l.last_price > 0 ? l.last_price : l.entry_price;
    return {
      strike: l.strike, type: l.type, side: l.side, qtyLots: l.mult * lots,
      price: l.entry_price, delta: null, vega: null, securityId: null,
      iv: spot > 0 ? impliedVolFromPrice(l.type, spot, l.strike, days / 365, mark) : null,
      expiry: l.expiry,
    };
  }), [legs, lots, spot, today]);

  const curve = useMemo(
    () => (spot > 0 && lotSize > 0 && resolved.length ? buildMultiExpiryCurve(resolved, spot, lotSize, target) : []),
    [resolved, spot, lotSize, target],
  );
  const breakevens = useMemo(() => findBreakevens(curve), [curve]);
  const noIv = useMemo(() => legsMissingIv(resolved, target), [resolved, target]);

  if (!curve.length) return null;

  const btn = (v: 'expiry' | 'today', label: string) => (
    <button
      type="button"
      onClick={() => setView(v)}
      className={`px-2 py-0.5 rounded text-[11px] font-bold border ${view === v ? 'bg-zinc-700 text-white border-zinc-600' : 'text-zinc-400 border-zinc-800 hover:text-zinc-200'}`}
    >{label}</button>
  );

  return (
    <div className="border border-zinc-800/60 rounded-lg bg-zinc-900/30 p-2 flex flex-col gap-2">
      <div className="flex items-center gap-2 text-xs">
        <span className="font-bold text-zinc-300">Payoff</span>
        {btn('expiry', `At front expiry${state.front_expiry ? ` (${state.front_expiry})` : ''}`)}
        {btn('today', 'Today (T+0)')}
      </div>
      <PayoffDiagram curve={curve} currentSpot={spot} breakevens={breakevens} />
      {noIv.length > 0 && (
        <p className="text-[11px] text-amber-400">
          {noIv.length} leg(s) have no usable IV and are priced at intrinsic value; the curve is approximate.
        </p>
      )}
    </div>
  );
}
