'use client';

import React, { useMemo, useState } from 'react';
import PayoffDiagram, { modelToDiagramProps } from '@/components/strategy/PayoffDiagram';
import { buildPayoffModel } from '@/lib/optionsPayoff';
import { DeskLeg, deskLegsToPayoffLegs, fmtInr } from '@/lib/deltaDesk';

/**
 * Portfolio Greeks payoff: no maths and no chart code of its own. The central payoff library (lib/optionsPayoff.ts) builds the
 * model from the open legs and the shared PayoffDiagram draws it — the same pair every other page uses.
 */
export default function PayoffPanel({ legs, spot, spotEstimated }: { legs: DeskLeg[]; spot: number; spotEstimated?: boolean }) {
  const [targetDays, setTargetDays] = useState(0);
  const [ivShift, setIvShift] = useState(0);

  const input = useMemo(() => {
    const payoffLegs = deskLegsToPayoffLegs(legs);
    const atm = legs.find(l => l.atmIv && l.atmIv > 0)?.atmIv;
    return { spot, legs: payoffLegs, atmIv: atm ? atm / 100 : undefined };
  }, [legs, spot]);

  const model = useMemo(
    () => (spot > 0 ? buildPayoffModel({ ...input, sim: { days: targetDays, ivShift } }) : null),
    [input, spot, targetDays, ivShift],
  );

  if (!model) {
    return (
      <div className="flex h-[420px] items-center justify-center text-sm text-zinc-500">
        Payoff appears once a leg with a live price is open.
      </div>
    );
  }

  const frontDays = Math.round(model.frontYears * 365);
  return (
    <PayoffDiagram
      title=""
      {...modelToDiagramProps(model)}
      currentSpot={spot}
      targetDays={targetDays}
      onTargetDaysChange={setTargetDays}
      maxDays={Math.max(0.5, model.frontYears * 365)}
      ivShift={ivShift}
      onIvShiftChange={setIvShift}
      height={380}
      note={
        <span>
          Open P&amp;L at today&apos;s level <span className={model.nowPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtInr(model.nowPnl, true)}</span>
          {' · '}at-expiry curve is the nearest expiry ({model.frontExpiry}, {frontDays}d)
          {model.laterExpiries.length > 0 && `; later legs (${model.laterExpiries.join(', ')}) keep their time value`}
          {model.expectedMove ? ` · 1σ band uses ATM IV ${(model.expectedMove.iv * 100).toFixed(1)}%` : ''}
          {spotEstimated && <span className="text-amber-400"> · Index level is estimated from the futures price (live quote was rate-limited)</span>}
          {model.ivAssumed > 0 && <span className="text-amber-400"> · {model.ivAssumed} leg(s) priced on an assumed IV</span>}
        </span>
      }
    />
  );
}
