'use client';

/** Cyber Scalper adapter for the shared NetDeltaCalculator: turns the active positions on screen into calculator legs. */

import React from 'react';
import type { Broker } from '@/hooks/useBrokerSelector';
import type { PositionItem } from './CyberPositionsPanel';
import NetDeltaCalculator from '../NetDeltaCalculator';
import { parseTradingSymbol, normalizeExpiry, normalizeOptType } from '@/lib/positionLegs';
import { contractMultiplier } from '@/lib/positionPnl';
import { calculateTimeToExpiryYears, greeksFromMark } from '@/lib/optionsPricing';
import type { CalcLeg } from '@/lib/deltaCalcLegs';

interface Props {
  open: boolean;
  onClose: () => void;
  /** The active positions the panel is showing. */
  positions: PositionItem[];
  /** Broker-shaped raw rows, for Dhan's own strike / option type / expiry fields and the MCX lot multiplier. */
  rawPositions: Record<string, unknown>[];
  broker: Broker;
  /** Units in one lot for a row (the terminal's own lookup); 1 means "netQty is already in lots". */
  lotSizeFor: (pos: PositionItem) => number | null;
  /** Fallback underlying price when the book holds no future to read one from. */
  spotHint: number;
}

const isFutureSymbol = (sym: string) => /FUT$/.test(sym.trim().toUpperCase());

function buildLegs(
  positions: PositionItem[],
  rawPositions: Record<string, unknown>[],
  broker: Broker,
  lotSizeFor: (pos: PositionItem) => number | null,
  F: number,
): CalcLeg[] {
  const legs: CalcLeg[] = [];
  for (const pos of positions) {
    if (pos.netQty === 0) continue;
    const raw = rawPositions.find(
      (r) => String(r.tradingSymbol ?? '') === pos.tradingSymbol && String(r.productType ?? r.prod ?? '') === pos.productType,
    );
    // Dhan reports MCX quantity in lots; every other row is in units.
    const dhanMcx = broker === 'dhan' && !!raw && String(raw.exchangeSegment ?? '') === 'MCX_COMM';
    const unitsPerLot = dhanMcx && raw ? contractMultiplier(raw) : (lotSizeFor(pos) ?? 1);
    const liveLots = dhanMcx ? pos.netQty : pos.netQty / unitsPerLot;

    if (isFutureSymbol(pos.tradingSymbol)) {
      legs.push({ key: pos.id, label: pos.tradingSymbol, kind: 'FUT', strike: 0, expiry: null, unitsPerLot, liveLots, mark: pos.ltp, liveIv: 0 });
      continue;
    }
    const drvType = normalizeOptType(raw?.drvOptionType);
    const drvStrike = Number(raw?.drvStrikePrice ?? 0);
    const parsed = parseTradingSymbol(pos.tradingSymbol);
    const type = drvType && drvStrike > 0 ? drvType : parsed?.type;
    const strike = drvType && drvStrike > 0 ? drvStrike : parsed?.strike;
    const expiry = (raw && normalizeExpiry(raw.drvExpiryDate)) || parsed?.expiry || null;
    if (!type || !strike) continue;
    const t = expiry ? calculateTimeToExpiryYears(expiry) : 0;
    const solved = expiry && pos.ltp > 0 && F > 0
      ? greeksFromMark({ type, strike, expiry, mark: pos.ltp, underlying: F, isFutures: dhanMcx })
      : null;
    legs.push({
      key: pos.id,
      label: `${type === 'PE' ? 'Put' : 'Call'} ${strike.toLocaleString('en-IN')}${expiry ? ` · ${expiry}` : ''}`,
      kind: type, strike, expiry, unitsPerLot, liveLots, mark: pos.ltp,
      liveIv: solved && t > 0 ? Math.round(solved.iv * 1000) / 10 : 50,
    });
  }
  return legs;
}

export default function CyberDeltaCalculator({ open, onClose, positions, rawPositions, broker, lotSizeFor, spotHint }: Props) {
  return (
    <NetDeltaCalculator
      open={open}
      onClose={onClose}
      subtitle="What-if on the active positions. Nothing is ordered."
      getSnapshot={() => {
        const firstFut = positions.find((p) => isFutureSymbol(p.tradingSymbol) && p.ltp > 0);
        const F = firstFut ? firstFut.ltp : spotHint;
        const legs = buildLegs(positions, rawPositions, broker, lotSizeFor, F);
        const mcx = broker === 'dhan' && rawPositions.some((r) => String(r.exchangeSegment ?? '') === 'MCX_COMM');
        return { legs, price: F, isFuturesPricing: mcx && legs.some((l) => l.kind !== 'FUT') };
      }}
    />
  );
}
