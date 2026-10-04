'use client';

/**
 * "What will this strategy make on date X if spot is Y" — a spot × date P&L grid
 * for one Multi-Leg Focus basket. Reuses PnlTableTab (and through it
 * buildHeatmapGrid from lib/optionsStrategy.ts, the Option Strats engine) so the
 * numbers cannot drift from the Option Strats / Positions Analysis grids.
 *
 * Legs are priced off each leg's own entry (fill avg, else live LTP) with IV solved
 * from the live premium (chain IV only as a fallback); the grid is Black-Scholes on every date before expiry and intrinsic
 * on expiry day. A basket spanning two expiries is refused by PnlTableTab with
 * an explanation rather than mispriced.
 */

import React, { useMemo } from 'react';
import { FocusModal } from '../FocusTool';
import PnlTableTab from '../analytics/PnlTableTab';
import { impliedVolFromPrice, type ResolvedLeg } from '@/lib/optionsStrategy';
import { calculateTimeToExpiryYears } from '@/lib/optionsMonitorMath';
import type { MultiLegLeg } from '@/lib/multiLegFocus';

const FALLBACK_IV = 0.15;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  legs: MultiLegLeg[];
  basketExpiry: string;
  spot: number;
  step: number;
  /** Units per lot (already resolved by the row). */
  lotSize: number;
  /** Dhan MCX crude quotes in lots-vs-barrels: multiplies units (see dhan-crudeoil-trading). */
  qtyMultiplier: number;
  ltpFor: (leg: MultiLegLeg) => number;
  /** Chain IV as a decimal (0.14 = 14%), 0 when unknown. */
  ivForStrike?: (strike: number, option: 'CE' | 'PE', expiry?: string) => number;
}

export default function PnlTableModal({
  isOpen, onClose, title, legs, basketExpiry, spot, step, lotSize, qtyMultiplier, ltpFor, ivForStrike,
}: Props) {
  const resolved = useMemo<ResolvedLeg[]>(() => {
    if (!isOpen) return [];
    return legs
      .filter(l => l.status !== 'CLOSED' && l.status !== 'FAILED' && l.lots > 0)
      .map(l => {
        const legExpiry = l.expiry || basketExpiry;
        const ltp = ltpFor(l);
        const entry = l.fill?.avgPrice && l.fill.avgPrice > 0 ? l.fill.avgPrice : (ltp > 0 ? ltp : (l.price ?? 0));
        const units = ((l.fill?.qty && l.fill.qty > 0) ? l.fill.qty : l.lots * lotSize) * qtyMultiplier;
        const t = calculateTimeToExpiryYears(legExpiry);
        // Solve IV from the live premium with the SAME Black-Scholes the grid uses, so the first column at
        // the current spot reproduces the live P&L. The chain's own IV comes from a different model/forward
        // (it misprices our BS by tens of rupees per unit: calls low, puts high), so it is only a fallback.
        const iv = (spot > 0 && ltp > 0 ? impliedVolFromPrice(l.option, spot, l.strike, t, ltp) : null)
          || ivForStrike?.(l.strike, l.option, legExpiry)
          || FALLBACK_IV;
        return {
          strike: l.strike,
          type: l.option,
          side: l.side === 'B' ? 'BUY' : 'SELL',
          qtyLots: units,
          price: entry,
          delta: null, iv, vega: null, securityId: null,
          expiry: legExpiry,
        } satisfies ResolvedLeg;
      });
  }, [isOpen, legs, basketExpiry, spot, lotSize, qtyMultiplier, ltpFor, ivForStrike]);

  // Without a live spot the grid has no price axis (span = 0, one row at spot 0), so refuse it.
  const unpriced = resolved.some(l => !(l.price > 0)) || !(spot > 0);

  return (
    <FocusModal isOpen={isOpen} onClose={onClose} title={`${title} — P&L by date`} variant="center" wide>
      <div className="min-h-0 flex-1 overflow-auto">
        {unpriced ? (
          <p className="py-10 text-center text-xs text-zinc-500">
            Needs a live spot and a price for every leg. Wait for quotes (or place the legs) to build the grid.
          </p>
        ) : (
          <PnlTableTab legs={resolved} spot={spot} strikeStep={step} expiry={basketExpiry} large />
        )}
      </div>
    </FocusModal>
  );
}
