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
export function exitLimitTick(opts: { masterTick: number | null; isMcx: boolean; mcxUnderlying?: string }): number | null {
  if (opts.masterTick && opts.masterTick > 0) return opts.masterTick;
  // Kotak carries no contract tick, but a crude OPTION's grid is fixed by its underlying (from the Dhan master:
  // CRUDEOIL 0.10, CRUDEOILM 0.05). Any other MCX contract stays unknown and is refused.
  if (opts.isMcx && opts.mcxUnderlying) return MCX_OPTION_TICK[opts.mcxUnderlying] ?? null;
  return opts.isMcx ? null : 0.05;
}

const MCX_OPTION_TICK: Record<string, number> = { CRUDEOIL: 0.1, CRUDEOILM: 0.05 };

/** Price grid of an underlying's OPTIONS for an order we price ourselves (stop trigger / limit): CRUDEOIL 0.10, everything else 0.05. */
export function optionOrderTick(underlying: string | undefined): number {
  return MCX_OPTION_TICK[String(underlying ?? '').toUpperCase()] ?? 0.05;
}
