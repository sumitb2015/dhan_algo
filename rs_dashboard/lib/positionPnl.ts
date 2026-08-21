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

/** Dhan reports MCX position P&L the same way it reports MCX quantity: in lots, with the
 *  barrels-per-lot multiplier left off. A single short CRUDEOIL option at 175.55 marked at
 *  173.50 comes back as `unrealizedProfit: 2.05`, not 205 (and `realizedProfit` behaves the
 *  same — see the flat-position recompute in Scalper/AdvancedScalper, which already multiplies).
 *  Rescale both fields before anything downstream reads them.
 *
 *  A no-op for every non-MCX position (mult === 1), so callers can apply it unconditionally. */
export function scaleBrokerPnl<T extends Record<string, unknown>>(
  pos: T,
  mult: number = contractMultiplier(pos),
): T {
  if (mult === 1) return pos;
  const realized = Number(pos.realizedProfit);
  const unrealized = Number(pos.unrealizedProfit);
  return {
    ...pos,
    realizedProfit: Number.isFinite(realized) ? realized * mult : pos.realizedProfit,
    unrealizedProfit: Number.isFinite(unrealized) ? unrealized * mult : pos.unrealizedProfit,
  };
}

/** True when a position/trade row belongs to an MCX commodity contract.
 *
 *  Segment first, then the trading-symbol root: only Dhan rows carry a segment at all
 *  (`MCX_COMM`), and Kotak/Zerodha *trade* rows are normalized down to five fields with no
 *  exchange on them (see lib/kotakShape.ts) — so a Kotak crude fill is identifiable only by
 *  its symbol. Reuses MCX_LOT_MULTIPLIER's keys so the commodity list stays in one place.
 *  `startsWith` rather than an exact match: Dhan writes CRUDEOILM-Sep2026-4150-CE while
 *  Kotak writes CRUDEOILM17SEP264150CE, and for a yes/no segment test the CRUDEOIL prefix
 *  of CRUDEOILM is harmless — both are MCX. */
export function isMcxRow(row: Record<string, unknown>): boolean {
  const segment = String(row.exchangeSegment ?? row.exchange ?? '').toUpperCase();
  if (segment.startsWith('MCX')) return true;
  const symbol = String(row.tradingSymbol ?? row.customSymbol ?? '').toUpperCase();
  return Object.keys(MCX_LOT_MULTIPLIER).some(root => symbol.startsWith(root));
}
