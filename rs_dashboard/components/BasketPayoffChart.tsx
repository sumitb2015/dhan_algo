'use client';

/**
 * Baskets payoff panel. Computation only: the curves come from generatePayoffCurve (which prices through the central payoff library,
 * lib/optionsPayoff.ts) and the drawing is the shared PayoffWorkbench / PayoffDiagram, the same panel the Options Monitor uses.
 */

import React, { useMemo, useState } from 'react';
import PayoffWorkbench from '@/components/strategy/PayoffWorkbench';
import {
  OptionLegModel,
  PayoffPoint,
  generatePayoffCurve,
  calculateTimeToExpiryYears,
} from '@/lib/optionsMonitorMath';

export interface BasketPayoffChartProps {
  legs?: OptionLegModel[];
  spot: number;
  strikeStep?: number;
  lotSize?: number;
  currentExpiry?: string;
  futurePrice?: number | null;
  futureBasis?: number | null;
  futureExpiry?: string | null;
  baseIv?: number;
  underlying?: string;
  emptyReason?: string;
  // Legacy props for backward compatibility
  points?: { x: number; y: number }[];
  breakevens?: number[];
  rightWing?: 'profit' | 'loss' | null;
  leftWing?: 'loss' | null;
}

export default function BasketPayoffChart({
  legs = [],
  spot,
  strikeStep = 50,
  lotSize = 75,
  currentExpiry = '',
  futurePrice = null,
  futureBasis = null,
  futureExpiry = null,
  baseIv = 0.1313,
  underlying = 'NIFTY',
  emptyReason,
  points: legacyPoints,
  breakevens: legacyBreakevens,
}: BasketPayoffChartProps) {
  const [targetSpot, setTargetSpot] = useState<number | null>(null);
  const [targetDays, setTargetDays] = useState<number | null>(null);

  // Real remaining time on the selected expiry. Never floored to an arbitrary constant: a same-day/next-day expiry must cap the
  // target-date slider (and thus the T+0 evaluation time and SD bands) at its own remaining time.
  const maxDays = Math.max(0.05, (currentExpiry ? calculateTimeToExpiryYears(currentExpiry) * 365 : 4.0));
  // Default (untouched slider) is "today", i.e. the full remaining time to the real expiry.
  const effectiveTargetDays = Math.min(targetDays ?? maxDays, maxDays);

  const { points, breakevens, sdLevels } = useMemo(() => {
    if (legs.length > 0 && spot > 0) {
      const evalTimeYears = Math.max(0.0001, effectiveTargetDays / 365);
      return generatePayoffCurve(legs, spot, lotSize, evalTimeYears, baseIv, strikeStep, futurePrice ?? undefined, evalTimeYears, futureExpiry ?? undefined);
    }
    if (legacyPoints && legacyPoints.length > 1) {
      const pts: PayoffPoint[] = legacyPoints.map((p) => ({ spot: p.x, pnlExpiry: Math.round(p.y), pnlToday: Math.round(p.y) }));
      return { points: pts, minPnl: 0, maxPnl: 0, breakevens: legacyBreakevens ?? [], sdLevels: null };
    }
    return { points: [] as PayoffPoint[], minPnl: 0, maxPnl: 0, breakevens: [] as number[], sdLevels: null };
  }, [legs, spot, lotSize, baseIv, strikeStep, futurePrice, futureExpiry, effectiveTargetDays, legacyPoints, legacyBreakevens]);

  return (
    <PayoffWorkbench
      legs={legs}
      spot={spot}
      strikeStep={strikeStep}
      underlying={underlying}
      currentExpiry={currentExpiry}
      futurePrice={futurePrice}
      futureBasis={futureBasis}
      payoffPoints={points}
      breakevens={breakevens}
      sdLevels={sdLevels}
      targetSpot={targetSpot}
      onTargetSpotChange={setTargetSpot}
      targetDays={targetDays}
      onTargetDaysChange={setTargetDays}
      maxDays={maxDays}
      emptyReason={emptyReason}
    />
  );
}
