'use client';

import { snapToTick, optionOrderTick } from '@/lib/multiLegExitOrder';

/**
 * Under a price box on an option order ticket: says when the typed price is off the contract's tick and what will be
 * sent instead. Every order path snaps the price before it leaves (resolveOrderRequest, exitOneLeg), so the price
 * inputs use step="any" — with step="0.05" the browser silently refused the form behind its own popup.
 */
export default function TickSnapNote({ value, underlying }: { value: number; underlying?: string }) {
  const tick = optionOrderTick(underlying);
  const sent = snapToTick(value, tick);
  if (!(value > 0) || !(sent > 0) || Math.abs(sent - value) < 1e-9) return null;
  return (
    <p className="text-[10px] text-amber-400 mt-1" role="status">
      Off the ₹{tick.toFixed(2)} tick: sent as ₹{sent.toFixed(2)}
    </p>
  );
}
