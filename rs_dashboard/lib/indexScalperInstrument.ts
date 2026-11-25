// Pure instrument definitions and quantity/P&L unit converters for /index-scalper.
// No React, no fetch, no fs. Tested in indexScalperInstrument.test.ts.

import { MCX_LOT_MULTIPLIER } from './positionPnl.ts';

export type Underlying = 'NIFTY' | 'CRUDEOILM' | 'CRUDEOIL';

/** MCX crude (mini CRUDEOILM, 10 barrels a lot; full-size CRUDEOIL, 100): futures + options, quantities in lots on Dhan
 *  and barrels on Kotak. Everything that was "CRUDEOILM" on this page is "isMcx" now. */
export const isMcx = (u: Underlying): boolean => u === 'CRUDEOILM' || u === 'CRUDEOIL';

/** Barrels per lot of an MCX crude contract (MCX_LOT_MULTIPLIER, the repo's one source: 10 / 100); 1 elsewhere. */
export function mcxBarrels(u: Underlying): number {
  return isMcx(u) ? (MCX_LOT_MULTIPLIER[u] ?? (u === 'CRUDEOIL' ? 100 : 10)) : 1;
}

export interface InstrumentSpec {
  underlying: Underlying;
  displayName: string;
  dhanSegment: 'NSE_FNO' | 'MCX_COMM';
  kotakExchange: 'nse_fo' | 'mcx_fo';
  strikeStep: number;
  futTick: number;
  /** Option premium tick (NSE index options ₹0.05, MCX crude options ₹0.10). */
  optTick: number;
  candleSegment: 'IDX_I' | 'MCX_COMM';
  candleInstrument: 'INDEX' | 'FUTCOM';
  defaultLots: number;
  /** Per-order lot cap on this page (the client check; the server applies `orderSource`'s cap too). */
  maxLots: number;
  /** Order tag (correlationId prefix / source cap key): 'isx', or 'isxc' for CRUDEOIL so its own 5-lot cap applies on
   *  the server. Every tag starts with 'isx', which is how the page tells its own orders. */
  orderSource: 'isx' | 'isxc';
}

export const INSTRUMENTS: Record<Underlying, InstrumentSpec> = {
  NIFTY: {
    underlying: 'NIFTY',
    displayName: 'NIFTY 50',
    dhanSegment: 'NSE_FNO',
    kotakExchange: 'nse_fo',
    strikeStep: 50,
    futTick: 0.05,
    optTick: 0.05,
    candleSegment: 'IDX_I',
    candleInstrument: 'INDEX',
    defaultLots: 1,
    maxLots: 20,
    orderSource: 'isx',
  },
  CRUDEOILM: {
    underlying: 'CRUDEOILM',
    displayName: 'CRUDEOILM (MCX)',
    dhanSegment: 'MCX_COMM',
    kotakExchange: 'mcx_fo',
    strikeStep: 50,
    futTick: 1.0,
    optTick: 0.1,
    candleSegment: 'MCX_COMM',
    candleInstrument: 'FUTCOM',
    defaultLots: 1,
    maxLots: 20,
    orderSource: 'isx',
  },
  // Full-size crude: 100 barrels a lot (10x the mini), so a 5-lot per-order cap (the owner's choice, 2026-11-25).
  CRUDEOIL: {
    underlying: 'CRUDEOIL',
    displayName: 'CRUDEOIL (MCX)',
    dhanSegment: 'MCX_COMM',
    kotakExchange: 'mcx_fo',
    strikeStep: 50,
    futTick: 1.0,
    optTick: 0.1,
    candleSegment: 'MCX_COMM',
    candleInstrument: 'FUTCOM',
    defaultLots: 1,
    maxLots: 5,
    orderSource: 'isxc',
  },
};

/** Dhan order quantity:
 *  - NIFTY: lots * dhanLot (e.g. 1 lot * 65 = 65 units)
 *  - CRUDEOILM / CRUDEOIL: lots (Dhan order quantity for MCX is LOTS, master list LOT_SIZE is 1)
 */
export function dhanOrderQty(underlying: Underlying, lots: number, lotSize: number): number {
  if (lots <= 0) return 0;
  if (isMcx(underlying)) return lots;
  // No guessed lot size: 0 (refused by the caller) while the lookup has not answered.
  return lotSize > 0 ? lots * lotSize : 0;
}

/** Kotak order quantity:
 *  - NIFTY: lots * 65 units
 *  - CRUDEOILM: lots * 10 barrels, CRUDEOIL: lots * 100 (Kotak order quantity for MCX is absolute units)
 */
export function kotakOrderQty(underlying: Underlying, lots: number, lotSize: number): number {
  if (lots <= 0) return 0;
  if (isMcx(underlying)) return lots * mcxBarrels(underlying);
  return lotSize > 0 ? lots * lotSize : 0;
}

/** P&L multiplier (rupees per point per netQty unit):
 *  - Dhan: NIFTY is 1 (netQty in units). CRUDEOILM is 10 (netQty in lots, 10 bbl/lot).
 *  - Kotak: NIFTY is 1 (netQty in units). CRUDEOILM is 1 (netQty in barrels).
 *  - SIM: NIFTY is 1 (netQty in units). CRUDEOILM is 10 if sim qty is in lots, or 1 if barrels.
 *    We standardize SIM paper ledger on display units (NIFTY 65 units, CRUDEOILM 10 barrels, mult 1).
 */
export function pnlMultiplier(underlying: Underlying, broker: string): number {
  // Dhan MCX netQty is in lots: x barrels per lot (CRUDEOILM 10, CRUDEOIL 100).
  if (isMcx(underlying) && broker.toLowerCase() === 'dhan') return mcxBarrels(underlying);
  return 1;
}

/** Display units per lot for the UI and SIM paper ledger:
 *  - NIFTY: 65 units
 *  - CRUDEOILM: 10 barrels
 */
export function displayLotUnits(underlying: Underlying, lotSize?: number | null): number {
  if (isMcx(underlying)) return mcxBarrels(underlying);
  return lotSize && lotSize > 0 ? lotSize : 65;
}

/** Contract units per lot for ORDER SIZING: CRUDEOILM 10 barrels; NIFTY the lot size the lookup returned for the expiry
 *  on screen, null while it is unknown (no guessed lot size: the order is refused instead). */
export function lotUnits(underlying: Underlying, lotSize: number | null | undefined): number | null {
  if (isMcx(underlying)) return mcxBarrels(underlying);
  return lotSize && lotSize > 0 ? lotSize : null;
}

/** Contract units (NIFTY units, CRUDEOILM barrels) in a quantity counted in the broker's own unit. `qtyMult` is a
 *  leg's `mult` / pnlMultiplier: Dhan MCX quantities are LOTS (10), Kotak rows and SIM legs are units (1). */
export function qtyUnits(qty: number, qtyMult = 1): number {
  return Math.abs(qty) * (qtyMult > 0 ? qtyMult : 1);
}

/** Whole lots in a quantity counted in the broker's own unit, or null when the lot size is unknown or the quantity is
 *  not a whole number of lots. Never rounded: an exit / bracket / reverse sized off a rounded figure could send more
 *  than the position holds (a Kotak 2-lot crude position is netQty 20 barrels, i.e. 2 lots, never 20). */
export function qtyLots(underlying: Underlying, qty: number, qtyMult: number, lotSize: number | null | undefined): number | null {
  const per = lotUnits(underlying, lotSize);
  if (per === null) return null;
  const lots = qtyUnits(qty, qtyMult) / per;
  const whole = Math.round(lots);
  return whole >= 1 && Math.abs(lots - whole) < 1e-9 ? whole : null;
}

/** MCX crude (CRUDEOIL / CRUDEOILM, future or option): opening orders on /index-scalper are NRML (MARGIN) only. Kotak's
 *  RMS refuses a fresh MIS position on CRUDEOILM ("No Fresh trade allowed ... NON-SQROFF", seen 2026-11-24), and the
 *  user chose NRML for crude on every broker. Takes a symbol or underlying string. */
export function nrmlOnly(underlyingOrSymbol: string): boolean {
  return /^CRUDEOIL/i.test(underlyingOrSymbol.trim());
}

/** The product an OPENING order goes out under: MARGIN on MCX crude whatever was asked, the request elsewhere. An order
 *  that closes an existing leg must keep that leg's own product instead (a MARGIN close of an MIS leg would open a
 *  second position rather than reduce the first), so it never goes through this. */
export function openingProduct(underlying: string, requested: 'INTRADAY' | 'MARGIN'): 'INTRADAY' | 'MARGIN' {
  return nrmlOnly(underlying) ? 'MARGIN' : requested;
}
