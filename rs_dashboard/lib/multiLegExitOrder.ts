// Pure helpers for the Multi-Leg Focus LIMIT exit ticket (kept out of the component so they can be unit-tested).

/** Rounds a price to the contract's tick grid and strips float noise (100.15000000000001 -> 100.15). */
export function snapToTick(price: number, tick: number): number {
  if (!(price > 0) || !(tick > 0)) return 0;
  const snapped = Math.round(price / tick) * tick;
  return Number(snapped.toFixed(4).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, ''));
}

/**
 * Tick to snap a LIMIT exit to. Dhan: the master-list tick for that exact contract, or null when it is unknown.
 * Other brokers carry no contract tick here, so NSE/BSE use the standard 0.05; an MCX contract can be coarser
 * (e.g. 1.0), so with no known tick it returns null and the caller refuses rather than sends an off-grid price.
 */
export function exitLimitTick(opts: { masterTick: number | null; isMcx: boolean }): number | null {
  if (opts.masterTick && opts.masterTick > 0) return opts.masterTick;
  return opts.isMcx ? null : 0.05;
}
