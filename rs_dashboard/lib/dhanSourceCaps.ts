import { FTS_DHAN_MAX_ORDER_QTY } from './focusToolUnderlyings.ts';

// The per-source sanity caps of lib/dhanPlaceOrder.ts, kept in a pure module so they are unit-tested without ever reaching
// the order API. A backstop against a UI bug, not an auth boundary: callers that send no source are uncapped. Rejected,
// never clamped.

/** 'ts' = Triple Straddle: 50 lots (its lot cap) x 75, the largest index lot seen (NIFTY's
 *  previous size; today 65 -> 3250), so the cap stays tight yet survives a lot-size change. */
export const SOURCE_QTY_CAPS: Record<string, number> = {
  ts: 3750,
  // 'bs' = Bearish Strikes: same bound as 'ts' (50 lots x 75 units).
  bs: 3750,
  // 'bds' = Breakdown Scalper: lots are capped at 20 on the ledger, so 20 x 75 would be 1500; same bound as 'ts'.
  bds: 3750,
  // 'alab' = Algo Lab entries (lib/algoLab/configSchema.ts MAX_LOTS_PER_TRADE = 20, also checked by its ledger).
  alab: 3750,
  // 'fts' = Focus Tool: every order (closes too) is sliced under this cap and the exchange freeze on the page.
  fts: FTS_DHAN_MAX_ORDER_QTY,
  // 'pl' = Price Ladder: MAX_LADDER_LOTS (20) x 75 (the largest index lot seen), matching Kotak's 20-lot 'pl' cap.
  pl: 1500,
  // 'fm' = Fresh Money board: FM_MAX_LOTS_PER_ORDER (20) x 75, the largest index lot seen.
  fm: 1500,
  // 'isx' = Index Scalper (/index-scalper): MAX_LOTS (20, lib/indexScalperPositions.ts) x 75, the largest index lot seen.
  isx: 1500,
};

/** The same backstop where Dhan's order quantity is LOTS (MCX_COMM), not units: 1500 there would mean 1500 lots. */
export const SOURCE_QTY_CAPS_MCX: Record<string, number> = {
  // 'pl' = Price Ladder: MAX_LADDER_LOTS.
  pl: 20,
  // 'fm' = Fresh Money board: FM_MAX_LOTS_PER_ORDER (20). Without it the NSE 1500 would apply: 1500 MCX lots.
  fm: 20,
  // 'isx' = Index Scalper (/index-scalper): MAX_LOTS (20) on MCX. Without it the NSE 1500 would apply: 1500 MCX lots.
  isx: 20,
  // 'orba' = Signal Orb (CRUDEOIL / CRUDEOILM futures and options) is deliberately uncapped (the user removed its lot cap on 2026-11-20).
  // 'gbx' = Gearbox Drive (CRUDEOIL / CRUDEOILM options): MAX_REAL_LOTS 1 until it has run live
  gbx: 1,
};

/** The per-order quantity cap for `source` on `exchangeSegment` (MCX_COMM in lots, else units), or undefined (uncapped). */
export function dhanSourceQtyCap(source: string | undefined, exchangeSegment: string): number | undefined {
  if (!source) return undefined;
  return String(exchangeSegment).toUpperCase() === 'MCX_COMM' ? (SOURCE_QTY_CAPS_MCX[source] ?? SOURCE_QTY_CAPS[source])
    : SOURCE_QTY_CAPS[source];
}

/** Why `qty` must be refused under its source's per-order cap, or null. */
export function dhanSourceCapError(qty: number, source: string | undefined, exchangeSegment: string): string | null {
  const cap = dhanSourceQtyCap(source, exchangeSegment);
  return cap !== undefined && qty > cap ? `Quantity ${qty} exceeds the ${source} per-order cap of ${cap}` : null;
}
