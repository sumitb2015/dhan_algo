// Dhan's /positions endpoint reports buyQty/sellQty/netQty as number of LOTS (not physical
// underlying units) for MCX commodity contracts — confirmed empirically: a closed CRUDEOIL
// position with buyAvg 234.10 / sellAvg 238.10 / buyQty=sellQty=1 has a true realized P&L of
// ~400 (234.10->238.10 on 100 barrels), i.e. qty=1 means "1 lot", not "1 barrel". This is
// unlike NSE_FNO/BSE_FNO, where those quantity fields are already fully-multiplied unit counts,
// and unlike Dhan's own instrument master (master_list.csv LOT_SIZE), which encodes 1 for MCX
// contracts because MCX order quantity is itself expressed in lots (see CrudeOilOptions.tsx).
// Dhan's positions API also returns a "multiplier" field, but per their docs it's scoped to
// currency F&O only — it does not carry the MCX barrels-per-lot figure, so there is no way to
// derive this from the API response and it must be hardcoded per underlying.
export const MCX_LOT_MULTIPLIER: Record<string, number> = {
  CRUDEOIL: 100,
  CRUDEOILM: 10,
};

/** Contract multiplier to apply to (qty * price) math when recomputing P&L client-side.
 *  1 for every non-MCX position, and for any MCX underlying not in the map above (safer to
 *  under-multiply than to guess a wrong multiplier). */
export function contractMultiplier(pos: Record<string, unknown>): number {
  const segment = String(pos.exchangeSegment ?? pos.exchange ?? '');
  if (segment !== 'MCX_COMM') return 1;

  const tradingSymbol = String(pos.tradingSymbol ?? pos.customSymbol ?? '');
  const underlying = tradingSymbol.split('-')[0]?.toUpperCase() ?? '';
  return MCX_LOT_MULTIPLIER[underlying] ?? 1;
}
