'use client';

import React, { useMemo } from 'react';
import PayoffDiagram, { modelToDiagramProps } from '@/components/strategy/PayoffDiagram';
import { buildPayoffModel } from '@/lib/optionsPayoff';

// Payoff diagram for a live/paper Flyagonal book, built from the strategy's state file. The five legs sit on two expiries (front fly +
// short put, back long put); the central payoff library values the book as of the front expiry (the back put keeps its time value,
// everything else settles intrinsically) and draws today's mark-to-market alongside. P&L is the open book only, gross of charges and
// excluding realized_pnl.

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

export default function FlyagonalPayoff({ state }: { state: FlyagonalPayoffState }) {
  const legs = useMemo<StateLeg[]>(
    () => Object.values(state.legs ?? {}).filter((l): l is StateLeg => !!l && l.entry_price > 0),
    [state.legs],
  );
  const spot = state.spot ?? 0;
  const lotSize = state.lot_size ?? 0;
  const lots = state.lots ?? 1;

  const model = useMemo(
    () => (spot > 0 && lotSize > 0 && legs.length
      ? buildPayoffModel({
          spot,
          legs: legs.map((l) => ({
            type: l.type, strike: l.strike, expiry: l.expiry,
            qty: (l.side === 'SELL' ? -1 : 1) * l.mult * lots * lotSize,
            entryPrice: l.entry_price, mark: l.last_price && l.last_price > 0 ? l.last_price : undefined, lotSize,
          })),
        })
      : null),
    [legs, spot, lotSize, lots],
  );

  if (!model) return null;

  return (
    <div className="border border-zinc-800/60 rounded-lg bg-zinc-900/30 p-2 flex flex-col gap-2">
      <PayoffDiagram
        title="Flyagonal payoff"
        {...modelToDiagramProps(model)}
        currentSpot={spot}
        note={
          <span>
            Open P&amp;L at today&apos;s level {model.nowPnl >= 0 ? '+' : '−'}₹{Math.abs(Math.round(model.nowPnl)).toLocaleString('en-IN')}
            {' · '}value as of the front expiry ({model.frontExpiry}){model.laterExpiries.length > 0 ? `; later legs (${model.laterExpiries.join(', ')}) keep their time value` : ''}
            {model.ivAssumed > 0 && <span className="text-amber-400"> · {model.ivAssumed} leg(s) priced on an assumed IV</span>}
          </span>
        }
      />
    </div>
  );
}
