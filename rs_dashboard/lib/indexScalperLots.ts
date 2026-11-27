// Each contract's OWN lot size for /index-scalper. Pure, no React / fetch. Tested in indexScalperLots.test.ts.
//
// REAL shows the broker's whole book for the underlying, any expiry, and every lots <-> units conversion (brackets, the
// chip's + / -, reverse, an order's lots edit, one-cancels-other resizes, Kotak freeze slices, the lot counts drawn on
// the chips) must use the lot of THAT contract. The expiry on screen only gives its own strikes' lot: SENSEX is 20 to
// Dec 2026 and 25 from Jan 2027, so a Dec position sized with a Jan screen's 25 could send 100 units (5 Dec lots) for
// "4 lots" (review 2026-11-27). NIFTY (65 on every expiry) never showed it.

import { isMcx, type Underlying } from './indexScalperInstrument.ts';

export interface LotSources {
  /** Dhan security ids of the expiry on screen (the lookup's strike map) and that expiry's lot. */
  screenDhanIds: Iterable<string>;
  screenLot: number | null;
  /** Kotak trading symbols of the expiry on screen and Kotak's lot for it. */
  screenKotakSymbols?: Iterable<string>;
  kotakScreenLot?: number | null;
  /** Every Kotak symbol of the underlying -> its contract (symbol-lookup carries each contract's own `lotSize`). */
  kotakSymbols?: Record<string, { lotSize?: number }> | null;
  /** Dhan security id -> the master list's LOT_SIZE (api/index-scalper/lots), for contracts outside the screen expiry. */
  master?: Record<string, number> | null;
}

const ok = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0;

/** id (Dhan security id or Kotak trading symbol) -> units per lot. A contract's own figure (master list, Kotak symbol)
 *  wins over the screen expiry's; ids with no known lot are left out (callers refuse, never guess). */
export function buildLotMap(src: LotSources): Map<string, number> {
  const m = new Map<string, number>();
  if (ok(src.screenLot)) for (const id of src.screenDhanIds) m.set(String(id), src.screenLot);
  if (ok(src.kotakScreenLot)) for (const s of src.screenKotakSymbols ?? []) m.set(String(s), src.kotakScreenLot);
  for (const [sym, info] of Object.entries(src.kotakSymbols ?? {})) if (ok(info?.lotSize)) m.set(sym, info.lotSize);
  for (const [id, lot] of Object.entries(src.master ?? {})) if (ok(lot)) m.set(id, lot);
  return m;
}

/** Lot size to hand to qtyLots / lotUnits for one contract: MCX crude ignores it (barrels per lot are fixed by the
 *  instrument), so 1; an index contract its own lot, or null when unknown (the caller refuses). */
export function contractLot(underlying: Underlying, id: string | null | undefined, lots: Map<string, number>): number | null {
  if (isMcx(underlying)) return 1;
  if (!id) return null;
  return lots.get(String(id)) ?? null;
}

/** Numeric Dhan ids among `ids` whose lot is not known yet: what to ask api/index-scalper/lots for (sorted, deduped,
 *  at most 200), so an unchanged book asks nothing. */
export function missingLotIds(ids: Iterable<string>, lots: Map<string, number>, max = 200): string[] {
  const out = new Set<string>();
  for (const raw of ids) {
    const id = String(raw ?? '');
    if (/^\d{1,12}$/.test(id) && !lots.has(id)) out.add(id);
  }
  return [...out].sort().slice(0, max);
}
